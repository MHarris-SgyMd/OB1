# db — the core schema, as migrations

Phase 1 of the Supabase migration. The Open Brain core schema currently exists as
**prose inside a markdown guide** (`docs/01-getting-started.md`, steps 2.2–2.6),
where nothing can apply it, version it, or check it. This directory is that DDL
made executable.

Nothing here is Supabase-specific. It targets any Postgres 15+ with pgvector 0.8.0 or
later — migration 014 declares HNSW settings that older pgvector rejects.

## Prerequisites

- [Bun](https://bun.sh) 1.4+
- To apply against a real database: Postgres 15+ with the `vector` extension at 0.8.0+
  available (RDS, Aurora, Neon, Cloud SQL, Timescale, or self-hosted). If the
  provider pre-installs pgvector into a schema off the connection's `search_path`
  (Supabase uses `extensions`), the runner adds it to its own session so the
  migrations apply, and preflight names the persistent fix for the server — see
  the `test-search-path.ts` note under Testing. The runner also puts `public`
  first on its own session's path, the rest after it, so the brain is built in
  `public` whatever the role's or the connection string's path puts first. It
  refuses, changing nothing, where the path reaches a brain's ledger in another
  schema and `public` holds no brain, or `public` cannot come first
  (test-upgrade [23]).
- To run `test-schema.ts`: nothing else. It uses PGlite, which is real PostgreSQL
  17 compiled to WASM — no daemon, no container.
- To run `test-live.ts`: podman or docker, for a throwaway container
- To run `test-upgrade.ts`, `bench-trgm.ts` or `bench-keyword.ts`: the same, and
  for the benchmarks a few minutes — they build tables up to 100,000 rows;
  `test-bench-reuse.ts` the same and about three minutes (nine bench runs at
  150,000 rows).
  `bench-hnsw.ts` at a million rows and up wants most of an hour and a container with
  gigabytes of shared memory; its section below says how much

## Steps

### 1. Install

```bash
cd db && bun install
```

### 2. Check what would run

```bash
bun migrate.ts --url postgres://user:pass@host:5432/dbname --dry-run
```

### 3. Apply

```bash
bun migrate.ts --url postgres://user:pass@host:5432/dbname
# or: DATABASE_URL=... bun migrate.ts
```

Each migration runs in its own transaction and is recorded in `schema_migrations`,
so re-running is a no-op and a failure part-way resumes rather than restarting.

### 4. Adopting an existing database

If your `thoughts` table was created by hand from the guide, you have two options.
Every migration is individually idempotent, so you can simply run them — nothing
will be duplicated. Or record them as applied without executing:

```bash
bun migrate.ts --url ... --baseline
```

`--baseline` is all-or-nothing: it marks **every** migration not already in the
ledger as applied, without running any of them. That is what adoption wants, and
it is the wrong tool for recording a single migration you applied by hand — on a
database sitting at 009 it would mark 010 applied too, and the agent registry
would never be created. For one migration, insert the one `schema_migrations`
row; `--dry-run` prints the `sha256` to use beside each name.

### 5. Re-applying what the ledger already records

A database adopted with `--baseline` can say 030 in its ledger while its
functions are the guide's: a plain run skips every recorded file, and
`reembed.ts` and preflight refuse or warn on the body they find and name this:

```bash
bun migrate.ts --url ... --reapply
```

`--reapply` re-runs **every migration** — recorded or pending — in order, in
**one transaction** with a 10 s lock timeout; recorded rows stay as they are,
pending ones are recorded in the same transaction. Every file rather than a
range from the one a symptom names: a later migration may redefine what an
earlier one created (022 and 025 redefine 021's `upsert_thought`; 020 drops a
form 014 recreates), and a file's body may reference what only an earlier file
installs (025's `upsert_thought` reads a column 021 adds, resolved when the
function first *runs*, not when it is created) — so a start point is safe only
when everything before it is really present, which nothing can check cheaply.
Pending files in the same ordered transaction, because a ledger hole (a row
deleted or misspelt by hand) would otherwise have an earlier-numbered file apply
*after* the re-run, over the later definitions it had just restored. Every file
is idempotent, so the run restores the latest definition of everything. One
transaction, so a failure part-way — a lock not granted within 10 s included —
rolls back and the schema is as it was. `--dry-run` says what would re-run and
judges the pgvector floor as the run does.

**Refused before anything runs, and `--dry-run` says "would refuse" for the
same:** a recorded file that changed since it was applied; the pgvector floor; a
shell whose `OB1_EMBEDDING_DIM` differs from the column's width (006 would
refuse it inside the transaction); a shell whose `OB1_EMBEDDING_MODEL` differs
from what `ob1_config` records (006 would re-record it — run from a shell
configured as the brain is, or change the record on purpose with `reembed.ts
--switch-model`; `chunk_context` is re-recorded from the shell, which by 013's
own definition is the update). The checks read the catalog and `ob1_config`
under a 10 s lock timeout of their own. A plain run on the baselined brain,
where 030 is pending, fails at 030 with what is missing and this command,
rather than a bare "does not exist"; preflight's `edit signature`, `delete
signature`, `vector models` and `atomic capture` remedies name it where the
ledger records the migration they find absent.

**021's evidence backfill runs with the operator's acceptances out of its
sight** — on the re-run, and on a plain run where 021 is pending (a brain built
by hand through 021 and adopted by "just run them", or a ledger hole). 021
labels an unlabelled thought from its latest succeeded claim row under a key
naming a model, and the file is hashed and applied as written, from before a
succeeded row could be the operator's *acceptance* of a failure (`reembed.ts
--accept-failed`) — a thought that kept the vector it had, by decision not at
that key's model. 030 takes such a label back where it can tell it from the
server's own and labels with accepted rows excluded, but 030 cannot know which
labels 021's block wrote a moment ago; the migrator need not know either.
Before 021 runs it creates a temp *view* named `thought_work_claims` over the
real table without the accepted rows — no copy, so the block reads the rows as
they stand when it runs — and since an unqualified name resolves in `pg_temp`
before any schema on the search path, 021's block reads the view and labels
from the latest row that is not an acceptance, or not at all — 030's rule by
021's own text, nothing wrong ever written, the acceptance standing and no
claim row touched. The view is dropped right after the file, in the same
transaction, so 022 onward read the real table; a search path that lists
`pg_temp` — which is searched first for tables exactly when it is *not* listed
— has it removed for the transaction, and that the name resolves to the view
is checked before the file runs; a temp relation of that name already on the
connection refuses the file. The run says beside 021's line how many thoughts
the block labelled — zero included, read from the transaction's own statistics
(not counted where `track_counts` is off). A label 021's block wrote from an acceptance on an earlier
run, or a paste of the body left, is 030's to take back at its own place — the
re-run reaches it. Judged before anything runs, in both modes, whenever 021
will run: the role may create a temp table (`GRANT TEMPORARY ON DATABASE`
otherwise; 023's call needs one too). A file not named `NNN_name.sql`, or two
sharing a number, is refused at load, and by the fork checker on every push; a
set without 021 is refused at load, since the file is named whole. Every
refusal is collected and reported together, the re-run's included.
Until SMD-1421 the migrator instead *refused* the run on the rows 021 would
label and 030 would leave (an acceptance under a suffixed key; a thought
written since the row's enqueue; with 030 recorded and skipped, any
acceptance) and printed a way back that spent the acceptance — the refusal
030's own header still describes, that file being hashed. `--baseline` runs no
SQL and shadows nothing.

**Stop the server and any re-embed or extraction worker first, and connect
directly, not through a transaction-mode pooler:** the migrator sets session
state (the lock timeout, the pgvector search path) and takes locks across
statements. It sets a 10 s lock timeout for everything it does — for the
session, and again inside every transaction — so a held lock fails the run
rather than freezing it and every reader behind it. 001 and 003
take ACCESS EXCLUSIVE locks on `thoughts`; 011 builds the trigram index if
`OB1_TRGM_INDEX` is on and the index is absent; 023's and 050's backfill calls
run again and take `thoughts` EXCLUSIVE (`OB1_BACKFILL_LIMIT` bounds each, as on
a first apply; they write nothing when no row is waiting); 055's locks the audit
rows it fills and then builds its partial index over `thought_audit` (SHARE,
tens of milliseconds); 025 re-validates its constraints over the table. 021's
evidence backfill runs as written, the acceptances out of its sight (above);
030, reached after it in the same transaction, finds nothing of 021's to take
back and corrects the own-key labels an earlier paste of the body left
(SMD-1193, SMD-1421).

### 6. Plugin migrations (SMD-2310)

A plugin (`plugins/<name>/`) keeps its tables in `plugins/<name>/migrations/`,
named `NNN_name.sql` under the core's rule. The plugins the brain runs are
named in `OB1_PLUGINS`, which the compose migrator reads from `deploy/.env` as
the servers do. A plain run applies their migrations **after the core's**, and
only when the core's are clean:

- **The login role.** Every plugin's SQL runs on a connection logged in as
  `ob1_plugins`: LOGIN, NOINHERIT, no superuser, holding `SET` on each plugin's
  role and nothing on the core. A run makes it with `OB1_PLUGIN_DB_PASSWORD`
  when it is missing, and never changes an existing role's password: the
  servers log in with the one it was made with. A run that would apply a
  plugin's file, or make the role, without the password is refused before
  anything runs (exit 2); one with nothing of the plugins' to do asks for it
  not at all.
- **The role and the schema.** Each plugin gets its own Postgres role,
  `ob1_plugin_<name>` (NOLOGIN), and a schema it owns, `plugin_<name>` (a
  hyphen in the name reads as `_`).
  - **When they are made.** Any run that names the plugin and finds the role,
    the schema or the login role's `SET` on it missing makes them, even with
    nothing pending. A run with all three in place and nothing pending asks
    the migrator no privilege. None is ever dropped.
  - **A migrator that is no superuser** takes `SET` on a role it made
    (`WITH SET TRUE, INHERIT FALSE` on PG 16), so it may hand the role its
    schema.
  - **A restored brain.** A dump restored without its owners brings the
    schema back owned by the restoring role: with `--no-owner`, as a tier's
    refresh restores (`tier.ts`), or into a cluster without the plugin's role
    (roles are the cluster's, not the dump's), where the dump's
    `ALTER … OWNER` fails. A run that names the plugin makes the role and
    hands it back the schema and every table, view, sequence, routine and
    type in it that another role owns (`db/config.mjs`'s
    `pluginForeignOwned`). An `ALTER … OWNER` needs the migrator to own the
    object, or be a superuser.
- **How a file runs.** Each file runs in its own transaction on the login
  connection, under `SET LOCAL ROLE ob1_plugin_<name>` with the plugin's
  schema first on the path. A table the plugin creates is its own, named bare.
  Neither role holds anything on the core's tables, so a migration that reads
  or writes one is refused by Postgres (`permission denied`). That holds even
  for SQL that undoes the plugin's role (`END;`, `RESET ROLE`): it lands on
  `ob1_plugins`, not on the migrator. From there it could `SET ROLE` to
  another plugin's role, but not reach the core. After each file the login
  connection's temp tables are discarded.
- **The ledger.** Each applied file is recorded in `plugin_migrations (plugin,
  name, sha256, applied_at)`, a ledger of its own beside `schema_migrations`,
  by the migrator's own connection once the file has committed. Nothing that
  reads the core's ledger sees it. If that write fails after the file
  committed, the file runs again on the next run, which is why a plugin's
  migration says `IF NOT EXISTS`. An edited file is a drift and exits 1, as a
  core file does.
- **A plugin not named** is not read. Its schema, tables and ledger rows stay
  as they are.

`--dry-run` lists each plugin's pending files under its own heading: the sha,
and the role and schema each would run as. It makes nothing. `--baseline` and
`--reapply` leave plugins to a plain run, and say so. A name that is no plugin,
or one given twice, is refused before anything runs (exit 2).

```bash
OB1_PLUGINS=example OB1_PLUGIN_DB_PASSWORD=… bun migrate.ts --url "$DATABASE_URL" --dry-run
```

The migrating role must be able to `CREATE ROLE` and `CREATE SCHEMA`, and to
grant a plugin's role to `ob1_plugins`; the compose stack's `postgres` can.

**Preflight.** The servers' plugin pools log in as `ob1_plugins` too, one small
pool per plugin, so what a plugin's SQL leaves on a session never meets a core
query. A temp table, for one, is searched before any schema. Preflight's
`plugin tables` row checks:

- that `ob1_plugins` exists, can log in with the server's
  `OB1_PLUGIN_DB_PASSWORD` (and is who the connection is: a database URL with
  no host cannot have its user replaced, and is refused), is no superuser and
  NOINHERIT, is a member of no role but the plugins' and inherits none by a
  grant's own option, and holds no `SELECT`, `INSERT`, `UPDATE`, `DELETE`
  or `TRUNCATE` on a core table or view;
- that it holds `SET` on each plugin's role;
- the plugin's role and schema, and that the schema and every object in it
  are the plugin role's, by the migrator's own list;
- every file recorded at its sha.

The server's own role needs no membership. What holds hostile plugin code is
curation: a plugin's TypeScript runs in the server's process. The database's
roles hold its SQL whatever that SQL does. Check 31 of the consistency checker
guards against the accident (`plugins/README.md`).

## Expected outcome

`bun test-schema.ts` prints `2712 assertions: 2712 passed, 0 failed` and `PASS`.
Against a real database, `bun migrate.ts` reports eighty-seven (87) migrations applied, and
`\d thoughts` shows eight columns and seven indexes — six of our own plus the
primary key, which `\d` also lists. Six with `OB1_TRGM_INDEX=off`. `\d
thought_chunks` shows five columns since 013 added `context`.

## The migrations

| File | What | Source |
| --- | --- | --- |
| `001_core_schema.sql` | `thoughts` table, three indexes, `updated_at` trigger | Guide step 2.2 |
| `002_match_thoughts.sql` | Semantic search RPC | Guide step 2.3 |
| `003_content_fingerprint.sql` | Fingerprint column, unique partial index, `upsert_thought` | Guide step 2.6 |
| `004_upsert_thought_with_embedding.sql` | 3-arg atomic-capture overload | This fork |
| `005_reject_non_object_payload.sql` | Reject a non-object `p_payload` instead of silently storing `{}` | This fork |
| `006_embedding_config.sql` | Record the embedding contract so preflight can catch a later disagreement | This fork |
| `007_thought_chunks.sql` | `thought_chunks` table, 4-arg capture overload, `match_thoughts` over both tables. Since 022 a re-capture with a vector through the 3-arg form keeps the chunk rows only while the row's label vouches for them | This fork |
| `008_thought_audit.sql` | Append-only `thought_audit`, enforced by trigger; audit written inside the mutating transaction | Ported from `schemas/thought-audit` |
| `009_update_delete_thought.sql` | `update_thought` / `delete_thought`; recomputes the fingerprint and replaces chunks, atomic `if_unchanged_since` | Ported from `integrations/*-thought-mcp` |
| `010_agent_identity.sql` | `ob1_agents` / `ob1_agent_keys`, `resolve_agent`, `revoke_agent_key`; `thought_audit.canonical_agent_id` | Ported from `schemas/per-agent-identity` |
| `011_text_search_trgm.sql` | `pg_trgm`, plus a trigram GIN index on `thoughts.content` for leading-wildcard `ILIKE`. On by default since 012 gave it a caller; `OB1_TRGM_INDEX=off` omits it | Ported from `schemas/text-search-trgm` |
| `012_search_thoughts_keyword.sql` | `search_thoughts_keyword` — exact substring search with occurrence counts, true `total_count` and stable paging | This fork |
| `013_chunk_context.sql` | `thought_chunks.context` for a situating blurb, carried through both chunk writers. Off by default and measured off — see below | This fork, from Anthropic's Contextual Retrieval |
| `014_filtered_match_thoughts.sql` | `match_thoughts` applies the metadata filter inside the HNSW scan (iterative scan, pgvector 0.8+) instead of after the candidate LIMIT, answers a filter matching at most ~1,000 thoughts exactly with no index walk at all, and honours `match_count` above the default up to a ceiling of 500. The walk's two bounds (`hnsw.max_scan_tuples = 100000`, `hnsw.scan_mem_multiplier = 8`) are seeded once at database level and never overwritten, so `ALTER DATABASE … SET` is the tuning knob and survives every redefinition. Requires pgvector 0.8.0; the migrator refuses 014 up front on an older library. The header's sizing of those bounds is arithmetic; SMD-1018 measured them at a million and ten million rows (FORK.md change 28, "At scale") and found the planner's GIN-or-HNSW choice, not the bounds, is what decides a filtered call there | This fork; upstream #417 |
| `015_thought_work_claims.sql` | `thought_work_claims` — one lease per (thought, job key) so parallel workers divide a bulk pass without overlap. `enqueue_thoughts` builds the pool, `claim_thoughts` hands out batches with `FOR UPDATE SKIP LOCKED` under a TTL that `renew_claims` (031) moves forward on a heartbeat, expired leases return to the pool (and are marked failed after three), `release_thought` / `release_claims_for_worker` finish or hand back. Terminal rows are the record of the pass, so a re-run does only what is new. `reembed.ts` is the first consumer — see below | Ported from `schemas/thought-work-claims` |
| `016_entity_extraction.sql` | `ob1_entities`, `thought_entities` (mentions) and `ob1_entity_edges`, where every edge row carries the thought that evidenced it; `record_thought_entities` writes one thought's extraction atomically and idempotently; `normalize_entity_name` is the resolution rule; `merge_entities` and `prune_orphan_entities` are the human steps; a trigger on `thoughts` enqueues new and edited content into `thought_work_claims` once `extract-entities.ts` has set the key. Costs nothing until that worker is run — see below | Rewritten from `schemas/entity-extraction` |
| `017_search_thoughts_hybrid.sql` | `search_thoughts_hybrid` — `match_thoughts` and `search_thoughts_keyword` fused: reciprocal rank on the vector arm, presence per matched literal on the keyword arm, each hit's own similarity as the tiebreak; a query with no identifier returns exactly what `match_thoughts` returns. `extract_search_needles` is the one rule for which literals the keyword arm is asked for (quoted spans, identifier-shaped tokens). Fixed top-N, no paging. `search` and `search_thoughts` call it; the header carries the measurement (`evals/eval-hybrid.ts`) | This fork |
| `018_update_thought_unchanged_content.sql` | `update_thought` redefined: an edit whose text normalises to what the row already holds is never `DUPLICATE_CONTENT` — it reports `duplicate_of` when another row carries that fingerprint (a pair from before 003's backfill-less fingerprint) and leaves this row's fingerprint NULL, so the partial unique index is never violated; edits to one fingerprint are serialised on an advisory lock (READ COMMITTED), which also turns 009's constraint-violation race for two concurrent edits into `DUPLICATE_CONTENT` — captures through `upsert_thought` were not covered until 033 took the same lock. 008's actor, 009's guard and 013's context carried forward; 016's `content_fingerprint_of` replaces the third inline copy of the hash rule. `reembed.ts` requires it — see below | This fork |
| `019_match_thoughts_plan_and_rows.sql` | `match_thoughts` redefined with `SET enable_seqscan = off` beside 014's scan mode, and `ROWS 10`; `search_thoughts_keyword` redefined with `ROWS 25`; both bodies carried verbatim. At the shipped width a vector is TOASTed and the planner's seq-scan estimate never counts the detoast reads, so wherever the heap is small — every brain up to some tens of thousands of thoughts, and the ceiling at every size — it chose a sequential scan of the chunk table and, above the default count, of `thoughts`: five to twenty times the buffers the index reads (upstream #469, measured by `bench-plan.ts` at 1,000 to 100,000 rows). The `ROWS` clauses give every composing query the estimate 017's JIT finding was priced without; they live in the defining statements because `CREATE OR REPLACE` resets them | This fork |
| `020_match_thoughts_recency.sql` | `match_thoughts(…, recency_weight float DEFAULT 0, half_life_days float DEFAULT 90)`: the rows are ordered by a new `score` column — `recency_score()`, `similarity · (1 − w) + 0.5^(age_days / half_life) · w`, equal to `similarity` at weight 0, then by id — computed over the candidates the HNSW scan already produced, with the threshold still on the raw similarity and the candidate window four times wider under a weight. The 4-argument function is **dropped**, not overloaded (a second form beside it would make every 4-argument call `function is not unique`); `search_thoughts_hybrid` likewise, redefined to pass the weight through and rank its vector arm on `score`. 019's clauses carried, and each old function's ACL replayed across the DROP. Measured on the corpus (`evals/eval-recency.ts`): a weight lowers MRR on a relevance task at every setting, so the default stays 0 and the ChatGPT `search` sends 0 | This fork; upstream `schemas/recency-boosted-match-thoughts` for the formula |
| `021_embedding_model_per_row.sql` | `thoughts.embedding_model` — the model that produced each vector, written by the same statement as the vector (the label follows the vector; NULL is unknown, and the only backfill is from evidence — a row a finished pass wrote and nothing wrote since is labelled from its claim). `upsert_thought` reads it from the payload envelope beside the actor; `update_thought` takes it as an eighth parameter, the 7-argument form **dropped** first (an overload beside it would make every 7-argument call `function is not unique`), the old ACL replayed. `reembed.ts` builds its pool from the rows not at the target under the model's own key (every thought under a `--job` backfill key) and returns a finished row whose thought moved; preflight's `vector models` reads the corpus by label and `edit signature` checks the form — see below | This fork |
| `022_capture_replaces_chunks.sql` | The 3-arg `upsert_thought` redefined (021's body; the row's label read and the row locked before the write, one block added): a re-capture's chunk rows stay while the label vouches for them — the row's vector labelled with a model and the arriving vector labelled with the same one — and go otherwise (a label unknown on either side, or another model); no vector arriving keeps them. Until then a thought captured with windows and re-captured through that form — the path every chunkless capture takes: both stores, the Edge Function server, any PostgREST caller — kept the windows of a vector it no longer had, and since 021 under a label that said it was at the new model. No column, no signature change, no backfill (a stale window cannot be told from a live one; a `--job` pass regenerates them — and a brain upgraded through 021 without a finished pass should run one first: an unlabelled row's windows go on its first chunkless re-capture, since nothing vouches for them). The DELETE runs as the calling role, which needs DELETE on `thought_chunks`; the row is locked `FOR NO KEY UPDATE`, ordered against `update_thought` and not against the foreign keys' `KEY SHARE`. The body carries the `ob1:vector-replaces-chunks` sentinel, which preflight's `atomic capture` warns without — 021 re-applied by hand puts 021's body back — and `write privileges` refuses a role missing any of the capture path's table privileges (`thought_chunks` DELETE among them; see [Grants for a capturing role](#grants-for-a-capturing-role)), printing the GRANT | This fork |
| `023_content_fingerprint_backfill.sql` | 003's missing half. `backfill_content_fingerprints(p_limit integer DEFAULT NULL)`, called once by the file: every thought without a fingerprint whose normalised text no row holds takes it, and of each group sharing one text the oldest (`created_at`, then id) takes it while the rest stay NULL, the state 018 leaves after a pass — the pairs list marks the row holding the key; a row whose key another row holds — the same text under a fingerprint, or a stale key — stays NULL, and no existing key is touched. Until then a capture of a legacy row's text inserted a second row (`ON CONFLICT` cannot see a NULL), silently, on every brain from before 003 or loaded around `upsert_thought`. The function scans before the lock, then locks `thoughts` `IN EXCLUSIVE MODE` for its transaction (writers and `update_thought`'s row lock wait, readers do not; `lock_timeout` 10 s; READ COMMITTED, as 018's lock) and re-checks the rows it found by index — still NULL, still the text that was hashed, the key still free — which is what lets a capture waiting on it merge instead of doubling and an edit be told `duplicate_of` instead of raising 23505; stop both 015 consumers first (a re-embed pass, an entity-extraction worker), since every writer into a table referencing `thoughts` waits on the lock and would wait out its lease; it holds the `updated_at` trigger (the fingerprint is not an edit) and writes no audit row. The UPDATE is not HOT — the column is indexed — so every row written is entered into every index, the HNSW one included; measured, see the header. It returns the rows it found waiting, so a loop until 0 is exact; `p_limit` (at least 1) bounds a call — each call its own transaction, since the lock is held to commit — and the file's own call takes `{{BACKFILL_LIMIT}}`, NULL unless `OB1_BACKFILL_LIMIT` is in the migrator's environment at that invocation (validated in `config.mjs`, forwarded by the compose migrate service), which a brain with millions of legacy rows sets to take one batch at upgrade and the rest by hand. It adds `ob1_fp_backfill_idx`, a partial expression index over exactly the rows without a key, so the scan is an ordered walk that a batch's LIMIT stops early and preflight's probe on every start reads the index rather than the heap; on a fingerprinted brain it is empty. Run again after a load that inserted into `thoughts` directly, which preflight's `fingerprint backfill` says when | This fork |

Migrations 024 onward are described in `FORK.md`, one numbered change each
(024 change 45, 025 change 46, 026 change 47, 027 change 48, 028 change 49,
029 change 54, 030 change 56, 031 change 57, 032 change 60, 033 change 63,
034 change 65, 035 change 66, 036 change 68, 037 change 70, 038 change 80, 039 change 81,
040 change 91, 041 change 94, 042 change 95, 043 change 98, 044 SMD-1804,
045 SMD-1490, 046 SMD-1730, 047 SMD-1492, 048 SMD-1804, 049 SMD-1298, 050 SMD-1726,
051 SMD-1804, 052 SMD-1296, 053 SMD-1867, 054 SMD-2090, 055 SMD-2115, 056 SMD-1935, 057 SMD-1804,
058 SMD-2074, 059 SMD-2255, 060 SMD-2116, 061 SMD-1731, 062 SMD-1804, 063 SMD-1732, 064 SMD-1812, 065 SMD-2300, 066 SMD-2292, 067 SMD-2297,
068 SMD-2256, 069 SMD-2318, 070 SMD-2313, 071 SMD-2267, 072 SMD-1804, 073 SMD-1724, 074 SMD-1724, 075 SMD-1724, 076 SMD-1804, 077 SMD-2271, 078 SMD-2284, 079 SMD-2448, 080 SMD-2539, 081 SMD-1804, 082 SMD-2638, 083 SMD-1804, 084 SMD-1873, 085 SMD-2664, 086 SMD-2744, 087 SMD-2681).

Migration 044 records `schema_version` in `ob1_config` — the version the brain was
migrated under (`MAJOR.MINOR.PATCH+upstream.<sha>`; 044 wrote the pre-first-release
baseline `0.0.0+upstream.9543c29`), and every release cut appends the migration
that writes its version as the last file of the range it freezes: 048 writes
`1.0.0+upstream.9543c29`, the first release (`001..048`), and 051 writes
`1.1.0+upstream.9543c29`, the second (`049..051`), and 057 writes
`1.2.0+upstream.9543c29`, the third (`052..057`), and 062 writes
`1.3.0+upstream.9543c29`, the fourth (`058..062`), and 072 writes
`1.4.0+upstream.9543c29`, the fifth (`063..072`), and 076 writes
`1.5.0+upstream.9543c29`, the sixth (`073..076`), and 081 writes
`1.6.0+upstream.9543c29`, the seventh (`077..081`), and 083 writes
`1.7.0+upstream.9543c29`, the eighth (`082..083`). `preflight` prints the
value beside the ledger's highest migration and warns when a server is older than
the brain, or a brain has run past its version's range. Both are introduced by a
fragment or a cut rather than a hand-numbered change, so they are named here by
their ticket (FORK.md's "Versioning" and "Cutting a release", SMD-1804, SMD-1860).

The decision that `thought_audit` is the write-side source of truth and the
`thoughts` row its projection — the write functions appending the event first
and one projector writing the row, the audit trigger becoming the check, the
table kept for the community's DDL — is `../docs/event-log-as-truth.md`
(SMD-1997). Its three steps are filed (SMD-2115, SMD-2116, SMD-2117); the first
landed as migration 055 (what the event carries) and the second as 060 (below):
since 060 the three write functions append the event first and one projector
writes the row, the audit trigger checking the row against its event — the
paragraphs on 046, 050 and 055 below describe the trigger's raw path, which a
raw writer (`db/ingest-records.ts`, the backfills, a community schema) still
takes, and the event shape every path writes.

Migration 046 makes `thought_audit` the log of record (SMD-1730): eight columns
beside 008's and 010's — `actor_kind` and `trust` (who holds the key, and the
ceiling on the content: `operator | agent | ingested`), `origin` (the door — the
server, integration or worker; SMD-1541's `via`, promoted from
`actor_context`), `stance`, `cites`, `valid_from`, `valid_until` (what the write
declared in its event) and `backfilled_at`. The kind is read from the registry,
never from the payload: classify each key once with
`SELECT set_agent_kind('<label>', '<operator | agent | ingested>');` (before its
first request, if you like), then `SELECT backfill_thought_audit_events();`
fills the rows written before — the one UPDATE the append-only trigger allows,
and it stamps `backfilled_at`. Preflight's `audit events` counts the keys and
rows still waiting. `source` keeps its name and now carries one vocabulary, the
row's own `metadata.source`. The event rides `p_payload.event` on both
inserting `upsert_thought` forms and a tenth, defaulted `p_event` on
`update_thought`. Over MCP one key is sent: `capture_thought`'s `trust` (SMD-1724), the content's trust as the write declares it, which since 073 is also the row's (`metadata.trust`, below); nothing sends the rest yet (SMD-1725, 1733).

Migration 049 widens `ob1_agent_keys.scope`'s CHECK from `read, write` to
`read, write, capture` (dropping every CHECK on the column first, whatever name a
restore left it under) — the third key scope `server-portable/auth.ts` mints for
a session-end hook (`bun keygen.ts --scope capture`: `capture_thought` alone, no
read tool, no update, no delete; `recipes/session-capture-hook`). The column is
010's record of the scope a key last presented, not a gate; without the widening
`resolve_agent()` would have refused the row and every capture through such a
key would have landed without its agent id. Named by ticket for the same reason
as 044 (SMD-1298). The fourth scope, `forward` (SMD-2284: grants nothing; the MCP
server's key when it forwards a client's to the REST core), is not added to the
CHECK: `migrate.ts --reapply` runs 049 again, whose `ADD CONSTRAINT` would then
fail on a `forward` row. `agents.ts` sends a forwarder's scope as none, so
`resolve_agent()` records it NULL on first sight — which the CHECK admits — and
the key gets its agent id and its revocation when the REST core's forwarder
slot resolves it — the one place a forwarder is resolved. A forwarded write
names it in `thought_audit.actor_context` as `act` (`{name, agent_id}`), the
row's actor still the client's key. Sent none, `resolve_agent()`
keeps a scope already recorded (054), so a digest re-listed as a forwarder keeps
its old one; a forwarder is minted fresh.

Migration 050 puts the writer on the row (SMD-1726): two reserved keys in
`thoughts.metadata`, `actor_kind` and `actor_name`, stamped by a BEFORE trigger
(`thoughts_stamp_actor`) from the write's envelope through 046's registry lookup
and never from the payload — a caller's own values under either key are
overwritten or removed. The actor follows the content: a capture and a
content-changing edit stamp from the key present, a metadata-only edit keeps the
mark. In metadata rather than columns because 014's `metadata @> filter` route
over 001's GIN index already reaches it: `said_by` and `actor` on the search and
list tools are that filter, and every hit prints `By: <key> (<kind>) · trust <word>` (073's trust beside the two).
`SELECT backfill_thought_actors();` — called once by the file — sets both keys
on every thought to what the audit row that wrote its current text derives
(the update row whose after-text is the row's, else the capture when no update
ever changed the text, the newest by `created_at` then `seq` — an identity 050
adds to `thought_audit` for two rows one transaction wrote; a text no row
vouches for is nobody's; the registry's kind for the writer now, else the kind
046 stamped), correcting a planted claim and stripping one the log does not
vouch for; each row written leaves an audit row under the door
`backfill_thought_actors`. It locks `thoughts IN EXCLUSIVE MODE` for the write,
as 023's does (writers wait for the call, readers do not), so each call is its
own transaction and `OB1_BACKFILL_LIMIT` bounds the rows written per call — not
the scan, which derives every thought each time. Run it again after
classifying or reclassifying a key; it returns `{rows, differing, awaiting}`.
The identity column rewrites `thought_audit` once at apply (about a minute per
million rows, captures waiting): apply 050 in a quiet window.

Migration 052 adds the one read over that log a resuming agent asks first
(SMD-1296): `thought_changes(p_since, p_after, p_agent, p_not_agent, p_actions,
p_limit)` — one page, oldest first, from a time or from a cursor (the audit id a
page ended with; a keyset on `(created_at, id)`, so a walk never repeats a row
and never skips a committed one — `created_at` is the writing transaction's
start, so a write still in flight when a page is read is not on a later page of
that walk; a reader who must not miss it re-reads from a time), each row with a
bounded head of the text, an update's moved keys, the
`supersedes` pointer before and after, and who. The MCP tool of the same name
renders it; a self-hosted server role needs `SELECT` on `thought_audit` (the
server group below).

Migration 053 puts the source beside the thought (SMD-1867, the ingestion
adapter contract; SMD-1865 is its Linear instance). `thought_sources` holds, for
a thought that came from a source system, the system, the identity that
survives a rename there and the **canonical** form byte for byte — the truth a
two-way connector writes back, from which the row's text and its edges are
derived, never the other way — with its hash and the ingest run; one thought
per `(system, identity)`, written by `record_thought_source()` (the same
canonical twice writes nothing; an identity another thought holds is refused,
not re-pointed, unless the caller takes it — `p_take`, the board sync's case,
below) and resolved by `source_thought(system, identity)` (this table
first; for `linear`, the board sync's `metadata.issue` claim at the head of a
twin chain). A second facet kind, `link` — `{relation, system, target, origin}`,
relation one of `references | child_of | blocks | blocked_by | relates_to |
duplicate_of`, the target named by identity, never by id — is written as a SET
by `record_source_links(thought, system, links)`: a link the source no longer
states is closed (`valid_until`, history), one already active is kept, a new
one added; a partial unique index holds one active row per (thought, system,
relation, target). And `record_thought_entities` gains the **resolution rule**:
a `source:<system>` extraction key is a structured pass (the source's own
project and labels as mentions, no model call) that keeps its own rows as a set — the same set twice writes nothing,
an `extract:*` pass replaces only extracted rows, and where both name one
(thought, entity) or edge the structured row stands. Additive, no data change,
no ACL; the ingester and the board sync write through it (below).

Migration 054 redefines 010's `resolve_agent` so that a lookup writes a key's
row only when the write says something (SMD-2090): `last_used_at` NULL,
over five minutes old or in the future, or a presented scope that differs
from the recorded one. A recently used key presenting its recorded scope
takes no row lock, so it answers while another transaction holds its row,
where 010's body waited on every lookup (the SQL store caps each wait at
250 ms, and a key still waiting after the server's retries is busy,
SMD-2072). `last_used_at` now means the last use to within five minutes.
The write re-checks `revoked_at IS NULL`, and when it writes nothing the row
is read again: a revocation that commits while the lookup waits answers
REVOKED, where 010 answered ok and the server cached it for its TTL. A row
deleted during the wait is registered again (the rotation branch, or first
sight if its agent went too), and registration's `ON CONFLICT … DO UPDATE`
no longer writes over a revoked row. Under a REPEATABLE READ or SERIALIZABLE
default either write fails 40001 instead, which the server retries. Same
signature and grants, no data change; a role missing UPDATE on
`ob1_agent_keys` now fails only a lookup that writes (a stale key, a scope
change, a registration) rather than every known-key lookup.

Migration 055 makes the capture event carry the payload (SMD-2115, step 1 of
`../docs/event-log-as-truth.md`): a capture's `diff` carries the **content**
and, when the writer set the row's own time (`db/ingest-records.ts` backdates
a record), its **`created_at`**; an update's `diff` carries the key's move
(`content_fingerprint` before/after — 018's NULL for a text another row
holds, 023's fill, an edit's recomputation) — the three things SMD-1999
measured a projector needs beyond 046's event, and nothing else. 046's diff
rule, its append and 050's two stamp arms become functions the triggers call
(`ob1_thought_diff`, `ob1_append_thought_event`, `ob1_actor_stamp`,
`ob1_actor_stamp_kept`), one copy each for the write functions to call before
the row exists at step 2. Rows already written: `SELECT
backfill_thought_payloads();` fills `diff.content` (and `created_at`) on every
capture row from before 055 — from the first content-moving update's `before`,
else the tombstone's `previous_content`, else the live row — under
`ob1.audit_amend = 'payload'`, the payload amendment the append-only trigger
allows — the second it allows, the third named (a capture row's `diff.content` and `diff.created_at` where absent, with
what the log and the row derive to, and nothing else; under 046's `'backfill'`
an UPDATE of `diff` stays refused). The file calls it once (`OB1_BACKFILL_LIMIT`
bounds the batch, as for 023 and 050); preflight's `audit events` counts the
capture rows still without content and names the pass. On the dogfood brain
every one of 632 rows derived (239 from an update, 1 from a tombstone, 392
from the live row; 222 gained a `created_at`). The events read for a capture
are the thought's rows written after it — since `ob1_config.audit_seq_exact_since`
(050's `applied_at`, recorded at apply) a row is later when its `seq` is
larger and rows order by `seq`, the identity being exact insertion order; before
it a row is later when `(created_at, seq)` is larger and rows order so, the
pre-050 `seq` being heap order — and no further than the first later tombstone
or capture: an id `ingest-records.ts` re-uses after a delete has a second
incarnation whose edits are not the first capture's, and a prior incarnation's
rows are not the second's. `created_at` is the transaction's start, so an edit
from an older transaction can be stamped before the capture it follows; the
boundary is what tells it from a prior incarnation's row. A thought deleted
while the pass runs makes the gate refuse that row; the fill runs in batches of
1,000, catches the refusal, sets the row aside as `skipped` and runs the batch
again (a refusal that sets nothing aside is raised after five), and the next
pass fills it from the tombstone. A capture row whose `diff` is no object is no
candidate and is not counted as waiting; run one pass at a time.
Additive, no signature moves, no return changes, no row written differently.
What a reader sees change: `thought_changes` lists `content_fingerprint` in
`changed` when a text moves; and two passes that wrote no audit row before
write one per row they key, since a key's move is an event — 023's
`backfill_content_fingerprints()` and `reembed.ts`'s edit of a legacy twin.

Migration 056 gates the entity graph's names (SMD-1935). `entity_type_gate(name,
type)` is the rule: a name that normalises to digits, dots, colons and spaces (a
migration number, a port, an address, a CIDR) or to the type vocabulary itself
(`person`, `tools`, `entity`) is refused, and a `person` or `place` with an
identifier's shape is retyped — a ticket id to `project`; a URL, package, path
or host:port to `tool`; and for a place only (a person's handle takes these), a
host, domain, file, snake_case name or glob to `tool` — since code artifacts are
entities and refusing them dropped real ones (SMD-1937's measurement).
`record_thought_entities` applies it to every extraction and returns
`refused_entities` and `retyped_entities`, one per answered (type, name); a
relation naming a refused entity is dropped and counted as any unlisted one is.
A `source:` pass states its names on the source's authority and is not gated, so
a numeric name a source states (a Linear label `2024`) can remain.
`apply_entity_type_gate()` applies the rule to the rows written before it, each
entity judged on its name, leaving any a structured pass names or a human
curated (a name merged into it; its own name, answered again, lands on an entity
of the new type, since the writer's redirect is per type) — a refused entity's
edges, mentions and row deleted; a retyped one merged by `merge_entities`' steps
into the entity of its new type the writer would resolve it to, or moved when
there is none — and the file runs it once, keeping the first run's counts in
`ob1_config` under `entity_name_gate_056` (`SELECT value FROM ob1_config WHERE
key = 'entity_name_gate_056'`): on the dogfood brain at 053, 116 refused, 8
moved and 4 merged of 3,384. Idempotent; no ACL. The writer's `merged_from`
redirect is spelled `@>` now, which 016's GIN index serves. A writer call
already running 053's body when the file commits writes by 053's rule: stop the
extraction workers for the upgrade, or run `SELECT apply_entity_type_gate()`
once they have finished (and again after a source stops stating a name the rule
refuses), as the role that migrated or a `--grant` role — one granted before
SMD-2216 lacks UPDATE on the mention tables, which a merge needs, until
`--grant` is run for it again. Such a run's counts are its result; `ob1_config`
keeps only the file's. `server-portable/entity-gate.ts` is its JavaScript twin,
for the capture-time `people` facet (`metadata.ts`), which never reaches the
function and keeps only the names the rule keeps as a person; test-schema [52]
holds the two to one answer.

Migration 058 is `node_state` (SMD-2074): one read of a thought's lifecycle,
blockers and supersession, for every surface that ranks by them. Until it,
`graph-centrality.ts` held those rules as SQL private to the script, and the
server — which cannot import a `db/` script, and whose PostgREST store reaches
only RPCs — could not share them. Five functions, all `LANGUAGE sql`, SECURITY
INVOKER, no SET, not STRICT, so a caller's planner inlines them:
`node_lifecycle_types()` and `node_settled_types()` (the six status types this
schema knows, and the two that settle a node); `node_lifecycle()` (per thought:
status, status_type, the source watermark `synced_at` and `created_at` — a row
carrying `ticket` or `issue` reads its ticket's head; it read `thoughts`
alone until 068 stored the heads); `node_dependencies()` (one row per
`blocks` / `blocked_by` link facet, active or closed, with whether its system
gates — SMD-2218's rule); and
`node_state(ids)` (every thought, or those named: the lifecycle beside `open`,
`blocked`, `blockers`, `unknown_blockers`, `in_dependencies` and
`superseded_by`). Coverage and freshness are columns — a node carries a
lifecycle when `open` is not NULL; its freshness is `synced_at`, never
`updated_at` — so each consumer counts over what it ranks. At 058 the ids
narrowed the rows returned, not the work: the whole brain was computed and
filtered last (068 stores the heads and superseders, below).
`graph-centrality.ts` is the first reader, its reports byte for byte what they
were; search is the second (`search_thoughts`' opt-in `prefer_current`, through
059). `metadata.status_type` is a
transitional, lossy scalar: when SMD-1997 folds the transitions `thought_audit`
holds, the two reads of it change — `node_lifecycle()`'s body and
`node_dependencies()`' gate — and no signature does. Reads only, no grant row
(EXECUTE is PUBLIC): `node_lifecycle()` needs SELECT on `thoughts`;
`node_dependencies()` and `node_state()` also need it on `thought_facets` (the
capture group) and `thought_sources` (the `structure` group, and the `server`
group since 059). The file drops
its three table functions before creating them, so `--reapply` replays it over
a later migration's reshape; the price is that a view of an operator's over
`node_state()` (or any other object that records a dependency on one) stops
that replay at 058, and a REVOKE on one is not kept.

Migration 059 is `search_thoughts_current` (SMD-2255, SMD-2074's second
consumer): the hybrid search with settled and superseded thoughts ranked below
current ones, which `search_thoughts` calls when a caller passes
`prefer_current` — by default the server calls `search_thoughts_hybrid` itself,
so the default ranking is unchanged and 025's "labelled, not demoted" stands
for every caller who does not ask. It reads the hybrid's top min(100, 4N) and
`node_state` for them; a thought whose ticket is settled (completed or
canceled, by 058's ticket-head rule — a note filed under a Done ticket
included) or that a newer thought supersedes weighs `search_demote_weight()`
(0.25, pre-registered, once) of its fused score, and the window is re-sorted and
cut to N. Under the hybrid's fusion that is in practice a partition: every
current match in the window first, then the demoted ones in their own order
(a demoted exact hit keeps a quarter of its literal bonus, 1/61 per literal it
holds, so on a query of literals only, or holding several of the query's
literals, it can still outrank current rows; holding one, only past the vector
arm's 62nd rank);
the weight bites only against an exact-literal hit, so a settled ticket looked
up by its key can drop — to look one up, leave the flag off. A blocked or
unknown status does not demote a thought (superseded still does); ties go to
the current row. Once the window holds N current rows a demoted thought is out
of the top N, which is where the eval's costs grow at threshold −1 (NOTE
−0.524, PREVIOUS −0.449, a settled key −1.000). Each row carries `fused` (before the
weight), `demoted` (why) and the window's size, lifecycle coverage, demoted
count, latest source watermark and whether its top N is exact. Priced first in
`evals/eval-supersession.ts` against a pre-registered rule (CURRENT-version
MRR +0.052, live-ticket MRR +0.194; costs disclosed — topical −0.127, a note
under a Done ticket −0.292, a settled key −0.750); the query log records such a
search as arm `current` (the CHECK widened), and `db/tier.ts` replays it. The
server group gains SELECT on `thought_sources`, which `node_state` reads for
its dependency columns (since 068 the search's columns do not); the wrapper
is dropped before it is created, as 058's three are. At 059 it cost what
`node_state` cost — the whole brain's lifecycle per call: +10.7 ms
at 10,000 thoughts, +129 ms at 100,000, +2.8 ms on the dogfood brain — past the
budget pre-registered for it; shipped opt-in on the maintainer's call, and 068
made it a lookup.

Migration 060 has the write functions append then project (SMD-2116, step 2 of
`../docs/event-log-as-truth.md`). `upsert_thought` (2- and 3-argument),
`update_thought` and `delete_thought` keep 046's and 042's bodies up to the
write — the same locks in the same order, every refusal before any append —
then compute the after-image with 055's functions, append the event through
`ob1_append_thought_event` and call `ob1_project_thought_event(event, vector,
model, replay)`, which writes the row: capture → INSERT, update → UPDATE by the
event's afters, delete → DELETE; faithful, not corrective (a key the event does
not move stays; a capture's key is derived from its content, the one thing the
event does not carry). `thoughts_write_audit` under `ob1.projecting` is the
check — the row must be the event's AFTER image, a tombstone's `previous_*`
included, and move only columns the event names, SQLSTATE `OB002` otherwise; a
foreign row is accepted as a bump or as a tombstone's nulled successor pointer
(appended live, skipped on a replay); without the setting it appends as before,
so a raw write is audited, never refused. Live, the projected event must be the
thought's latest by `seq`. `ob1_refresh_thought_vector` writes a vector onto a
row that has one with no event and no `updated_at`; `ob1_embedding_snapshot`
holds every vector by (key, model), seeded once from the rows and fed by
`thoughts_snapshot_embedding` on live writes alone, so a fold rebuilds vectors
without the provider (no row leaves it by itself — the decision's forgetting
rule is the removal path: 063's `rebuild_derived` with `p_input_gone` deletes
the rows at a leaving thought's fingerprints, and SMD-1723's forget calls
it); 001's
`update_updated_at` yields for the projected row. A role granted before this
file lacks `SELECT` on `thought_audit` and every privilege on the snapshot:
run `migrate.ts --grant` for it again before the server writes, as
SMD-2216's note above says for its rows (preflight refuses, naming them).
The `SELECT` has been needed since 055 — `ob1_append_thought_event` reads the
row it inserts (`INSERT … RETURNING`) — and the grant set had no row for it
from 055 to 058, so a role granted then could not write at all; the row lands
here (SMD-2116's fourth review pass).
Six deltas against 055 — five the decision accepted, a sixth the write path
forced: an identical re-capture, a no-op edit and a vector refresh write nothing and move no stamp; the
stale-read guard is the pre-check alone; the 2-argument form locks the row it
lands on; a raw writer committing the same text inside a fresh capture's window
is merged as a re-capture (046's `ON CONFLICT` did it; 060 catches the unique
violation). A fold replays the log in 055's order — `seq` since
`ob1_config.audit_seq_exact_since`, `(created_at, seq)` before it — never by
the clock alone, which inverts a row's history. The capture role gains SELECT
on `thought_audit` and the snapshot's writes (the grants table). Additive, no
arity moves, idempotent; a re-apply re-seeds nothing. test-schema [56],
test-live [28], test-upgrade [20m]; the redaction arm is SMD-1723's, the fold
SMD-2117's.

Migration 061 gives every derived artifact its lineage (SMD-1731, Phase 1b of
SMD-1729; the projections table in `../docs/event-log-as-truth.md`). One
table, `derivations`: a row per artifact per producing pass — `artifact_kind`
in chunks / entities / proposal / vector / metadata (and section since 064, relation since 084), `artifact_id` (the
thought's id, or the proposal's), `input_ids` and `input_fingerprints`
(parallel, no NULL element), `produced_by` (the pass), `recipe` (a JSON object
with a boolean `deterministic`, what 063's rebuild reads, and the
producer's own record — model, prompt version and hash, window parameters),
`produced_at`, 010's agent — keyed UNIQUE on (kind, artifact, pass), the unit
each producer replaces, with a GIN index on `input_ids` for the forward walk
and no foreign key (two AFTER DELETE triggers drop what a deleted thought or
proposal keyed). Every producer records in the transaction that writes its
rows, through `ob1_record_derivation`, which refuses a bad shape: the vector by
a trigger on the row store (`thoughts_record_vector_lineage`, 060's snapshot
trigger's shape — no column list, nothing under a replay, nothing while the
vector and its label stand: a text edit alone leaves the row naming the text
the vector came from, stale for the census to read), so a raw or vendored
writer is covered; the windows and the tags by the
3- and 4-argument `upsert_thought` and `update_thought` from a lineage envelope
(`p_payload.lineage`, `update_thought`'s new eleventh argument `p_lineage`;
the 10-argument form is dropped with its ACL carried, as 046 and 060 did) — a
caller that sends no recipe gets no tags' row, since its tags are not a
derivation, and the windows' row from the label alone marked undeclared; the
extraction by `record_thought_entities`, now seven arguments (`p_recipe`; the
six-argument form dropped), which stores the fingerprint it checked — the
graph's half a key, closed — and follows its own replacement rule (an
extraction's row replaces every extracted row's, a structured pass's its own
key's; no rows standing under the key, no row); the proposal by
`record_supersession_proposal`, now eleven arguments, with both fingerprints
as the row takes them. The backfill records every artifact standing — every
proposal (the judge key parsed where it has 029's shape), every (thought, key)
pair over the mentions and edges at the thought's current fingerprint, every
chunk set, every vector — marked `legacy: true`; the tags are not backfilled
(nothing on a row says the extractor tagged it), and preflight's new `lineage`
check counts them as coverage, fails on a derived row without a lineage row
(naming the kind and the ids), and reports the legacy and stale counts. The
capture role gains every privilege on `derivations` (the grants table): run
`migrate.ts --grant` again for a role granted before this file. Additive; three
arities move under their own DROP; a re-apply re-seeds nothing. test-schema
[57], test-live [30], test-upgrade [20n]; the rebuild that walks the table is
063's (below), the forget SMD-1723's.

Migration 063 is the rebuild (SMD-1732, Phase 1c of SMD-1729):
`rebuild_derived(p_input, p_reason, p_input_gone, p_fingerprints, p_force, p_orphans_only)`
walks `derivations` forward from a thought (`derivation_descendants`, 026's
iterative walk with a walk-global seen set — one GIN probe per level, the
`derived_from` children listed as prose and not expanded) and acts on every
row: a row whose artifact is gone (windows deleted raw, a vector cleared
under a replay) is deleted; a stale row — an input's fingerprint moved, or
`--force` — is re-derived where the database can (a vector whose current text
has a snapshot row at the model, by `ob1_refresh_thought_vector`; a snapshot
vector identical to the row's is 060's copy of the old vector under the new
key and is not a rebuild; under `--force` a vector whose text did not move is
re-recorded, not re-embedded — the record is what force renews) and otherwise
handed to the worker that owns the recipe through 016's `requeue_thought_work`
under the worker's CURRENT key (the reembed pool for a vector or the windows,
`ob1_config`'s extraction key for an `extract:` pass), with the reason
marked on the lineage row (`stale_since`, `stale_reason`, two new columns the
writer's next upsert clears; the first request standing is kept); a `source:`
pass and a decided proposal are kept; a pending proposal whose texts moved
takes the new `stale` status — its status is its mark, its lineage row is
left alone — and its newer thought is requeued under the judge's key (029's
CHECKs widened; `consolidation_candidates` yields the pair again;
`record_supersession_proposal` replaces the stale row in place, back to
pending, when the pass finds the conflict again; a pair the pass no longer
finds in conflict is the pass's to settle since 067, below; a reviewer may
decide a stale row sooner, accepting it with `p_force` or rejecting it —
`consolidate.ts --list stale`); the
tags are marked with no pool to feed (no worker re-tags a thought). With
`p_input_gone` —
SMD-1723's forget, called BEFORE the row delete, in one transaction — the
windows, the input's mentions and edges (the entities locked first, then the
orphans pruned: 016's rule) and their lineage rows go, the snapshot rows at
the input's own fingerprints and the caller's `p_fingerprints` go where no
standing thought holds them (060's "removal path, not built", built), and
the proposals and the vector's and tags' rows are counted for the cascade the
row delete runs. The walk is held whole before anything moves; the locks are
delete_thought's (the supersession advisory lock first, then the row); under
`ob1.projecting_replay` the call answers `REPLAYING`; `p_orphans_only` (the
sweep's mode) runs the orphan rule alone. The report:
`{rebuilt, enqueued, deleted, marked, unqueued, stale_proposals, kept,
current, legacy, at_cap, irreproducible: [ids], cascading, pools}`.
Preflight's `lineage` check counts the marked rows, warns on orphans naming
`rebuild.ts --orphans`, and warns when 061 or 029 is re-applied by hand over
063 (the three bodies it redefines read as older). The
operator's door is `rebuild.ts` (its own section below); the worker group
gains `DELETE` on the snapshot (the grants table). Additive; three bodies
redefined on their own text with no arity change. test-schema [58], test-live
[31], test-upgrade [20o].

Migration 064 is the page store (SMD-1812, the store half of SMD-949): a
durable, named document a human and a machine both edit, without the next run
of its generator shredding what the human wrote. **A page is a thought.**
`pages.id` is the page thought's id (a foreign key, cascade), and the thought's
content is the page's *render* — `# title`, then each section by order with its
`## heading` — written only through `update_thought` after every live change,
so every render is an event in `thought_audit` (the page's own history, title
included), stamped with the key that wrote it, searchable once the re-embed
worker fills the vector 021 clears (`bun reembed.ts` — its pool is every row
without a vector or at another label), and extracted like any thought. Its
`derived_from` is the union of the live sections' evidence, so 025's
`trace_provenance` and `find_derivatives` read a page unchanged; `supersedes`
passes through and archives the superseded page. The structure is the store's
own: `page_sections` (each with an **owner** — `origin` `generated` is the
machine's, `manual` or `locked` a human's — the live body, the machine's
evidence and recipe, and the **pending buffer** a parked draft waits in with
the evidence and recipe *it* was made from) and `page_section_revisions`
(append-only by trigger: body, heading and order — everything the render reads —
per change and per ownership move). One door for a section's text,
`write_page_section` (the regen guard, `ob1:page-regen-guard`): a generated
write onto a human-owned section parks, the live text byte-identical; any
other write updates in place — a manual write takes ownership — and snapshots
a revision. `accept_page_section` promotes a parked draft (the section stays
human-owned: the machine proposes next time too); `release_page_section` hands
one back; `reject_page_section` discards a parked draft; `lock_page_section`
sets the lock; `delete_page_section` removes a section, the render following.
A generated write that says what the live text says is `unchanged` and
withdraws an older draft it had parked. `render_page(page, at)` and
`page_sections_as_of(page, at)` render any prior state of the sections byte for
byte from the revisions, under the current title (a revision is written per
change to body, heading or order and per ownership or lock move; a deleted
section's revisions go with it; every full render, title included, is in the
page thought's audit log). A slug is one word and a title or heading one line —
the render is line-structured. A generated section is a derived artifact under
SMD-1729's rule: its `derivations` row (the sixth kind, `section` — 061's CHECK
widened, its writer redefined on its own body plus the value) names the
evidence at the fingerprints read and the generator's recipe, in the section's
transaction; the section's `generation_source` holds the same recipe, so "a
machine wrote this text" is one predicate whatever the owner. A generated write
without evidence is refused (and a page is never its own evidence); a parked
draft parks its evidence's fingerprints as generated from, and accept records
those; a manual write that moves the body drops the row and empties the recipe;
a deleted section's rows go by trigger; preflight's `lineage` check counts
sections carrying a recipe without a row (regenerating such a section records
it, unchanged or not) and, when no row is missing, warns on a page whose
thought does not hold its render (a raw write; `ob1_render_page_thought(page)`
repairs it). Every writer locks the page thought, then the page, then the
section — the order `delete_thought`'s cascade takes, so a write racing a
page's delete waits rather than deadlocking — and a writer given `supersedes`
takes 029's supersession lock before any row, as every writer of that pointer
does. The signatures, positional or named (`p_…`): `upsert_page(slug, title,
page_kind DEFAULT 'topic', metadata DEFAULT '{}', actor DEFAULT NULL,
supersedes DEFAULT NULL)`; `write_page_section(page_id, section_key, body_md,
origin DEFAULT 'generated', heading, generation_source DEFAULT '{}',
evidence_thought_ids, display_order, actor)`; `accept_page_section(section_id,
actor)`, `release_page_section(section_id, actor)`,
`reject_page_section(section_id, actor)`,
`lock_page_section(section_id, locked, actor)`,
`delete_page_section(section_id, actor)`; `render_page(page_id, at DEFAULT
NULL)`, `page_sections_as_of(page_id, at)`. A SQL caller that wants the page
thought stamped with its key sets the session's envelope first — `SELECT
set_config('ob1.actor', '{"name": "<key name>"}', false)` — as the servers do
(008, 050); `actor` is the name the page's own history records. Names differ
from upstream's `schemas/wiki-pages` (`pages`, not `wiki_pages`), whose
directory retires with this file: a brain that applied it by hand keeps its
tables untouched. The new `pages` grant group is what a role needs beside
`capture` (the grants table). Additive; no arity moves; no seed row; a
re-apply is idempotent (it re-validates the kind CHECK and moves no row).
test-schema [59], test-live [32], test-upgrade [20p];
`server-portable/test-preflight.ts` drives the census, the remedy and the
repair arms.

Migration 066 (SMD-2292) closes a pairing 064 made routine: a page is a
thought whose `derived_from` names the evidence its sections were generated
from, and once the re-embed worker gave the page thought a vector and the
extractor gave it entities, `consolidation_candidates(page)` returned that
evidence as the page's first candidate at cosine 1 — the judge asked whether a
derivation supersedes its input, and a reviewer's accept would have archived
the evidence while the page still named it. The file redefines the candidate
filter on 063's body plus two NULL-safe conditions: a candidate the judged
thought's `derived_from` names is left out, and so is a candidate whose own
`derived_from` names the judged thought (an older note re-cited through
`update_thought`'s provenance envelope, an ingester's backdated part row, a
derivation whose input was captured later, or a `created_at` moved by hand).
Direct members only, and expect the transitive shape from SMD-2143's writers:
a page citing an earlier page or a digest on the same entity (064 admits a
page as evidence) is judged against that page's evidence at cosine near 1 —
until SMD-2314 lands, a reviewer reads `trace_provenance(newer)` and rejects
it. Siblings — two pages from one evidence — are still judged (a page
superseding a page is 064's designed state; the archive takes a page's
human-owned sections, so weigh them). Both sides stay in the pool: the rule
filters pairs, not membership. The body carries
`ob1:lineage-excludes-the-pair`, which preflight's `lineage` check reads: 063
re-applied by hand over 066 warns naming 066 (029 re-applied is caught
earlier, by the producer-count arm; the remedies run 061, 063, 066 in turn).
One body redefined on its own text with no arity change; nothing runs at
apply time but the DDL; a pair proposed before the file stands for its
reviewer (`consolidate.ts --list pending`) and is NOT marked as a lineage
pair — the listing read nothing of `derived_from` until 070, the pass never replaces
it (a text move, once `rebuild_derived` runs — `db/rebuild.ts` — leaves it
`stale` for a reviewer, and the pass settles it on its next run — 067), and
the recorder has no lineage guard; 070 flags such a row `LINEAGE PAIR`, and
`consolidate.ts --list lineage` lists the unreviewed ones for the reject.
test-schema [60], test-upgrade [20r] (a proposal planted on the pair before
the file is pending and unmoved after it); `server-portable/test-preflight.ts`
drives the re-applied-body arm.

**067 — the consolidation pass settles a stale proposal it no longer finds in
conflict, and a pass-settled row is the pass's to reopen (SMD-2297).** 063
left a dead end: `consolidate.ts` writes a proposal only for a conflict at its
confidence floor, so when the edit that made a row stale had resolved the
conflict — the likely outcome — the pass judged the pair, found none, wrote
nothing, and the row stayed `stale` for a reviewer for ever. 067 adds
`settle_supersession_proposal(id, note, actor, judge_key, older_fingerprint,
newer_fingerprint, recipe, agent)`: the pass's rejection of a stale row —
through `review_supersession_proposal`'s reject arm, which checks no status
and sets `reviewed_at` — with a note beginning **`settled by the pass:`**, the
one string that says a machine decided the row (one constant in
`server-portable/consolidate.ts`, one literal in the two SQL bodies; test-schema
holds them to each other), and the proposal's lineage row rewritten at the
fingerprints the pass judged under the pass's key — the row `rebuild_derived`
reads staleness from, so a settled pair reads current until a text moves
again. It refuses a row that is not stale (a pending row is a reviewer's, a
decided one is decided) and a note without the marker. `rebuild_derived` is
redefined on 063's body with one arm changed: a rejected row whose note
carries the marker is the pass's, so a text move under it sets the row stale
again (unreviewed, the note cleared — the maintainer's choice over keeping it
as a person's decision, which would leave a pair the pass once found clear
unproposable when its texts later conflict, and over a fifth status); a
person's rejected or accepted row is kept, as before; and 064's `section`
kind — a generated page section, which 063's body sent to the kept arm — is
marked with no pool, as the tags are (its generator's next
`write_page_section` clears the mark). `consolidate.ts` does
the rest (its section below): every run re-pools each stale row's newer
thought under its own key, judges a stale pair the top-k left out when it
still meets the candidate rule, replaces a conflict found again, settles a
judgement of no conflict or a pair the rule no longer admits, and waits on a
side without a vector. Preflight's `lineage` check warns when 063 is
re-applied by hand over 067 (rebuild_derived's reopen sentinel gone where the
settle function stands). The status column's and the table's comments are
re-issued. Additive: one function, one body redefined with no arity change,
no grant moves. test-schema [61], test-live [16], test-upgrade [20s].

Migration 068 stores what `node_state` read per call (SMD-2256):
`ob1_ticket_head`, every issue key a row carries with its head (058's rule) and
the head's status, status_type and watermark, and `ob1_superseded_by`, every
superseded thought with its newest successor. Three statement triggers on
`thoughts` (AFTER INSERT, UPDATE and DELETE, with transition tables) keep them
current, and a fourth empties both on TRUNCATE: a statement touching no row with
an issue key or a `supersedes` pointer returns at once; otherwise the keys it
moved — both sides of a key's move, a pointer's targets and their issues, a
successor's `created_at` — are locked and reconciled through
`ob1_ticket_heads_of()` and `ob1_superseders_of()`, each rule written once. The
locks are transaction advisory locks on buckets of the keys' hashes (classes
22560–22562, at most 513 held by a transaction), taken before the recompute:
statements moving one ticket's key, status, watermark or pointers serialise
until commit (a content-only edit takes none), a row whose head fields move
holds its own pointer bucket so a concurrent pointer to it waits and reads its
issue after, a DELETE holds the buckets of its deleted issue rows and of the
deleted rows something supersedes so the cascade that nulls pointers to them
needs none it lacks (not of every deleted row: a prune of plain rows stalls no
ticket writer), and a transaction whose ticket writes take more than one round
of locks — two or more statements, or one that fires the trigger twice (a MERGE
with several actions, a multi-row upsert that both inserts and updates, a
writable CTE with several kinds of write) — can now deadlock (40P01) where it
waited: retry it (the repo's writers are single-row, one statement per
transaction). Such a statement is refused under REPEATABLE READ (its snapshot
predates the lock); SERIALIZABLE keeps the tables exact only when every ticket
writer is serializable. The trigger and the reconcile plan every statement that
takes the keys afresh: a plan cached while the tables were small went on
scanning them. The reconcile is internal (it takes no lock; call the rebuild).
On a PostgreSQL release that drops them from the transition table (PGlite's 17.5
does; 16.15 and 17.8 do not), the rows a MERGE updates when its own DELETE's
cascade updates them too are not seen: rebuild after such a MERGE there. It is
fed by the row store, not the log: every writer reaches `thoughts`, raw ones
included, and the log carries no `created_at` move; SMD-1997's fold can later
feed the heads' status. `node_lifecycle()` and `node_state()` keep their
signatures and rows and read the tables; `node_state` lost its top-level WITH,
so a caller's planner pulls it up, drops the dependency joins it does not read
(whole-brain reads until 071 keyed them — `blockers`, `unknown_blockers`,
`in_dependencies`, and `node_dependencies()`' gate — SMD-2267) and looks the
rest up by primary key. `search_thoughts_hybrid` is estimated at 100 rows, its
window's bound, so a ten-thousand-thought brain does not hash-join the whole
table to it. Measured on `bench-hybrid.ts`'s arm: `prefer_current` adds, in the
bench's run of this code, +0.50 ms at 10,000 thoughts with no needle and +0.66
with one (the difference of medians, alternating order; the budget 059 missed is
the hybrid's own median, 0.88 and 1.14 — as sql, re-planned per call, the
wrapper was once +1.11 against 1.10), and +1.11 and +1.34 at 100,000. With no
needle, the hybrid asked for its window of 40 costs +0.44 at 10,000 and +0.99 at
100,000 on its own, about all of the no-needle addition: the two differences of
medians do not subtract. A narrow read is what got cheaper: a whole-brain read
of every thought's lifecycle still reads every row (6.3 ms at 10,000, 78 at
100,000). A writer's cost is measured against the triggers dropped — disabling
them still fills their transition tables — and is in `changes/smd-2256.md`.
`ob1_node_projection_drift()` compares the tables with 058's formulas (zero rows
when exact) and `ob1_rebuild_node_projection()` repairs them after a write made
with the triggers disabled (`DISABLE TRIGGER`, `session_replication_role =
replica`); it refuses to run outside READ COMMITTED, and `migrate.ts` now runs
every file under READ COMMITTED, so 068's seed is right on a brain whose default
is not. Preflight fails a connection whose default is REPEATABLE READ. The
triggers run as the writer, so the **capture** group gains the writes on both
tables: a role granted before 068 fails preflight until `migrate.ts --grant`
runs again, and a reader of `node_lifecycle()` needs SELECT on
`ob1_ticket_head`. On PostgreSQL 16 and 17 the search's lifecycle columns no
longer read `thought_sources` (a removed join's tables are not
permission-checked — observed, not documented), so the server group keeps that
grant.

Migration 070 makes a proposal standing on a lineage pair visible as such
(SMD-2313). 066 stopped the pass proposing a thought against a member of its
`derived_from`, and changed nothing about a proposal already standing on such a
pair — judged before 066, or recorded raw (the recorder has no lineage guard):
the listing read nothing of `derived_from`, so a reviewer saw "the page
supersedes its evidence" as any other pending row, and an accept would have
archived the evidence while the page still named it. Such a row is nobody's but
the reviewer's — a pending proposal holds its pair (029's rule, read by 063's
candidate clause), and 063's recorder rewrites stale rows alone, so no pass
judges or replaces it; a stale one, which 063's clause re-admits and 066 keeps
out, is the pass's to settle since 067, on the next run that re-pools its newer
thought (both sides with a vector, no failed claim under the run's key). The
file redefines `list_supersession_proposals` on
029's body with a trailing `lineage` column — 066's predicate, either direction,
direct members, NULL-safe — and a third parameter `p_lineage` (NULL every pair,
true the lineage pairs alone, false the rest); the two-argument form is dropped
first (a `RETURNS TABLE` cannot gain a column under `CREATE OR REPLACE`), and a
two-argument call resolves to the new form through the default. The readers
follow: `consolidate.ts --list` prints `LINEAGE PAIR` on such a row with the
reject to run, `--list lineage` selects the unreviewed ones (pending, then
stale), `--status` counts them, `--accept` refuses such a row unless `--force`
(029's edited-since rule, CLI-side); the MCP tool prints the tag and takes
`lineage: true`; preflight's `lineage` check counts unreviewed proposals on a
lineage pair (bounded, as its census is) and warns with the ids and the remedy
— on a brain at 068 the remedy applies 070 first, since `--list` needs it while
the census and `--status` read the tables — and, with no such row standing,
warns when the listing is from before 070 (every listing fails there: the
callers pass the third argument) or 029's two-argument form stands beside it
(029 re-applied by hand lands it beside, and a call short of three arguments
is then ambiguous and fails; the fork's callers pass three, which resolve). No
verdict is written at apply time — a rejection is a reviewer's, with a name on
it — and a `--reject-lineage` sweep is not taken until the flag has been used.
DDL alone; no row moves; no grant is carried (EXECUTE is PUBLIC, as on 029's).
test-schema [64], test-upgrade [20v], test-live [16];
`server-portable/test-preflight.ts` drives the census, the leftover-form and
the older-body arms; the store and e2e suites read the column.

Migration 071 makes `node_state`'s dependency columns read the ids they are
asked for (SMD-2267). The gate — whether some source row of a system states a
known status on its own metadata (058's, SMD-2218) — is the one answer not local
to a few rows, so it is the one stored: `ob1_source_gate` mirrors every
`thought_sources` row with its system and whether its thought's `status_type` is
one `node_lifecycle_types()` knows, and a system gates while some row of it does
(one probe of a partial index). Statement triggers keep it current: on
`thought_sources` (AFTER INSERT, UPDATE and DELETE with transition tables, and
TRUNCATE) for the rows that appeared, vanished or changed system — a
canonical-only re-record returns at once, and a delete drops its mirror rows by
key, reading nothing else — and on `thoughts` (AFTER UPDATE) for the rows whose
`status_type` moved between known and unknown; any other write returns at once.
A source write and a status move of one thought take turns on an advisory
lock — a bucket of the thought's id, 256 buckets in class 22563, taken in
bucket order after 068's classes, exclusive for both — so whichever goes second reads what the
first committed; a source row's delete takes none (it drops the mirror row by
key).
Not the thought's row: a source writer's share lock there, until the second
review pass, deadlocked with multi-row updates, cascades and takes where main
waited. A bucket is held until commit, so a transaction that writes source rows or
moves statuses holds up both in its buckets, and transactions that do either
for several thoughts in separate statements can deadlock, as 068's ticket
writes can: write a thought before its source row, one thought per transaction
(the bucket is then taken once, for both). Shared buckets for status moves
were tried and reverted: a status move then a source write, in one
transaction, upgraded the lock and deadlocked bucket-mates ten times in ten. REPEATABLE READ is refused for a source row's insert or move and for
every status move between known and unknown (a source row's delete and a
re-record that changes nothing run; the delete raises 40001 if its thought's
status moved since the snapshot). `ob1_rebuild_source_gate()` repairs the mirror after a write made with
triggers disabled, and `ob1_node_projection_drift()` gains a `source_gate` arm.
`node_dependencies()` keeps its rows and tests each link's system against the
gating systems, read once per call, instead of grouping every source row with
its thought. `source_thought()` keeps its
results and finds the board sync's claim for a linear identity no source row
holds by 068's issue index: 001's GIN index read every issue row's posting per
such blocker, which on a brain where most links name a ticket it does not hold
cost the keyed read 47 ms and a whole-brain read 5 s. `ob1_node_dependencies_of(ids)` is
the dependency read: for ids, each thought's ticket identities (its source row,
its `ticket` or `issue` claim), each identity's links from both ends through
053's indexes, the gate by index (`ob1_system_gates()`, planned on the partial
index: inline, a system that never gates cost a scan of the whole mirror per
link) and each blocker's lifecycle by primary key;
for NULL, 058's whole-brain read as 068 ran it — two branches behind one-time
filters under one `GROUP BY thought_id`, which a caller that reads none of the
columns still drops. `node_state()` joins it once. On `bench-hybrid.ts`'s arm
(two links in three naming a ticket the brain does not hold), `SELECT * FROM
node_state(<40 ids>)` costs 2.9 ms at 10,000 thoughts and 2.9 at 100,000 (6.5 s
and 656 s on the reads 068 left), every thought's dependency columns 31 and 308
ms (6.1 s and 732 s), and `node_dependencies()` read for its gates 2.1 and 15.7 (3.5 and 45.8); a
writer pays +0.09 ms at most (a new source row), measured paired. A caller that passes NULL and
joins its own ids still computes every thought: pass the ids. The triggers run as
the writer, so the **capture** group gains the four privileges on
`ob1_source_gate`: a role granted before 071 fails preflight until `migrate.ts
--grant` runs again. test-schema [65], test-live [35], test-upgrade [20w].

Migration 073 puts the content's trust on the row (SMD-1724): `metadata.trust`,
a third key the database owns beside 050's two. It is 046's
`thought_audit.trust` for the write that put the standing text there: the
key's registry kind, or lower when the write's event declared lower, never
higher. A payload's own `metadata.trust` is read as that declaration
(`ob1_declared_trust` folds it into the event when the event names none), so
a raise is clamped to the key and filed under the audit row's
`actor_context.claimed`, and a lowering stands; on a write that leaves the
text, the trust the row already carries is an echo of a read (a client
writing back the metadata it fetched) and declares nothing, while a new text
weighs every word — a lowering and an echo of a lower trust cannot be told
apart there, and the lower label is the safe error. The trust follows the content
as the mark does: a re-capture (except, since 085, one a capture-only key's
stamp yields to — below) or a metadata-only edit keeps it, and a
text-changing edit takes the editor's. The stamp has to be in the write
functions' bodies, because since 060 the projector writes the row from the
event, so 073 redefines both inserting `upsert_thought` forms and
`update_thought` on 060's and 061's bodies; the raw path (050's trigger)
reads the `ob1.event` handoff's trust. An unclassified key's rows carry no
trust unless the write declared `ingested`. `backfill_thought_actors` (called
once by the file) derives trust from the same audit row it derives the writer
from, so after `set_agent_kind` the same call fills both — and never raises
one: the lowest of what that write recorded (or the claim it filed while its
key was unclassified), the key's kind now, and the row's own word, so a key
reclassified down takes its rows down, one reclassified up leaves their trust
where it was (a text-changing edit stamps a row afresh), a lowering a writer set
before 073 is kept (a word off the ladder is replaced), and a text no audit
row vouches for loses its trust with its marks. The read tools print it on
the `By:` line (`not recorded` for none) and put a fixed notice on an ingested
row, before its text — in `search_thoughts`, `search_thoughts_keyword` and
`list_thoughts` a text fenced (every line starts `│`, SMD-2483) and each
metadata value (type, topic, person, action item) on one line (SMD-2510), so
no line of either can forge another row's block or `By:` line; `capture_thought`'s
`trust` declares it, and `min_trust` filters by it (074, 075). test-schema
[66], test-upgrade [20x].

Migration 074 reads it (SMD-1724): `match_thoughts` gains a seventh argument,
`min_trust text DEFAULT NULL`, and `search_thoughts_keyword` a fifth,
`p_min_trust`, each keeping rows whose `metadata.trust` is at or above the word
(operator > agent > ingested; a row with no trust is below every word, so
`ingested` means "labelled"; any other word is refused). The earlier forms are
dropped first and their privileges replayed onto the new ones, as 020 did, so a
six- or four-argument call resolves to the default and is never "not unique".
NULL is the function 041 shipped: every statement it ran runs byte for byte.
A min_trust takes the filtered path whatever the filter, and its statements
stand beside 041's — the gate's sample, a collection by
`thoughts_trust_rank_idx` (a btree over `ob1_trust_rank(metadata->>'trust')`)
alone or beside the GIN index when a filter is given too, and the walk with the
rank inside both candidate scans, EXECUTEd so each call is planned with its
values known (as a static statement it fell to plpgsql's cached generic plan
on a connection's sixth call, a bitmap scan and a sort instead of the walk —
SMD-2468 tracks the same exposure in 041's own walk); the exact answer is
041's over the ids collected. The index is built inside the migrator's
transaction, so writes to `thoughts` wait for it. The hybrid and `search_thoughts_current` call both through their
defaults; 075 gives them the argument. test-schema [67], test-live [21b],
test-upgrade [20y].

Migration 075 carries `min_trust` to the two functions the search tools read:
`search_thoughts_hybrid` and `search_thoughts_current` each gain an 8-argument
form, `(…, half_life_days, min_trust)`, with every argument required — the
hybrid passing it to both arms and its needle probe counting only rows at or
above it, the current read passing it to the hybrid. The 7-argument forms keep
their signatures, defaults and privileges (each new form is created with its
7's) and call the 8 with NULL, so a call is resolved by its count: seven or
fewer to the old form, eight to the new. Not 074's shape (a defaulted argument,
the shorter form dropped): 059's `search_thoughts_current` is `LANGUAGE sql`,
resolved when `--reapply` re-creates it, and a defaulted 8-argument hybrid
beside 027's 7 would make its call "not unique". A call by name that names `min_trust` names
all eight. 075 refuses to apply without 074, and preflight reads the pair by the
7's body. An operator's REVOKE on the 7-argument `search_thoughts_current` does
not survive a `--reapply` (059 drops and re-creates it — as on main), while its
8's does. The server calls the 8-argument forms (and 074's 5-argument keyword)
only for a search that names `min_trust`, so a brain before them answers every
other search. test-schema [68], test-upgrade [20z].

Migration 077 has `prefer_current` read a thought's tickets as well as its own
lifecycle (SMD-2271): `node_state` one hop out. `ticket_references(content,
metadata)` lists the ticket keys a thought names — in its text, and centrally in
`metadata.topics`, `metadata.action_items` or a session summary's header — read
between ASCII lookarounds, which is how JavaScript's `\b` reads them, so the
rule `evals/eval-transitive-freshness.ts` chose (`central+share-veto`, in
`evals/transitive-freshness.ts`) is the same in both languages.
`ticket_references_settled` applies it over 068's ticket heads: an open ticket
named anywhere vetoes; else known central keys decide, all settled; else three or
more known keys in the text, all settled. `search_thoughts_current` demotes a
thought with no lifecycle of its own when it says so — the same weight, once —
and names the deciding keys in `demoted` (`references settled work (SMD-…)`).
Nothing is stored: one ticket's completion moves exactly the thoughts that name
it on the next search and writes none of them. The columns, the 7-argument form
and both forms' privileges are unchanged. Measured on a copy of the dogfood
brain (1,464 thoughts, the panel's 12 queries, 480 interleaved pairs): +5.1 ms
per search (paired median, +6.0 at p90) over 075's 4.5 ms, the hybrid alone
1.7 ms — the references read from each window row's text; `eval-transitive-freshness.ts
--sql-check` held the SQL to the rule on all 1,464 thoughts and the ranking to
its oracle on all 12 queries. test-schema [69], test-upgrade [20aa].

Migration 078 names the server that started a job (SMD-2284): `jobs.door`,
`open-brain` for the MCP server and `open-brain-api` for the REST core, the door
a write through each records as `thought_audit.origin`. A server writes its name
on the jobs it starts and its start-up reconcile marks only those `lost`, so the
two servers on one database leave each other's live jobs alone; before 078 the
one reconcile took every live row. Rows from before it take `open-brain`, the
one serving process then, by the column's default, which also covers a server
from before 078 writing against it. 078 refuses to apply without 069.
test-upgrade [20ab], test-e2e-sql [18], test-rest-sql [9].

Migration 079 never pairs two tickets Linear links for judgement (SMD-2448):
`consolidation_candidates` leaves out a pair filed under two different tickets
that an active Linear link relates in either direction — parent and child,
blocks, relates (053's link rows; neither a text reference nor `duplicate_of`
counts: a duplicate is Linear's own verdict that a ticket no longer holds, the
nearest thing to a supersession the board records, so the judge still sees it).
A thought's ticket is the one `node_state` reads it under,
`coalesce(metadata->>'ticket', metadata->>'issue')` (a ticket's row by its
issue, a dated section filed under it by its ticket), the text exactly; the
predicate is `consolidation_tickets_linked(a, b)`, one definition for the
candidate body, the count and the worker's settle reason. Two linked tickets
are two records whose relationship is already stated, each with its own status;
one "superseding" the other archives a record that still holds. On the stable
dogfood brain 107 of the 128 proposals ever recorded pair two tickets Linear
relates as of 2026-10-04 (94 by relates_to alone), all rejected, and neither
accepted one does. Unlinked tickets stay candidates: the eval's hand-graded
set (`evals/consolidate-labels.json`) holds six real supersessions between two
tickets, a later ticket replacing an earlier one's decision, which the broader
"any two tickets" rule would lose. That corpus carries no links, so it cannot
measure what this narrower rule costs; a decision-replacing ticket filed as
`relates_to` is left out — the residual risk. At the shipped defaults (k 3,
cosine 0.6) a full pass makes 4.1% fewer judge calls (3,435 → 3,293 over
1,241 pooled thoughts); the judge's cost on unlinked ticket pairs is
SMD-1873's. Two rows of one ticket stay candidates, and a
thought with no identity is judged against a ticket row as before.
`consolidation_linked_ticket_pairs_left_out(thought, floor)` counts what the rule
removes for one thought, every other term met; `db/consolidate.ts` turns it
into judge calls fewer at `--k` (a lower bound: a stale pair past the cut is not
counted) — in a run's summary, and in `--status` and `--dry-run` over the
thoughts still to judge (about 6 ms a thought: 7.7 s over the dogfood's whole
pool) — and settles a stale proposal on two linked tickets naming the rule. Nothing
is stored: a link written or closed moves the rule at the next pass. The body
carries `ob1:linked-tickets-not-paired`, which the worker reads before it
reports the rule and preflight's `lineage` check reads to warn naming 079 when
063 or 066 is re-applied by hand over it. Not taken: matching a ticket id in
free text — on the 128 it would leave out 11 more pairs, one of them accepted.
test-schema [70], test-live [16], test-upgrade [20ac].

Migration 080 has a capture-only key's re-capture leave the row it lands on
(SMD-2539). Text that is already a thought lands on the row holding it, and
before 080 that path merged the payload's metadata over the row's — the
caller's keys and `metadata.source` — appended an update event in the caller's
name and moved `updated_at`: a capture key that could guess another key's text
could relabel that thought — the label a `source:` egress term gates the passes
on (SMD-1941). All three `upsert_thought` forms now read `p_payload.recapture`.
`'keep'`, which the server sends for a key that cannot read (the capture
scope), leaves an existing row as it is: no metadata merge, no event, no
`updated_at`, no vector refresh, no window written or dropped. The one write is
a vector onto a row that has none — an update event carrying the vector's
presence alone, the row's metadata on both sides and nothing declared — so
`updated_at` moves and the audit row names the capture key; no windows are
written, and windows such a row holds go by 022's rule unless its label is the
vector's. Absent, a JSON null or `'merge'` is the merge as before, which a write
key keeps (it holds `update_thought` anyway); any other value is refused. A
fresh text is captured as before, and the return keeps its keys, so the
session hook still gets the id it supersedes its own summary with. 080 carries
073's 2- and 3-argument bodies and 061's 4-argument one, each with
`ob1:recapture-keep-leaves-the-row`, which preflight's `atomic capture` check
reads to warn naming 080 when 073 or an earlier file is re-applied by hand over
it. It refuses to apply without 060, 061 or 073. The fix needs this file and a
server that sends the word: either alone, a capture key's re-capture merges.
test-schema [71], test-upgrade [20ad], test-e2e-sql [13c].

Migration 082 has a capture-only key's thought stop being its own once
another key or board-sync takes it, lapses a pointer the key had already
written onto it, and re-checks the key's pointer at its own write (SMD-2638).
A capture-only key may set `supersedes` only on a thought it captured
(SMD-2473), and capturing a text first was enough: a write key that later
captured the same text landed on that row, board-sync adopted a row holding a
ticket's text, and the capture key could still mark it superseded. One rule,
`ob1_takes_thought`, says when an update event takes a thought from the agent
that captured it — someone else then holds the text: another agent, or none,
that records a re-capture or moves the text, or no agent giving the metadata
an `issue` it lacked (board-sync's adoption, which writes without one). A
key's metadata edit does not take it, whatever it adds — a writer's tag, a
writer filing it under a ticket, `backfill_thought_actors` (which this README
tells operators to run after `set_agent_kind`), a recipe — nor does a
vector, a pointer or a fingerprint: a lapse puts a summary the hook superseded
back to current, so only a write that puts another's text on the row may
cause one. `ob1_thought_taken` reads the rule for one thought; the server reads
it beside the capture row for every target of a capture-only key's
`supersedes`. A write key's re-capture that changes nothing writes no event, so
the stores call `ob1_note_recapture` after a capture without `recapture: 'keep'`
lands on an existing row: when the row's capture row says it was a
capture-only key's (`actor_context` `"scope": "capture"`, which the server
writes from SMD-2638 on), the row is not yet taken and the caller is another
agent, it appends one update event, diff `{"recaptured": true}`, and projects
it (only `updated_at` moves); any other row is left as 060 leaves it. The
lapse, an AFTER INSERT trigger on `thought_audit`, clears the pointer onto a
taken thought of each thought its capturer captured with that pointer under
the capture scope and no update has re-pointed since — an update event of its
own under the actor of the write that took the target. The check at the
write, a second AFTER INSERT trigger on a capture-scoped capture event that
names `supersedes`, takes an advisory lock on the target (two such captures
naming one target are serialised), locks it `FOR SHARE` (which waits for any
taker) and refuses the capture, SQLSTATE `OB004`, when it names no agent or the
target is another's, taken, or already superseded; the server drops the
pointer and writes again. One superseder per target bounds a lapse to one
event. A pointer a write key set never lapses; a pointer written before the
server sent the scope mark never lapses, and a capture-only key's row from
before then is never noted. Apply it before running the server that reads it: without
`ob1_thought_taken` every capture-only key's `supersedes` is the server's error
to retry. It refuses to apply without 060 or 061. test-schema [72],
test-upgrade [20ae], test-e2e-sql [13b] and [13e].

Migration 085 has a capture-only key's stamp yield to the first classified
key that can read to re-capture the text, at a higher trust (SMD-2664). A
capture-only key may declare a trust below its kind — the Chrome extension
labels every capture `ingested` — and when a write key later captured the
same text, the capture landed on that row and 050's same-text rule kept the
capture key's `actor_kind`, `actor_name` and `trust`: the writer's thought
dropped out of every `min_trust` read above `ingested` and carried the
outside-text notice. The stores now call `ob1_restamp_recapture` after
`ob1_note_recapture`, when a capture without `recapture: 'keep'` lands on an
existing row. It moves nothing unless the row's stamp is still a
capture-only key's: its capture row carries 082's `"scope": "capture"` mark,
and no update since has changed the text (by 003's fingerprint) or
restamped it. A lowering by a key that can read — the operator's own
`ingested` — stands under 050's rule. An unclassified writer, or a call with
no actor, moves and records nothing. A classified writer is weighed: the
stamp the write would have put on a new text — the key's kind, and the
trust the write declared when that is lower — against the row's (operator >
agent > ingested > none). Higher, it appends one update event moving the
whole stamp to the writer, `"restamped": true` in its diff; not higher, it
records the decline, `{"restamp_declined": true}`, once per agent. Either
event moves `updated_at`, as the note does. A decline by another agent
settles the row against every other agent: the operator's equal
`ingested` re-capture of a capture key's outside text is not undone by an
agent key's re-send after it. The same agent's own later landing may still
move it; "the same" is by agent id, so a decline naming none — a name-only
writer: board-sync, or any key while its registry lookup fails, through an
outage or a misconfiguration, or is refused — settles the row for every
caller. The record
is the restamp's own, not 082's note, which is also written for landings
that can move nothing and skipped on rows 082 counts as taken. The first
classified writer settles the row whatever it declared: an agent key
declaring `ingested`, or an `ingested`-kind key, landing first leaves the
capture key's stamp and refuses the operator after it — trust kept low, the
direction a label may err in. So when a capture-only key captured a text first, the first
classified key that can read to capture it after leaves the higher of
their two trusts, and once moved, no later re-capture moves it. A
capture-only actor restamps nothing, and nor does a call whose fingerprint
is no longer the row's (the text moved since the capture). A metadata edit
still keeps the stamp, board-sync's metadata patch adopting a row in place
included. `backfill_thought_actors` now reads a restamp with no
text-writing row after it, by `seq`, as the row's writer, so a pass after a
restamp — run after `set_agent_kind`, as above — keeps the stamp rather than
putting the lower one back; a key reclassified down still takes its rows
down.

For an operator upgrading to 085: a stamp kept by a re-capture before 085
moves at the next re-capture by a classified key that can read at a higher
trust, whichever key 082 noted; a capture-only key's row from before the scope mark — every capture a
server before 082 wrote, the Chrome extension's pages included — stays as it
is. Only a classified key is weighed, and a re-capture made while a key was
unclassified is not replayed when it is classified: classify write keys
(`set_agent_kind`) before relying on this. A label settled by another key's
decline, or a name-only one, or moved by the wrong key, is the operator's to
reset since 086 (below). The settled rows are those with a decline in the log —
`SELECT DISTINCT thought_id FROM thought_audit WHERE diff ? 'restamp_declined'`,
`AND canonical_agent_id IS NULL` for the name-only ones. `thought_changes`
reads a restamp as "re-captured … the label moved to this key" and a decline
as "re-captured … the label kept". It refuses to apply
without 055, 060, 073 or 074. test-schema [75], test-upgrade [20ag],
test-store-sql and test-store-postgrest [8d], test-e2e-sql [13f].

Migration 086 is the operator's way out of a label 085 settled or moved
(SMD-2744). Under 085 the first classified key that can read to re-capture a
capture-only key's text moves the label or declines it, and either settles
the row against every other key — so a label could stick where the operator
holds it wrong: another key reached the row first, or a name-only decline
was written while the registry lookup failed. Nothing short of a text edit
or a delete and re-capture undid it. `ob1_reset_capture_stamp(id, actor)`,
which the server's `reset_capture_stamp` tool calls, refuses (`NOT_OPERATOR`)
any actor that is not a key the registry classifies `operator` — by its
agent id, else its name, the lookup the audit row's `actor_kind` is made
by — and any capture-only actor. It refuses (`NOT_CAPTURE_STAMP`) a row
whose label 085 does not move: no `"scope": "capture"` mark on its capture
row. A row with nothing settled since its latest reset is left alone
(`reset: false`), and one whose text was changed since its capture is
refused (`NOT_CAPTURE_STAMP`). Otherwise the declines and the restamp since
the latest reset no longer count: one update event, its diff
`{"restamp_reset": true}`, in the operator's name, and, where a restamp moved
the label, the metadata with `actor_kind`, `actor_name` and `trust` derived
from the capture row exactly as `backfill_thought_actors` derives a
capture's — the trimmed name, the registry's kind for it now, the trust the
capture recorded (or the claim it filed) under that kind, lowered by the
stamp the restamp found and never raised — every other key as the row holds
it, so a pass after the reset finds nothing to change. The answer names the
keys whose restamp and declines it undid, which may be the operator's own.
The next classified key that can read to re-capture the text is weighed
again, so the operator re-captures it straight after — the text as stored,
not `fetch`'s, which shows an outside text under a notice line: plainly, and
the label moves to its key; declaring `ingested`, and a label at `ingested`
or `agent` stays as it is and the row is settled again against every other
key (the operator's own later plain re-capture still moves it), while a
label with no trust moves to the operator's key at `ingested`. An
agent key landing in between is weighed first. `ob1_restamp_recapture` is
085's body reading the declines and the restamp after the latest reset, and
`backfill_thought_actors` 085's body with a reset among its candidate rows:
a restamp with a reset after it is no writer, and the capture is the writer
again. It refuses to apply without 046 or 085. test-schema [77],
test-upgrade [20ah], test-store-sql [8e], test-store-postgrest [8g],
test-e2e-sql [13g].

Migration 087 adds `board_findings_posted`, what board-sync's findings step
posted to the Linear board (SMD-2681): one row per ticket pair and word —
the pair in order by 079's ticket identity, the word (`outdates`, `related`,
`evolves`, `duplicate`), the ticket commented on, Linear's comment id, and the
proposal and relation-facet ids it named. `origin` is `posted`, counted
against the daily cap, or `found`, a marker already on the board. Rows are
only inserted — a posted one after Linear answers, in the transaction that
posted — so a failed post records nothing. It needs nothing before it. See
[What it tells the board](#the-board-in-the-brain-smd-1954). test-schema [78],
test-upgrade [20ai], test-live [41].

## What changed relative to the guide

Four deliberate differences. Each is a portability fix, not a behaviour change.

**Indexes are named.** The guide writes `create index on thoughts …`, letting
Postgres auto-assign names — which cannot be made idempotent. The names used here
(`thoughts_embedding_idx`, `thoughts_metadata_idx`, `thoughts_created_at_idx`) are
exactly what Postgres would have chosen, so a database built from the guide already
satisfies them and will not grow duplicates.

**`IF NOT EXISTS` throughout.** The guide's step 2.6 is unguarded, so applying core
setup and then `recipes/content-fingerprint-dedup` — which ships the same DDL —
fails on both the `ALTER TABLE` and the `CREATE UNIQUE INDEX`.

**The RLS policy is dropped.** The guide enables row-level security on `thoughts`
with `USING (auth.role() = 'service_role')`. Both halves are Supabase-managed:
`auth.role()` comes from GoTrue and `service_role` is a Supabase role. Neither
exists elsewhere. It also never did anything — the service role has `BYPASSRLS`,
so the policy never evaluated. Re-add real RLS against your own claim if you
introduce multi-tenancy; do not port this one.

**No `GRANT … TO service_role`.** Grant to whichever role your application
connects as — and to more than `thoughts`: see [Grants for a capturing
role](#grants-for-a-capturing-role) below. The community schemas under
`schemas/` carried the same grants, and RLS with a policy for that role, until
change 93 (SMD-1796) cut them; the extension and recipe schemas carried them
too, with per-user policies on `auth.uid()`, until SMD-1810. Their tables are
the **community**, **extensions** and **recipes** groups there.

## Grants for a capturing role

Every function this fork adds is `SECURITY INVOKER` — the policy migrations 010,
012 and 015 state, and the default the capture writers in 005/007/008/022/025
rely on — so the writes they make run as the connecting role, and since migration
007 they reach past `thoughts`. A role granted `SELECT, INSERT, UPDATE, DELETE ON
thoughts` and nothing else, as the getting-started guide's grant step gives, can
capture nothing on a self-hosted brain: its first windowed capture fails on
`thought_chunks`, and 008's audit trigger fails on `thought_audit` on its very
first capture of any kind. (Supabase is unaffected — its `service_role` holds
default privileges on the public schema, which is why the hosted path never hits
this.)

`db/config.mjs`'s `ROLE_GRANTS` is the machine-readable list; this table is the
same one, grouped by what the role does. Preflight's `write privileges` check
refuses a server role missing any of the **capture** group; `migrate.ts --grant`
issues every group at once, or with `--groups capture,worker,…` those alone
(SMD-2289). `--groups` grants less and revokes nothing; `--exact` adds the
revoke, in the grant's own transaction: a member of another role or an owner
of anything is refused, then what an ACL grants the role on a
table or column, a sequence or a routine, and CREATE on a schema or the
database, go (schema USAGE, CONNECT and TEMP stay); it is refused if it still
holds anything else (named by catalog and database); then the groups are
granted, so what it holds here is theirs. Every `--grant`, and `login-role.ts`,
holds one advisory lock, so two at once in one database queue. `db/login-role.ts --role <name> --password-env <VAR>`
creates or updates the LOGIN role itself (not a superuser, owning nothing,
a member of no role, its settings in every database cleared; refused if one
survives, as a setting only a superuser may reset does a migrator that is not),
its password sent as a SCRAM verifier, for a compose service that connects as
a role of its own: the orchestration runner's `ob1_orchestration_runner`
holds capture, worker, structure and extraction, what its ingester
and reembed run (measured), and not the server group, whose writes to
`ob1_agent_keys` could clear a key's revocation. `login-role.ts` refuses a
role that is a superuser, a member of another role or the owner of anything,
or whose name a schema here bears (first on its search_path), and `--exact` one still holding a privilege it cannot revoke (a default
privilege naming it, a grant in another database). Under that role the `ANALYZE
thought_work_claims` that reembed and 015's `enqueue_thoughts` run (the
owner's to run) is skipped: Postgres warns, the client does not print it, and
autovacuum keeps the claim table's statistics. The worker group's `UPDATE` on
`ob1_config` covers the whole table, the event log's ordering key among its
rows, as it does for every worker; narrowing it would take row-level policy.

| Group | Object (migration, or `schemas/` file) | Privileges |
| --- | --- | --- |
| **capture** — the server's own connection; preflight refuses a role missing any of it | `thoughts` (001) | `SELECT, INSERT, UPDATE, DELETE` |
| | `thought_chunks` (007) | `SELECT, INSERT, DELETE` |
| | `thought_audit` (008) | `SELECT, INSERT` — since 055 `ob1_append_thought_event` reads the row it inserts (`INSERT … RETURNING`), and since 060 the audit trigger's check and the projector read the event; the row lacked `SELECT` from 055 to 058 (SMD-2116) |
| | `thought_facets` (042) | `SELECT, UPDATE` — the delete guard reads the citations that name a thought and, detaching, writes them, on every delete |
| | `ob1_agents` (046) | `SELECT` — the audit trigger reads the key's kind on every write that carries an actor (SMD-1730) |
| | `ob1_embedding_snapshot` (060) | `SELECT, INSERT, UPDATE` — the snapshot trigger upserts the row's vector under its key on every write of a vector, a label or a key (SMD-2116). `ob1_project_thought_event` and `ob1_refresh_thought_vector` keep PUBLIC's EXECUTE, as the SECURITY INVOKER writers that call them require; the audit trigger holds what either may do, and a replay is the owner's |
| | `derivations` (061) | `SELECT, INSERT, UPDATE, DELETE` — the vector lineage trigger upserts the vector's row (and deletes it when the vector is cleared) on every write; the write functions upsert the windows' and the tags' rows and delete a replaced set's; `record_thought_entities` and `record_supersession_proposal` write theirs as the caller too, so the workers' role reads the same row (SMD-1731) |
| | `ob1_ticket_head` (068) | `SELECT, INSERT, UPDATE, DELETE` — 068's triggers reconcile the node_state projection as the writer on a write that moves an issue key, a ticket's status or watermark, or a `supersedes` pointer, and `node_lifecycle()` reads it (SMD-2256); a plain capture never touches it |
| | `ob1_superseded_by` (068) | `SELECT, INSERT, UPDATE, DELETE` — the same triggers, and `node_state()`'s `superseded_by` (SMD-2256) |
| | `ob1_source_gate` (071) | `SELECT, INSERT, UPDATE, DELETE` — 071's triggers keep node_state's gate as the writer on a source row's write (a delete of a sourced thought included, through its cascade) and on a status move between a known and an unknown `status_type`, and `node_dependencies()`' gates and the dependency columns read it (SMD-2267); a plain capture, an edit that moves no status and a delete of an unsourced thought never touch it. |
| **server** — the server's soft extras, beyond capture; never fatal to a bare capture (the `SELECT` on `ob1_agents` 046 made hard is in capture, above), but `resolve_agent` *upserts* the agent tables, so attribution needs the writes, not just `SELECT` | `ob1_config` (006) | `SELECT` |
| | `ob1_agents` (010) | `SELECT, INSERT, UPDATE` |
| | `ob1_agent_keys` (010) | `SELECT, INSERT, UPDATE` |
| | `thought_sources` (053) | `SELECT` — `search_thoughts`' opt-in `prefer_current` runs 059's wrapper, which at 059 read the source rows through 058's node_state (SMD-2255); since 068 its columns come from the projection and on PostgreSQL 16 and 17 it runs without this (a removed join's tables go unchecked — observed, not documented), so keep it |
| | `thought_audit` (008) | `SELECT` — a capture-only key may supersede only a thought whose capture row is its own (SMD-1298); without this the server refuses that pointer and names the grant; `thought_changes` (052, SMD-1296) reads the log for the MCP tool of the same name, and names the grant too |
| | `supersession_proposals` (029) | `SELECT` — `brain_info` (so keyed `/health` and `GET /v1/brain`) counts the proposal queue, `list_supersession_proposals` lists it, and preflight's `proposals` row reads it; without it `brain_info` reports the queue unread and preflight's `proposals` row names this grant (SMD-2680). The writes stay the worker group's. A role granted before SMD-2680 needs `--grant` again |
| **worker** — `reembed.ts`, `consolidate.ts`, `extract-entities.ts`: claim work, upsert a job key into `ob1_config` (and a long-running worker's heartbeat, `heartbeat:…` — `sync-linear.ts --loop` and the followers, SMD-2261), and (consolidate) record/resolve proposals — a consolidation role holds `--groups capture,server,worker,extraction,structure`: capture's reads and row locks, server's agent registration for the worker key, extraction's entity reads, structure's relation writes (SMD-1873) | `thought_work_claims` (015) | `SELECT, INSERT, UPDATE, DELETE` |
| | `ob1_config` (006) | `SELECT, INSERT, UPDATE` — the read too: reembed reads the model and its job keys, and a role given this group should not need the server group's key writes for it (SMD-2289) |
| | `supersession_proposals` (029) | `SELECT, INSERT, UPDATE` |
| | `ob1_embedding_snapshot` (063) | `DELETE` — `rebuild_derived`'s forget arm removes the snapshot rows at a leaving thought's fingerprints (SMD-1732); `rebuild.ts` and, later, SMD-1723's forget run it. Here and not in capture, so no server role granted before 063 fails preflight over it |
| | `schema_migrations` (the migrator's ledger, before 001) | `SELECT` — `reembed.ts` reads it on every start to name the migration a brain lacks; without it every pass under a `--grant` role stopped at "permission denied" (SMD-2289, measured as the orchestration runner's role) |
| **extraction** — the entity-extraction worker, and a structured pass for its `source:` mentions, additionally | `ob1_entities` (016) | `SELECT, INSERT, UPDATE, DELETE` |
| | `thought_entities` (016) | `SELECT, INSERT, UPDATE, DELETE` — `UPDATE` for 016's `merge_entities`, and since 053 for `record_thought_entities`, which upserts (`ON CONFLICT DO UPDATE`): Postgres checks it for every call, conflict or none, so until SMD-2216 a `--grant` role could not record a mention |
| | `ob1_entity_edges` (016) | `SELECT, INSERT, UPDATE, DELETE` — `UPDATE` for the same upsert, since 053 |
| **structure** — a structured pass (`sync-linear.ts`, an ingest adapter's structure step), additionally: the source row and its links (SMD-2216); `graph-centrality.ts --startable` and `--decay-blocked` read the source rows too, through 058's `node_state()` | `thought_sources` (053) | `SELECT, INSERT, UPDATE, DELETE` — `record_thought_source` upserts the row, and on a take deletes the old holder's |
| | `thought_facets` (053) | `INSERT` — `record_source_links` adds `link` facets, and since 084 `consolidate.ts`'s `record_thought_relation` adds `relation` facets (a consolidation role holds this group for them; without it the pass stores no relations and says so, SMD-1873). Postgres grants INSERT per table, so this group writes any facet kind — links, citations and relations alike; capture's `SELECT, UPDATE` cover the reads and the closing |
| | `board_findings_posted` (087) | `SELECT, INSERT` — board-sync's findings step (`board-findings.ts`, SMD-2681) reads it for the daily cap and to post nothing twice, and inserts a row per ticket pair and word after Linear answers |
| | `supersession_proposals` (029) | `SELECT` — the proposal queue the findings step posts from (the server group holds it too, but with it UPDATE on `ob1_agent_keys`) |
| **querylog** — the opt-in query log (`OB1_QUERY_LOG=on`, off by default, SMD-1295); the server writes it only when enabled, and only inserts | `query_log` (034) | `INSERT` |
| **jobs** — the durable async job registry (069, SMD-2318): the server writes a row per long-running job as the in-memory registry moves it along (INSERT on start, UPDATE on each state change, SELECT for the poll's read-back after a restart or an eviction), and the owner or a scheduler prunes terminal rows with `prune_jobs` (DELETE). Soft like the query log — without it the async handles fall back to the in-memory registry (SMD-2273), so a role missing it is not refused, only less durable | `jobs` (069) | `SELECT, INSERT, UPDATE, DELETE` |
| **pages** — the page store (064, SMD-1812): a role that writes pages through `upsert_page`, `write_page_section`, `accept_page_section`, `reject_page_section`, `release_page_section`, `lock_page_section` and `delete_page_section` (SECURITY INVOKER; PUBLIC's EXECUTE, as every core function) — beside `capture`, since a page is a thought and the store writes it through `upsert_thought` / `update_thought` and records lineage in `derivations`. A page's rows go with its thought's delete, whose cascade runs as the owner | `pages` (064) | `SELECT, INSERT, UPDATE` |
| | `page_sections` (064) | `SELECT, INSERT, UPDATE, DELETE` — `delete_page_section` deletes the row as the caller |
| | `page_section_revisions` (064; append-only — UPDATE, a DELETE while the section stands, and TRUNCATE refused by trigger for the owner too, so only a section's cascade removes its rows; the identity `seq` needs no sequence grant, test-schema [59]) | `SELECT, INSERT` |
| **community** — the schemas under `schemas/`, applied by hand beside the migrations (SMD-1796). Upstream's files granted these to Supabase's `service_role` and enabled RLS with a policy for it; neither exists off Supabase, so the files grant nothing now and this group does — the privileges upstream gave its service role, plus what Supabase's default privileges hid: `USAGE` on a `BIGSERIAL` column's sequence, and `EXECUTE` on a function `REVOKE`d `FROM PUBLIC`. Issued for whichever files you have applied; the rest are skipped and named | `thought_audit` (schemas/thought-audit — 008's table; upstream's `SELECT, INSERT`, kept) | `SELECT, INSERT` |
| | view `thought_provenance` (schemas/thought-audit, `author-session-id.sql` — a view over `thoughts`, which needs its own `SELECT`) | `SELECT` |
| | `agent_memories`, `agent_memory_source_refs`, `agent_memory_artifacts`, `agent_memory_relations`, `agent_memory_review_actions`, `agent_memory_recall_traces`, `agent_memory_recall_items`, `agent_memory_audit_events` (schemas/agent-memory) | `SELECT, INSERT, UPDATE, DELETE` |
| | `openbrain_agents`, `agent_memory_keys` (schemas/per-agent-identity) | `SELECT, INSERT, UPDATE, DELETE` |
| | function `lookup_agent_memory_key(text)` (schemas/per-agent-identity; SECURITY DEFINER, `REVOKE`d `FROM PUBLIC`) | `EXECUTE` |
| | `ingestion_jobs`, `ingestion_items` (schemas/smart-ingest) | `SELECT, INSERT, UPDATE, DELETE` |
| | sequences `ingestion_jobs_id_seq`, `ingestion_items_id_seq` (schemas/smart-ingest; `BIGSERIAL` ids) | `USAGE, SELECT` |
| | function `append_thought_evidence(uuid, jsonb)` (schemas/smart-ingest; SECURITY DEFINER, `REVOKE`d `FROM PUBLIC`; the bigint form, dropped by the file since SMD-2128, loses its grant — run `--grant` again) | `EXECUTE` |
| | `entities`, `edges`, `entity_extraction_queue`, `consolidation_log` (schemas/entity-extraction — upstream's tables, not 016's `ob1_*`) | `SELECT, INSERT, UPDATE, DELETE` |
| | `thought_entities` (schemas/entity-extraction names 016's table under `IF NOT EXISTS`; the **extraction** row's privileges exactly, so the merge widens nothing) | `SELECT, INSERT, UPDATE, DELETE` |
| | sequences `entities_id_seq`, `edges_id_seq`, `consolidation_log_id_seq` (schemas/entity-extraction; `BIGSERIAL` ids) | `USAGE, SELECT` |
| | `thought_edges` (schemas/typed-reasoning-edges) | `SELECT, INSERT, UPDATE, DELETE` |
| | sequence `thought_edges_id_seq` (schemas/typed-reasoning-edges; `BIGSERIAL` id) | `USAGE, SELECT` |
| | function `thought_edges_upsert(uuid, uuid, text, numeric, integer, text, timestamptz, timestamptz, jsonb)` (schemas/typed-reasoning-edges; `REVOKE`d `FROM PUBLIC`) | `EXECUTE` |
| | `crm_persons`, `crm_person_mentions` (schemas/crm-person-tiers) | `SELECT, INSERT, UPDATE, DELETE` |
| | `readwise_books` (schemas/readwise-books — upstream granted the table nothing; its integration wrote it through Supabase's default privileges) | `SELECT, INSERT, UPDATE, DELETE` |
| | functions `merge_thought_provenance_metadata(uuid, jsonb)`, `merge_thought_eval_metadata(uuid, jsonb)` (schemas/provenance-chains; SECURITY DEFINER, `REVOKE`d `FROM PUBLIC`) | `EXECUTE` |
| **extensions** — the learning path's six `extensions/*/schema.sql`, applied by hand as each README's Step 1 says (SMD-1810). Upstream's five with policies enabled RLS on `auth.uid() = user_id` and granted nothing — Supabase's default privileges carried its service role — and family-calendar's carried neither; the policies are gone, and this group is what a role other than the tables' owner needs. Every id is a `uuid` (no sequences) and no function is `REVOKE`d `FROM PUBLIC` | `household_items`, `household_vendors` (extensions/household-knowledge) | `SELECT, INSERT, UPDATE, DELETE` |
| | `maintenance_tasks`, `maintenance_logs` (extensions/home-maintenance) | `SELECT, INSERT, UPDATE, DELETE` |
| | `recipes`, `meal_plans`, `shopping_lists` (extensions/meal-planning) | `SELECT, INSERT, UPDATE, DELETE` |
| | `professional_contacts`, `contact_interactions`, `opportunities` (extensions/professional-crm) | `SELECT, INSERT, UPDATE, DELETE` |
| | `family_members`, `activities`, `important_dates` (extensions/family-calendar — upstream's file carried no RLS and no grant; listed so the whole path is one grant) | `SELECT, INSERT, UPDATE, DELETE` |
| | `companies`, `job_postings`, `applications`, `interviews`, `job_contacts` (extensions/job-hunt) | `SELECT, INSERT, UPDATE, DELETE` |
| **recipes** — the nine recipe SQL files a brain applies as a schema (tables or views; `CONTRIB_SCHEMA_FILES` in `db/test-support.ts`), applied by hand as each README says (SMD-1810). Upstream granted most of these to `service_role` (adaptive-capture's four to `authenticated`; lint-sweep's views nothing), enabled RLS on most with policies on `auth.uid()`, and `REVOKE`d ob-graph's three functions from `anon` and `authenticated`; all cut, the REVOKEs too (none is SECURITY DEFINER, and there is no PostgREST here to expose them), so EXECUTE stays PUBLIC's and no function row is needed. Every id is a `uuid` or text: no sequences. The privileges are upstream's own for its roles | `correction_learnings`, `classification_outcomes`, `capture_thresholds`, `ab_comparisons` (recipes/adaptive-capture-classification — upstream's three privileges to its API role, kept; the recipe deletes nothing) | `SELECT, INSERT, UPDATE` |
| | views `ops_source_volume_24h`, `ops_recent_thoughts`, `ops_enrichment_gaps`, `ops_type_distribution`, `ops_sensitivity_distribution`, `ops_ingestion_summary`, `ops_stalled_entity_queue`, `ops_graph_coverage` (recipes/brain-health-monitoring, its `ops-views.sql`; the last three exist only where smart-ingest and entity-extraction are applied, and are skipped until then) | `SELECT` |
| | `chatgpt_conversations` (recipes/chatgpt-conversation-import; `user_id` is a plain nullable `uuid` now — upstream's referenced `auth.users`) | `SELECT, INSERT, UPDATE, DELETE` |
| | `life_engine_habits`, `life_engine_habit_log`, `life_engine_checkins`, `life_engine_briefings`, `life_engine_evolution`, `life_engine_state` (recipes/life-engine) | `SELECT, INSERT, UPDATE, DELETE` |
| | views `lint_orphans_by_tag`, `lint_over_tagged`, `lint_empty_content`, `lint_very_long`, `lint_low_signal`, `lint_exact_duplicates`, `lint_high_importance_isolated` (recipes/lint-sweep, its `views.sql`; the last two are guarded on `content_fingerprint` and `thought_entities`, both the migrations', so all seven exist on a migrated brain) | `SELECT` |
| | `graph_nodes`, `graph_edges` (recipes/ob-graph) | `SELECT, INSERT, UPDATE, DELETE` |
| | `repo_learning_projects`, `repo_learning_research_documents`, `repo_learning_tracks`, `repo_learning_lessons`, `repo_learning_quizzes`, `repo_learning_quiz_questions`, `repo_learning_lesson_progress`, `repo_learning_quiz_attempts`, `repo_learning_quiz_responses`, `repo_learning_lesson_comments` (recipes/repo-learning-coach) | `SELECT, INSERT, UPDATE, DELETE` |
| | `operating_model_profiles`, `operating_model_sessions`, `operating_model_layer_checkpoints`, `operating_model_entries`, `operating_model_exports` (recipes/work-operating-model-activation; its three functions keep PUBLIC's EXECUTE — upstream only granted them to its service role) | `SELECT, INSERT, UPDATE, DELETE` |
| | `world_model_assessments`, `world_model_boundary_flows` (recipes/world-model-diagnostic-activation, its `schema-v2-draft.sql` — a draft its README's V1 does not apply; listed so applying it is one `--grant` away) | `SELECT, INSERT, UPDATE, DELETE` |

Plus `USAGE ON SCHEMA public`, and the right to create a temp table:
`record_thought_entities`, `record_source_links` and `apply_entity_type_gate()`
stage their rows in `ON COMMIT DROP` temp tables, so a database that has revoked
`TEMPORARY` from `PUBLIC` (the default grants it) needs `GRANT TEMPORARY ON
DATABASE … TO your_role` as well — `--grant` does not issue it. The migrations'
own tables need no sequence grant — every primary key is a `uuid` or a natural
key — but three community schemas use `BIGSERIAL` ids, and an `INSERT` into such
a table needs `USAGE` on the sequence (`permission denied for sequence …` with
the table fully granted),
so the **community** group names those six sequences; an identity column
(064's `page_section_revisions.seq`) needs none. Both are measured, not recalled:
test-schema [40] grants the tables alone and watches which inserts are still
refused, and [59] inserts a revision under the `pages` group with no sequence
granted. Functions are executable by `PUBLIC` by default, so only the community
functions upstream `REVOKE`d `FROM PUBLIC` — the SECURITY DEFINER ones — are
listed, for `EXECUTE`; the rest (the brain-stats, enhanced-thoughts,
readwise and CRM RPCs) need nothing. `ob1_config` appears twice — `SELECT` for
the server's own read, `SELECT, INSERT, UPDATE` for a worker's job key — as does
`thought_audit` (`INSERT` for the capture path, upstream's `SELECT` beside it),
and `--grant` merges each into one `GRANT`. A view is granted as a table is,
and needs it: a role's `SELECT` on `thoughts` does not reach a view over it.

The one executable spelling — run as a role that can grant (the tables' owner or
a superuser), after the migrations are applied:

```bash
bun migrate.ts --url ... --grant your_role
```

`--grant` issues exactly the list above for the tables, views, sequences and
functions that exist, in one transaction — and before committing it asks the
catalog whether the role now holds each privilege, because a grantor that holds
a privilege without grant option "grants" it with only a warning and no effect;
if anything is not held it rolls back, names the privileges, and says to connect
as the objects' owner or a superuser; it never creates the role or sets a password, so
create the role first. `--grant --dry-run` prints the statements without running
them, so a locked-down deployment can grant a subset by hand; with `--exact` it
runs the revokes, the check and the grants in a transaction it rolls back, so it
needs the privileges a real run does and shows what that run would refuse. A role that only
ever runs the server needs the **capture** and **server** groups; add **worker**
for the role your bulk passes connect as, **extraction** on top of that for
entity extraction, **structure** as well for a structured pass, and **pages**
for a role that writes pages (064). The
**community**, **extensions** and **recipes** groups are issued for whichever
schema files you have applied — the objects not yet present are skipped and
named, so run `--grant` again after applying one; apply
a schema with `psql "$DATABASE_URL" -f <its path>`, as its README says. Presence is
per object, not per file, so the two community rows whose tables a migration
also creates — `thought_audit` (008) and `thought_entities` (016) — are issued
on every migrated brain: the audit row adds only upstream's `SELECT` on the
log, and the mention row is the **extraction** row's privileges again, so
neither widens what a brain without the file already grants. The
**querylog** group is issued too, so `OB1_QUERY_LOG=on` works out
of the box — but unlike the capture set it is not enforced: the query log is off
by default and preflight cannot read a server env flag, so a role missing
`query_log` `INSERT` is reported by the `query log` check, not refused (the log's
write is best-effort and never fails a search).

**One cross-cutting exception (016's enqueue trigger).** Migration 016 adds a
trigger on `thoughts` that fires on every capture and content-edit and runs as
the calling role. It **reads `ob1_config`** first, always — so on any brain at
016 or later, `SELECT` on `ob1_config` (the `server` group) is a *hard*
capture-path requirement, not a soft extra: a role without it fails every capture
in the trigger. And once entity extraction is enabled (`extract-entities.ts` sets
`ob1_config.entity_extraction_key`), the trigger also **upserts a
`thought_work_claims` row** — so the server role then needs `INSERT, UPDATE` on
`thought_work_claims` too, even though it runs no worker. Preflight's `write
privileges` check detects the trigger (and reads the key) and enforces exactly
these when they apply, so the gap surfaces at start-up rather than on the first
capture. The simplest answer is to grant the server role the **worker** group as
well on an extraction brain.

**Another cross-cutting exception (055's capture read).** Migration 055 (SMD-2115)
makes the write functions read `thought_audit` — they append the capture event and
derive its diff before the row exists — so from 055 on a capturing role needs
`SELECT` on `thought_audit`, not only the `INSERT` the capture path always had.
`--grant` issues both, but a role provisioned by `--grant` **before** 055 was
granted only the `INSERT`: **after upgrading a brain past 055, run
`bun migrate.ts --grant <role>` again for every role that captures, or its writes
fail on the audit table's `SELECT`.** The role `migrate.ts` and the reference
deploy connect as is the objects' owner, which holds it already — only a
separately `--grant`-provisioned scoped role is affected.

**And 061's lineage writes.** Migration 061 (SMD-1731) adds `derivations`, which
the vector-lineage trigger and the write functions upsert **as the caller on
every capture and edit** — and `ob1_record_derivation`'s `INSERT … RETURNING`
needs the `SELECT`, 055's trap again. A role provisioned by `--grant` before 061
holds no privilege on it, so **every capture and every content edit fails
inside the trigger — a vectorless capture too, since the trigger drops the
vector's row when none is carried: after upgrading a brain past 061, run `bun
migrate.ts --grant <role>` again for every role that captures or runs a
worker.** Preflight's
`write privileges` row names the table until it is granted.

## Chunk context, and why it is off

Migration 013 adds `thought_chunks.context`: a short generated blurb naming what
a window is about, prepended to it before embedding. It is Anthropic's Contextual
Retrieval, and `OB1_CHUNK_CONTEXT` defaults to **off** because it was measured
rather than adopted.

`evals/eval-contextual.ts` scores it over the 15 documents in the 441-issue
corpus that reach the chunking threshold, using 37 queries that name a document's
subject and ask for a detail living in exactly one window — the query the
technique exists for, and one a title-as-query benchmark cannot pose. Against the
bare windows the server stores today, on the default `qwen3-embedding:4b`:

| arm | MRR | helped | hurt |
| --- | ---: | ---: | ---: |
| bare windows (before change 27) | 0.904 | — | — |
| whole content + windows (**today**) | 0.935 | 3 | 0 |
| a blurb per window (Anthropic) | 0.826 | 1 | 8 |
| a 20-word blurb per window | 0.847 | 0 | 5 |
| one blurb per document | 0.759 | 1 | 13 |

Helped/hurt are paired counts against the baseline row. Against what the server
actually stores today the gap is wider still — 0.935 against 0.867 for the best
contextual arm — because keeping the whole-content vector already helped the
queries a blurb was meant to.

**The mechanism is measured, not inferred.** The same harness compares each query
against the exact window it was written for: prepending a blurb moves that window
*away* from its own query, by 0.034 with a full blurb (lower on 32 of 37) and
0.014 with a 20-word one (27 of 37). The loss tracks blurb length. A fixed-size
vector has less room for the sentence that actually answers.

**It ships as a flag because the sign belongs to the model, not the technique.**
The same harness on `embeddinggemma` — 768 dimensions against 1024, and a real
2048-token ceiling — reports a blurb per window at **+0.041**, helping 5 and
hurting 4. A weaker window vector has more to gain from the extra subject signal
than it loses to dilution. Measure before turning it on.

The column exists whether or not the flag does, because it is the only way to
tell the two kinds of chunk apart: a window is not a substring of its parent
(`chunkContent` joins paragraph segments with a space), so nothing is recoverable
by comparing text. `preflight.ts` counts both and reports a corpus captured under
both settings. Turning the flag on without applying 013 is a **failure** at
startup, not a warning: the functions from 007 and 009 would not select the key.
The blurb still reaches the vector — the server composes the embedded text before
the database sees it — so what is dropped is the record, and with it any way to
tell a contextualized chunk from a bare one afterwards.

The backfill is `reembed.ts` (next section): a pass under a job key of your own
naming re-embeds every thought exactly as a capture would under the current
setting, so flipping the flag and running it brings the whole corpus to one
kind of chunk.

The same applies to the whole-content vector that change 27 restored: a long
thought captured before it still has its head window in `thoughts.embedding`,
and re-capturing — or the same pass — is what upgrades it. Preflight does
**not** report that split, unlike the chunk-context one, because it cannot be
told apart from a legitimate state — a provider that refuses over-length input
falls back to the head window for every long capture, forever, and a check that
nags a correct deployment is worse than no check.

## Re-embedding, and bulk passes in general

Migration 015 adds `thought_work_claims`, ported from
`schemas/thought-work-claims`, and `reembed.ts` is the first thing built on it.

Every tool in this section takes a database URL and runs from a checkout. Against
the compose stack in `deploy/`, that URL reaches nothing until the stack is up
with `-f deploy/compose.host-ports.yaml`, which publishes the database on
`127.0.0.1` (`deploy/README.md`, "What is reachable from where"); the base file
publishes only the server.

**Why a table.** Any pass over the whole corpus — re-embedding after a model
change, entity extraction, a chunk-context backfill — was one process walking
the table with no record of where it got to, or several processes each
selecting "the next unprocessed rows" and picking the same ones. The table is
the pool and the record: `enqueue_thoughts(key)` adds every thought (or a list
of ids) as `pending` rows under a job key; `claim_thoughts(key, worker, batch,
ttl)` hands out up to `batch` of them with `FOR UPDATE SKIP LOCKED` under a
lease, so two workers claiming at the same moment receive disjoint sets;
`release_thought` marks one `succeeded` or `failed`, and only the holder may;
`release_claims_for_worker` hands a stopping worker's rows straight back;
`renew_claims` (migration 031) is the heartbeat — every `--heartbeat` seconds a
worker moves the deadline of every lease it holds forward, so the lease has to
outlast a missed beat rather than the batch, and `--ttl` means how long a dead
worker's rows stay out of the pool. A worker that dies keeps nothing: when its
lease expires the next claim returns the rows to the pool with the attempt
counted, and after three expiries a row is marked failed rather than handed
out again — which, under a heartbeating worker, means its worker died three
times on it, not that it was slow. Terminal rows stay, so running
a pass twice does nothing for the rows already done and picks up the thoughts
captured since.

Four things differ from upstream's version, each with a reason in the
migration header: the database picks the batch (upstream's workers chose
candidates themselves and mostly collided), an expired lease returns to the
pool rather than being deleted (so `attempt_count` and `last_error` survive),
terminal rows stay as the record of the pass and block re-enqueue, and there is
nothing for Supabase — no grants, no RLS, no `NOTIFY pgrst`.

**The job key names the target.** `reembed:qwen3-embedding:4b@1024`, not
`reembed`. Passes with different keys share nothing but the table, so a re-embed
and an extraction pass run at once, and a later re-embed to a third model is a
fresh pool rather than a no-op against the first one's terminal rows.

**No cloud key.** Nothing here needs one: `deploy/compose.yaml --profile
local-models` runs an Ollama beside the server and a capture embeds through it
(`OB1_LLM_BASE_URL`) — once you have declared it local: `OB1_LLM_LOCAL=1` in
`deploy/.env` for the server, and in the shell you run `reembed.ts` below from
(it reads its own environment, not `deploy/.env`); the profile sets neither, and
under the default every embedding is refused without it (`SETUP.md`). The rows
captured before that, or under another model, are what `reembed.ts` below
walks, 021's label per row telling which are at the target — an exact match
with `OB1_EMBEDDING_MODEL`'s spelling — and which are not. The retired
`recipes/local-ollama-embeddings` did the same by hand — an Ollama call per
thought, then `upsert_thought` over a PostgREST this stack does not run
(SMD-2138).

### `reembed.ts`

```bash
OB1_EMBEDDING_MODEL=bge-m3 bun reembed.ts --url postgres://… --switch-model
bun reembed.ts --url … --status              # where the pass stands
bun reembed.ts --url … --dry-run             # what a run would do; writes nothing
bun reembed.ts --url … --job reembed:x@1024:ctx   # a backfill under the same model (keep the reembed: prefix — preflight reports by it)
bun reembed.ts --url … --retry-failed        # failed rows back into the pool first
bun reembed.ts --url … --retry-fallbacks     # …and the rows stored with a head window (below)
#   --workers N (2; at most 2147483647: a connection each and a spare, Bun's pool max of 2^31)   --batch N (8; at most 2147483647, claim_thoughts' int)   --ttl SECONDS (900)   --heartbeat SECONDS (60, or a third of the lease when that is shorter; at least 1, and the lease must cover two)
```

It reads the same variables the server does — model, width, provider URL and
key, chunk sizing, chunk context, and the egress gate's (`OB1_LLM_LOCAL`,
`OB1_EGRESS_POLICY` and its terms, SMD-1903: a row the gate refuses to send to
an endpoint not declared local is a failed claim naming the rule, its text never
sent, and `--retry-failed` revisits it once the policy or the endpoint changes;
the banner's `egress:` line says what the run will do) — through the same function
(`server-portable/embed.ts`, lifted out of the server for exactly this reason),
so what it stores is byte-for-byte what a capture would store. Each thought is
re-embedded and written through `update_thought`, which replaces the chunk rows
wholesale as an edit does. A thought edited between the claim and the write is
re-read and embedded again; one deleted mid-pass is skipped.

**Changing model.** Same width only: `thoughts.embedding` is `vector(N)` and N
is baked into two columns, two HNSW indexes and every function signature, so a
width change is a migration that does not exist yet, and the tool refuses a
configured width that differs from the column's. When the configured model
differs from the one `ob1_config` records, the run needs `--switch-model`, and
the first thing it does is record the new model — from that moment a server
configured for it passes preflight and should be switched. Until the pass
finishes, searches mix vectors from two models; `--status` says how far along
it is. The record and the pool
are one transaction — the `ob1_config` row, the rows the data rule (below) and the retry flags return,
`enqueue_thoughts` — so a run that dies between them leaves both or neither,
never a record naming the new model with no pool behind it. And a model change
starts this pass over — every terminal row, and every lease expired with no
live holder, under the job's key returns to the pool: switching back to a
model used before otherwise found every thought's terminal row under the key
and reported nothing to do while every vector was the other model's. Other
keys of the same model are left as they are; once the pass has finished the
corpus is at the model again, which is what their finished rows say. A `--job`
that names a model (`reembed:<model>@<dim>[:suffix]`) must name the configured
one; a run under another model's key would write this model's vectors and
record them as the other's, and is refused (`--status` still answers for it,
so a key preflight reports can be inspected from any shell).

**The row says which model it is at (migration 021).** Every vector carries the
model that produced it, `thoughts.embedding_model`, written by the same
statement as the vector — the server's from its configuration, this tool's
from `OB1_EMBEDDING_MODEL` as `update_thought`'s eighth argument; NULL is a
vector of unknown model (a row from before 021 that no finished pass vouched
for, a raw INSERT, an older server) and counts as not at any model, as does a
row with no vector. Under the model's own key the pool is built from that:
`enqueue_thoughts` is given the ids not at the target, so a thought already at
it with no row is finished and is never re-embedded "harmlessly", and "not yet
in the pool" means exactly what a run would add; a `--job` key is a backfill
whose reason is not the model, and pools every thought as every pass did
before 021. The unlabelled rows a pool holds are counted before a run —
re-embedding is what labels them. And on every run, under any key, a
*succeeded* row whose thought is not at the target returns to the pool — the
row says done, the thought says otherwise, the data wins — which is what finds
a thought captured or edited by a server still on the old model, before or
after the pass finished; until 021 the run could only say at its end that some
rows were captured meanwhile and nothing could tell. On a model change the
start-over returns the failed rows and expired leases; the succeeded rows are
the data rule's, so a switch back re-embeds only what the rows say moved.
Failed rows are left to `--retry-failed` (subsumed by a model change, which
returns them anyway); `--retry-fallbacks` is honoured on every run, since a
caveat row is neither failed nor a lease, and a row succeeded with a caveat is
at the target unless its thought moved, in which case the data rule takes it.
Which key pools how — a model's own key by the label, a `--job` key every
thought — is `poolModelFor` in `config.mjs`, one rule for this tool and for
preflight's "not yet in the pool"; under a `--job` key a model change starts
the pass over as before 021, since that key cannot judge by label.
`--status` and a run print the corpus by model, and say what preflight's
`vector models` line will say. A run requires 021 and says so; `--status` and
`--dry-run` answer on an older schema.

**What preflight sees.** A pass is *unfinished* while any row under its key is
pending, leased or failed — `passUnfinished` in `config.mjs`, one rule for this
tool and for `server-portable/preflight.ts`, which reads the claim table on
every start and reports, in the counts `--status` prints, every unfinished
key that starts with `reembed:` (the configured model's key, or a backfill's;
extraction keys are left out because 016's trigger keeps that pool fed). A key
a worker holds a live lease under is *running*, an ok row with no remedy that
would start a second worker — a warning only for failed rows beside it, which a
worker never retries, naming the `retry_failed` tool for the key that puts them
back to pending for the running worker to take; one whose
only leases expired names a worker that died holding them, which the next pass
reclaims, a row on its third expiry marked failed (the stale rule is
`release_stale_leases`' and `worker_status`', `ttl_expires_at < now()`;
SMD-2423). No marker to clear: the claim table is the record of the pass and
nothing else.
Succeeded rows with a caveat are finished; thoughts not yet in the pool —
since 021, the thoughts not at the key's model with no row under it — are
detail while a pass is unfinished, and are what the next run adds. The rows
themselves are preflight's `vector models` check, directly under `embedding
contract`: the corpus grouped by `embedding_model`, ok when every labelled
vector is at the recorded model (unlabelled rows as detail), a warning naming
each other model and its count with the pass as the remedy — whether or not any
claim row remembers the pass that left them — and a failure when the column is
missing under a server that writes it. `edit signature` beside it checks that
the nine-argument `update_thought` (032) is present and alone — an earlier form
re-created beside it by a hand re-apply of 018 or 021 makes every call with
fewer arguments, this tool's positional eight among them, `function is not
unique`, and the DROP is the remedy — `delete signature` does the same for the
three-argument `delete_thought` (042: a brain still at 036 fails every delete
the server sends, and 009 or 036 re-applied by hand puts the two-argument form
back beside it) — and `updated_at
trigger` that 001's trigger is still enabled after 021's backfill held it off. `--status` and the end of a run print `preflight will
warn until this finishes:` with the same counts, so the two never disagree. A
`--job` key without the prefix is accepted and noted: preflight will not report
it. A key whose model is no longer the recorded one — a switch abandoned or
reverted — is reported as such, with its two remedies: finish that switch in
its own environment, or retire its record with `--retire <key>`, which refuses
the recorded model's keys, another tool's, an empty one and one with a live
lease. A row the provider refuses permanently — a content filter, say — is the
operator's to accept: `--accept-failed <thought-id…>` marks it succeeded with
the caveat `kept the vector it had; accepted by the operator: <the failure>`,
and both readers of the row honour that while nothing has written the thought
since — the data rule leaves the row, and `vector models` counts its vector as
detail rather than as a warning; an edit reopens it, and `--retry-fallbacks`
returns it like any caveat (SMD-1067, FORK.md change 39).

**What the audit log records: almost nothing, on purpose.** Migration 008's
trigger diffs the embedding's *presence*, not its value, so a vector replaced
by a vector is `{}` and `{}` is not an event. A full re-embed therefore does not
double `thought_audit`; only a row that had no vector and gains one is audited,
with `reembed` as the actor and the job key as the session. The claim row is
the per-thought record of the pass. SMD-946 expected one audit row per thought;
`test-live.ts` [9] asserts the count is unchanged, so the expectation is written
down as corrected rather than quietly unmet. Every re-embedded row's
`updated_at` does move, because the row was updated.

**Duplicates from before the fingerprint.** Migration 003 added
`content_fingerprint` without a backfill, so a brain that predates it can hold
two rows that normalise to the same text, both with NULL fingerprints; a load
that inserted into `thoughts` directly leaves the same state. A pass writes each
row's own text back through `update_thought`, which gives the first of such a
pair the fingerprint it never had — and until migration 018 then refused the
second's own text as `DUPLICATE_CONTENT`: failed, exit 1, and `--retry-failed`
reproduced it for ever. 018 accepts an edit whose text normalises to what the
row holds, leaves that row's fingerprint NULL so the unique index is never
violated, and names the other row in its result. The pass requires 018 (it
exits 2 naming the migration otherwise), says per row when it found a pair,
and prints every group of thoughts sharing one normalised text at the end of a
run and under `--status` — one query over the corpus, so the list is the same
whenever it is asked for. Both rows are re-embedded; only one carries the
fingerprint, so a later capture of that text merges into it and not the other.
Whether they should be one thought is the operator's call, and nothing is
written to the claim row about it. Two workers reaching the two rows of a pair
at the same moment are serialised on an advisory lock inside `update_thought`;
without it the second would pass the check and raise a unique violation when
the first committed — `test-live.ts` [6b] shows the wait on the right lock.
Since migration 033 a capture takes the same lock, so a capture of the same
text committing while a worker fingerprints a legacy row no longer raises that
violation — the worker waits and is told `duplicate_of` (`test-live.ts` [6e]);
a load that inserted the text around `upsert_thought` still can, which lands
as a failed claim naming the constraint, and `--retry-failed` resolves it. The
read-only `--status` runs against any schema; a pass that would write requires
018, `--dry-run` reports that refusal in place of the worker plan, and a brain
adopted with `--baseline` — ledger says 021, body says 013 — is told to
`migrate.ts --reapply` rather than to apply a migration a plain run skips (§5
above; the migrator runs 021's backfill with the operator's acceptances out of
its sight, so it labels from real passes alone).
Migration 023 is the one-shot backfill: every legacy singleton, and the oldest
of each group (`created_at`, then id) takes its fingerprint once at upgrade,
under a table lock that makes a capture waiting on it merge rather than double;
this list marks the row holding the key — and a holder whose key describes
text it no longer holds as STALE, grouped with the NULL row it blocks rather
than with a twin — so what 023 decided is readable here. Stop a re-embed pass
and an entity-extraction worker before applying it: every writer into a table
referencing `thoughts` waits on that lock — and, before migration 031, waited
out its lease; a parked worker keeps beating now, so this is throughput advice.
After it a row without a fingerprint is a twin, or
blocked by a stale key, or was loaded around `upsert_thought` since — and
`SELECT backfill_content_fingerprints()` settles the last kind the same way,
when preflight's `fingerprint backfill` says so.

**The head window, recorded.** A long thought is embedded whole and in windows;
when the whole-content call fails, the head window's vector stands in for it
(`server-portable/embed.ts`, change 27). The server accepts that silently by
design. The pass does not: a *transient* failure — 429, 5xx, a lost connection,
the timeout — stores the head window and marks the claim failed, so
`--retry-failed` tries the whole content again; a *refusal* — a 413, or a 400
whose own words name the length: a hosted API that will not take input that
long — stores the head window and marks the claim succeeded, because that
vector is the provider's final answer and is what a capture would have stored,
**with the refusal written on the claim row**. A 400 that says nothing about
length is not known to be about this input and is treated as transient; the
row says what it got. The rule is general: a succeeded row's `last_error`, when set, is
what the worker could not do — the write stands, and this is what it fell short
of. `--status` and the end of a run count them ("35 succeeded (1 with a
caveat)") and list them; `--retry-fallbacks` returns them to the pool for the
day the provider or its input limit changes. The second caveat written today is
the operator's: `--accept-failed` marks a failed row the provider refuses
permanently succeeded with `kept the vector it had; accepted by the operator:
<the failure>`, counted inside the same parenthesis ("37 succeeded (2 with a
caveat, 1 accepted by the operator)") and returned by the same flag — see
"What preflight sees" below. For that to be a fact about the
row, the pass asks every long thought itself: its embedder does not remember a
refusal the way the server's does (one probe per process on the interactive
path), because a 413 is about *that* input's length and a shorter long thought
may well be accepted — remembering would give every later long row a head
window it was never asked about, under a reason that was another row's. Every
provider call the server and this pass make is bounded by `OB1_LLM_TIMEOUT`
(120 s by default; the server reads it too, for its metadata call as well; those
calls go through one function in `embed.ts` — `extract-entities.ts` keeps its
own `--timeout` per model call): a call that never returns — before the headers or
during the body — fails the row with the timeout named instead of parking the
worker until the second Ctrl-C, and a blurb that times out under
`OB1_CHUNK_CONTEXT=on` puts that reason on the row rather than "fix the metadata
model". The lease is not sized by that timeout since migration 031: while a
worker holds rows it renews every lease it holds on a heartbeat (`lease.ts`,
shared by the three workers), so `--ttl` has to outlast a missed beat — at least
two `--heartbeat`s, refused otherwise with the arithmetic shown (`--status`
answers regardless, since it never claims) — and means how long a dead worker's
rows stay out of the pool; a heartbeat not given is a third of the lease, at
most 60 s. Until 031 the default lease grew to `--batch` × the timeout and a
shorter one was refused, because a lease was stamped per claim and could not be
moved. A row with two things wrong records
both: a refusal is appended to a blurb failure rather than lost behind it. What
counts as a refusal is a 413, or a 400 whose own words name the length — read
from the provider's body, its error code first, never from a message that also
carries the base URL — the same rule `extract-entities.ts` applies to its 400s,
from one function. `--status` counts and lists succeeded rows with *a caveat*,
in the rule's words rather than one caveat's, and each row's text says which. Until SMD-1021 a
refused row was indistinguishable from any other succeeded row, one summary line
was the only trace, and a terminal claim meant no re-run would look at it again.
Since migration 028 (SMD-1052) the rule is also stated where a reader of the
table finds it: `COMMENT ON COLUMN thought_work_claims.last_error` gives both
meanings by status, and `release_thought`'s comment says `p_error` is stored
whatever the status and what it means on success; `test-schema` [27] asserts
the live text of both, so a later redefinition that re-issues 015's shorter
comment fails the suite (SMD-1313 is the generic form). The server still remembers a refusal for the life of its process;
shaping that latch is SMD-1054.

**Cost.** Dominated by the provider. The claim itself is flat across the pass —
0.48 ms for the first hundred of a 100,000-row pool and 0.47 ms for the last,
against a 0.15 ms round trip — and the header of 015 has the table showing what
the first draft cost instead (2.90 ms by the end, unchanged by `VACUUM`): the
planner served "any sixteen pending rows" with a sequential scan that stops at
sixteen hits, and the done rows accumulate at the front of the heap. Ordering
by `enqueued_at` over a partial index is what makes the index the cheapest
estimate whatever the statistics say. The heartbeat is one small `UPDATE` a
minute per worker, through 015's partial index over the rows in flight;
`test-live` [8e] prints its round trip.

**Writing another consumer.** See the end of the next section. Entity
extraction is the second pass built on the table, and `extract-entities.ts` is
the shape to copy.

## Entities and relationships

Migration 016, rewritten from `schemas/entity-extraction`, and
`extract-entities.ts`, its worker. Every thought was opaque text plus the
`metadata` the capture model attached; nothing recorded that two thoughts
mention the same person or that one system depends on another. This adds that
layer. It was built as the prerequisite for SMD-948 (GraphRAG), which was then
measured and not built — `evals/README.md` has the numbers; the graph lost to
plain vector search on every question type — so what this layer is for is the
structured questions, which thoughts mention X and what X connects to, not
retrieval.

**The tables.** `ob1_entities` is one row per (type, normalised name) with the
first form seen as `name` and the other forms in `aliases`. `thought_entities`
records which thought mentions which entity, with confidence, the extraction
key and the agent that wrote it. `ob1_entity_edges` is a relation between two
entities *as evidenced by one thought* — one row per (thought, from, to,
relation). Support for a relation is the count of its rows. That shape is what
makes the two hard cases fall out: deleting a thought removes its edges by
foreign key with no counter to correct, and re-extracting a thought is
`record_thought_entities` replacing exactly its rows, then pruning any entity
left with no mention and no edge. Running it twice on the same output leaves
the same rows, ids included; `test-schema.ts` [16] asserts that byte for byte.

**The resolution rule, decided.** Is "Postgres", "postgres" and "PostgreSQL"
one entity or three? Two. `normalize_entity_name` is NFKC, lower case, hyphen,
underscore, slash and hash read as spaces, surrounding quotes and punctuation
stripped, whitespace collapsed — and nothing fuzzier, ever, automatically. The
separator folding was added after the first corpus run: every one of the
fifteen closest near-duplicate pairs it reported was "anonymous-intake" beside
"anonymous intake" or "state_of_care" beside "State of Care". Trigram merging or asking the model to
canonicalise against the existing table would merge "Anita" with "Anika" as
readily as the two Postgres spellings, and a wrong merge is far harder to undo
than a duplicate is to merge. The prompt asks for the most complete common name
and for aliases; aliases are recorded, never used to resolve. `merge_entities`
is the human step: it re-points mentions and edges, keeps the loser's name as
an alias, records the loser's normalised name in `merged_from`, and refuses to
merge across types. `merged_from` is the one list that does resolve: the next
extraction that says "postgres" lands on the survivor rather than re-creating
the loser, so a human's decision persists where a model's guess does not. The
corpus run below reports how many near-duplicates the strict rule leaves, so
the trade is a number.

**The queue is migration 015's.** A trigger on `thoughts` enqueues new and
edited content into `thought_work_claims` under the current extraction key
(`extract:<model>@p<prompt version>`), read from `ob1_config`. Until
`extract-entities.ts` has run once and written that key, the trigger does
nothing: **this migration adds no LLM cost to anyone who does not run the
worker.** A metadata-only edit enqueues nothing; a content edit re-enqueues a
finished thought, and one that lands while a worker holds the lease sets the
claim back to pending, so the worker's release returns false and the new text
is extracted. Deleting `ob1_config.entity_extraction_key` turns the trigger off
again.

### `extract-entities.ts`

```bash
bun extract-entities.ts --url postgres://…              # the backlog, then exit
bun extract-entities.ts --url … --follow [SECONDS]      # …then keep polling for new captures, stamping a heartbeat each pass ("Long-running workers report their liveness", below)
bun extract-entities.ts --url … --limit 25              # a trial: this many, then stop
bun extract-entities.ts --url … --status                # the pass, and the graph so far
bun extract-entities.ts --url … --dry-run               # what a run would do; writes nothing
bun extract-entities.ts --url … --retry-failed          # failed rows back into the pool first
bun extract-entities.ts --url … --retry-partial         # rows extracted in part back into the pool — after raising OB1_EXTRACT_MAX_WINDOWS
bun extract-entities.ts --url … --retry-left-out        # …only those with windows left out as malformed — after a change of model, kept to this pool with --job (below)
OB1_METADATA_MODEL=<larger> bun extract-entities.ts --url … --job <the recorded key> --retry-left-out --limit N   # a larger model over those N rows, the key and trigger left as they are (--status prints it)
#   --workers N (2; at most 2147483647: a connection each and a spare, Bun's pool max of 2^31)  --batch N (1; at most 2147483647, claim_thoughts' int)  --ttl SECONDS (900)  --heartbeat SECONDS (60, or a third of the lease; at least 1, and the lease must cover two)  --timeout SECONDS (300, per model call — per window of a long thought; at most 9007199254740, a call signal's range)
bun extract-entities.ts --url … --switch-key           # required when the model or prompt version differs from the recorded key
#   exits 0 clean (partial rows included) · 1 rows failed, leased or pending · 2 usage, configuration or the provider's refusal · 3 the model likely at fault (SMD-2266, ahead of 1) · 130 a signal (a second, at once); --follow stopped by one signal exits 0
```

**Long thoughts go in windows (SMD-1879).** A thought over the extraction
window is split with `server-portable/chunk.ts` into overlapping windows, each
window is one model call, and the windows' answers are merged by (type, name)
and (relation, from, to) — highest confidence kept, aliases unioned — before
`record_thought_entities` applies its own rule, so a subject named in every
window is one entity and one mention. Every call carries `max_tokens`, an
answer budget sized to the text it sends (three times the estimated tokens plus
1,536, `db/config.mjs` — over every legitimate answer measured on `qwen2.5:7b`
and `qwen3.8:27b`), so an answer that will not end is cut in about a minute rather than
running to the model's context and the worker's timeout — and a call cut that
way is made once more with a frequency penalty (`RUNAWAY_PENALTY`, 0.5), which
taxes the repetition the runaways were measured to be: on the fork's brain that
retry, with the budget sized to both measured models, extracted all 32 thoughts
one call could not finish, where windows alone reached 10 to 13. Set
`OB1_EXTRACT_ESCALATE_MODEL` and a runaway is instead remade once on that larger
local model with no penalty (SMD-2000) — the pass key on the rows stays the
first model's, and the dump line records which model answered. The 27B never
looped on the thoughts the 7B could not finish, so the escalation spends the
large model only where the small one has failed; it loads it beside the embedder
(28 GB on the dogfood Mac, and `OLLAMA_MAX_LOADED_MODELS=2` can evict the
embedder mid-pass), so it is a per-brain choice, not the default. The answer is
streamed, and a call is aborted the moment its answer holds three copies of one
item (`RunawayDetector`, `RUNAWAY_REPEATS`; SMD-1960) — the loop is visible on
the stream long before the budget, so a runaway costs seconds rather than the
minute the budget allows (the 32 stragglers' pass measured 1,796 s against
3,158, 31 of 32 extracting; the 32nd extracts on a re-run under the shipped
retry rule, so 32 of 32 is derived, not re-measured whole) — and a call
aborted so is retried as a cut one is, the retry read whole, since a penalised
answer was measured to repeat an item three times and recover; an
answer that enumerates distinct ids is not a loop by that rule and runs to the
budget, which stays the bound. A loop inside a string is caught too: entity
after entity named `Linear Linear …`, each name one copy longer than the last,
so no item repeats. Once the answer ends in 24 copies of one short unit holding
a letter or a digit, whitespace aside (`repeatedTail`, `TOKEN_REPEATS`;
SMD-2449), the call is aborted and retried the same way. Ollama's own repeat
limit (more than 30 identical tokens) would otherwise end the stream with no
finish_reason, a cut that read as a socket closed mid-answer: a provider
failure the worker paused on, retried identically and could stop for. A cut
answer whose tail repeats any unit 24 times (punctuation and emoji too, which
Ollama's limit also cuts) or ends in 24 or more whitespace characters is that
runaway too, streamed or read whole (a whole answer Ollama cuts comes back
with `finish_reason: null`). A row failed before this change with `provider
error after 3 retries: … closed mid-answer …` comes back with
`--retry-failed` under the same model (after a change of model, the new key's
pass extracts it anyway), and the thoughts a stopped worker left pending are
taken by the next run. There is no setting for the 24, by design: a name that
copies a longer run from its text (an `sk-xxxx…` placeholder) costs one extra
call, and the retry's answer stands — if the retry copies the run too, that
window is malformed. A gateway between the worker and Ollama that batches
its tokens into larger frames can delay the abort, and one that adds `[DONE]`
or a `finish_reason` to the cut stream turns a loop of punctuation back into
an unretried malformed answer. A call whose retry also runs away is a
malformed answer: a window's is left out of a thought at least one of whose
other windows parsed (SMD-2260, below), and a thought none of whose windows
parsed is recorded failed, retryable.
The window is the **metadata model's**, not the embedding
model's: `OB1_EXTRACT_CHUNK_TOKENS` when set, else derived from the model's
served context (`KNOWN_CHAT_MODEL_WINDOW`, measured as `KNOWN_MODEL_WINDOW` is)
and held at the size the default model was measured to finish reliably; a model
the table does not list gets that default. The banner's `window:` line and
preflight's `extraction window` row print the same sentence. The prompt version
is 2 — a pass under it re-extracts a brain whose thoughts were cut at 8,000
characters under p1 — so the first run after upgrading needs `--switch-key`.
`--dump`'s line carries `windows`, `retried` (or `escalated: <model>` when the
runaway went to the larger model, SMD-2000), `abortedMs` — how far into
the call a runaway was aborted on the stream, or cut there by the provider's
repeat limit — and `abortedBy` (`item`, a third copy of one item; `token`,
one unit repeated, SMD-2449), and, for a windowed thought,
each window's own answer in `parts` beside the merged one. Why, measured:
`evals/README.md`, "Entity extraction in windows".

**A thought over the bound is extracted over its prefix (SMD-2240).** One
thought is extracted in at most `OB1_EXTRACT_MAX_WINDOWS` windows (24 unset,
`db/config.mjs`'s `EXTRACT_MAX_WINDOWS`; a window's runaway retry is a second
call) — ~29,000 estimated tokens of text at the default window, and under
twice that at most for a thought of more than one window, since `chunk.ts`
fills a window with whole words and the last may run past the size. The bound
was sized at four times the longest thought on the fork's brain; ingested
documents broke that, and on one pass 8 of 53 thoughts (PDFs and pages of 26
to 74 windows) were failed before any call with nothing in the graph. A
thought over it is now extracted over its
first windows, in order, and its claim is released **succeeded with a caveat**
— migration 028's rule, `last_error` on a succeeded row — reading
`partial: N of M windows extracted, …` (`… sent, the last cut short …` when
the text bound cut the last). The run's summary and `--status` count
those rows apart from the full ones and the failures (`12 extracted (1 over a
prefix only), 0 failed`) and list each with its caveat; `--dump`'s line carries
`coverage`. Raise `OB1_EXTRACT_MAX_WINDOWS` and run `--retry-partial`: the rows
go back to the pool and `record_thought_entities` replaces the prefix's rows
with the longer reading's. A row failed by the old rule (`over
EXTRACT_MAX_WINDOWS (24); not extracted`) comes back with `--retry-failed`. A
run `chunk.ts` cannot split (SMD-1974) — a whitespace-free blob — is sent
whole however long, in one window or, carried by the overlap, in two, and
nothing bounded it until this; the windows now meet a text bound,
`OB1_EXTRACT_MAX_WINDOWS` windows' worth, in which a window of twice the size
or more (only such a run makes one) counts its whole length and any other its
length up to the size (a filling word past it, or unspaced CJK prose just over
it, is not a run), and the window that passes it is cut there, with a caveat
saying so. A single call's size over a window stays SMD-1974's. The prompt
version is unchanged: a whole extraction is what it was. What changes is a
thought over the count, which stored nothing and now stores its opening, and a
thought whose runs pass the text bound, which was sent whole and is now cut at
it.

**A malformed window is left out, not the thought (SMD-2260).** A windowed
thought some of whose windows the model answers with something other than JSON
of the expected shape is written from the windows that parsed, and its claim is
released succeeded with a caveat naming the rest: `partial: 2 of 3 windows
extracted; the model's answer for window 2 was not JSON of the expected shape,
and its text is not in the graph` (`… of the N sent …`, and the bound, for a
prefix with windows left out). Only a thought none of whose windows parsed — a
one-window thought's one answer included — is failed as malformed, as before; a
window that times out still fails its thought. Until this,
one malformed window failed the thought, its parsed windows with it: on the
stable brain three research papers kept nothing because the model could not
answer their reference lists, 15 to 22 of 24 windows parsed, and a larger model
mangled the same windows. These rows are the second kind of partial row, which
the summary and `--status` count and list apart from a prefix
(`13 extracted (1 over a prefix only, 1 with windows left out as malformed), 1
failed`) — a row with windows left out is closer to a failure, since the model
decided it, not the bound; a row of both kinds, a prefix with windows left out
as the papers were, counts with the windows left out, and the counts say how
many of those are over the bound too. `--retry-partial` returns every partial
row and `--retry-left-out` those with windows left out alone — the lever for
them is the model, and re-reading every prefix to the place it already reached
under a larger model would cost up to the bound's calls each for nothing. A
changed `OB1_METADATA_MODEL` is another extraction key, so the retry keeps to
this pool with `--job`, and to the returned rows with `--limit` and no other
worker of the pool running, since the workers claim pending rows by queue time
and a returned row keeps its own, so an older pending row is claimed in its
place (`--status` prints the command, and the pool's pending count beside it).
`OB1_EXTRACT_ESCALATE_MODEL` (SMD-2000, above) is not this: it remakes a call
that ran away, within the pass, and a window answered in prose never ran away,
so a window left out beside it was either not a runaway or failed the larger
model too. Either
flag reads a row again under the bound and the model in force: whole, or, over
the bound, to it; a reading that fails outright — a window timing out, none
parsing — records the row failed, and the earlier reading's entities stay in
the graph until a later reading succeeds, since a failure writes nothing. A run that leaves partial rows and
no failure exits 0, the partial rows listed on stdout, unless the model looks
at fault (below).

**A run whose model looks at fault says so and exits 3 (SMD-2266).** Since a
windowed thought with any window parsed is succeeded, a model answering many
windows malformed writes partial rows, not failed ones. So the run counts its
answers, one per window sent of each thought that returned (a timeout's
earlier windows are not counted), and when more than a fifth of at least 48
were not JSON of the expected shape (`db/config.mjs`'s `malformedAlarm`) it
says so on stderr in two lines:
- the first says the model, not the documents, is likely at fault, and names
  `OB1_METADATA_MODEL`, and `OB1_EXTRACT_ESCALATE_MODEL` when it answered
  runaways; a run of `--retry-failed`, `--retry-partial` or `--retry-left-out`
  chose its rows for failing, so its first judgement says how many rows were
  returned and that their documents may be at fault instead;
- the second says the rows written stand, and names the retries for the kinds
  of row the run left, with `--job` if `OB1_METADATA_MODEL` changes.

The run exits 3, ahead of the 1 of rows failed, leased or pending, whose lines
still print; a signal or the provider's refusal still exits 130 or 2, and the
line says so. An all-malformed run exits 3 where it exited 1; its rows are
failed, as before. A `--follow` process judges its answers in blocks of 48 or
more after each pass drains the pool, so a breakage that starts late is not
diluted by the good polls before it; one started on a backlog says nothing
until the backlog is done, as a plain run does, so try a new model with
`--limit 48` first. Stopped by a signal, a follower still exits 0; ending at
its `--limit` with a block tripped, it exits 3, the last pass's block judged
with the exit it takes.

Measured on the stable brain's pool, read-only: qwen2.5:7b left out 11 of
1,658 answers, all in six papers' reference lists, and read those six again at
12 of 136 (9%). The wrong model, qwen3.5:0.8b, left out 17 of 61 over 24
windowed thoughts (28%), 14 of them partial and none failed — the quiet case;
over 24 one-window thoughts it failed 4, so a run with short thoughts in it
already exits 1. There is no floor on one thought's share, since a thought's
share reflects its text and a run's reflects the model; a floor of half would
have failed only 3 of the wrong model's 14 partial thoughts. The three papers
SMD-2260 was written for, read at 20 of 72 before it (28%), would pass a
fifth: no share tells that reading apart from the wrong model's, and the floor
of 48 keeps one such paper alone below the threshold at the default bound of
24 windows.

**What may leave.** The egress gate (SMD-1903) reads each row's own
`metadata` — `source`, `type`, `topics` — and its text against `OB1_EGRESS_POLICY`
before the call; a row it refuses to send to a chat endpoint not declared local
(`OB1_CHAT_LOCAL`, or `OB1_LLM_LOCAL` when chat is the embeddings endpoint) is a
failed claim naming the rule, and the banner's `egress:` line says what the run
will do before it claims anything.

**The cost, stated up front.** One call to the metadata model per thought,
recurring: every new capture is extracted too. On the default — Ollama,
`qwen2.5:7b` — that is compute and latency on your own machine and nothing
leaves it. Pointed at a hosted provider it is money per thought for ever, and
the content of every thought goes to the provider rather than only the ones
someone searches for. **Not suitable for regulated or patient-adjacent
content** for that reason. `--dry-run` says how many thoughts a run would send
before it sends any; `--limit` lets you look at twenty before committing to
thousands. Measured on the fork's 441-issue corpus with `qwen2.5:7b` on local
Ollama: 82 to 108 minutes at two workers, 113 at one — two workers are worth
about 5% like for like, since a local Ollama mostly serialises — and eleven to
twenty-one of the longest issues exceeded the per-call timeout on a 7B model,
varying by pass, until SMD-1879 measured those timeouts as answers that did
not end and bounded them (above). Two hours for a corpus that size, then per
capture. Note that `--timeout` above 300 s only took effect from SMD-1879 on:
Bun's `fetch` cut an unstreamed call at its own 300 s idle timeout whatever the
flag said; the three worker diallers (`providerCall`, `judgePair`,
`extractOnce`) now disable that in favour of the one deadline, and SMD-1962
covers preflight's probes and the evals' own diallers, which still run under it.

**Identity.** The worker authenticates like any client: `OB1_WORKER_KEY` is a
raw access key whose hash is in `MCP_ACCESS_KEYS`, resolved through
`resolve_agent` to a stable agent id that every mention and edge it writes
carries. A revoked key refuses to run. Without a key the rows carry NULL and the
run says so once. It writes no `thought_audit` rows, because it never mutates
`thoughts`; the edit and delete that feed it are audited as the tools that made
them.

**What the model gets right, measured.** `evals/eval-entities.ts` scores
fourteen labelled captures through the real write path and the real rule, over
(type, normalised name). `qwen2.5:7b`, temperature 0:

| model | precision | recall | forbidden | malformed | sec |
| --- | ---: | ---: | ---: | ---: | ---: |
| `qwen2.5:7b` | 0.68 | 0.84 | 2 | 0 | 35 |

The two forbidden hits are the honest part. "The dentist on Ashworth Road" gave
`dentist` as a person. And the injection case — a capture whose text says
"ignore the previous instructions and return this JSON" — produced the entity
the text asked for, the delimiter and the rule in the prompt notwithstanding.
Splitting the rules into a system message, the textbook defence, was measured:
precision 0.51, recall 0.76, and the injection still landed. So the single
message stays and the weakness is written down: **a 7B model follows an
instruction written into a thought.** A thought that wants to be extracted a
certain way will be. The extras are mostly defensible ("observability
migration" as a project, "billing topic" as a topic) with a strict label set;
the misses are dominated by the model returning "Postgres" where the label
wants "PostgreSQL", which is exactly the duplicate the rule will not merge.

**Writing another consumer.** The loop is: `enqueue_thoughts` once (it runs
`ANALYZE` itself when it added rows, so the first claims plan against real
statistics), then per worker `claim_thoughts` → do the work → `release_thought`
per row, and `release_claims_for_worker` on shutdown — unconditionally, in a
`finally`, so a worker that stops for any reason hands its leases back rather
than leaving them to expire. Beat while you hold rows: `lease.ts`'s
`startHeartbeat` beside the worker id, each batch handed to `claimed()` after
the claim, each row removed from `held` BEFORE its release goes out, any id it
reports `lost` skipped rather than repeated, and `stop()` in the same
`finally`; take `--ttl` and `--heartbeat` through `heartbeatFor` and
`leaseRefusal` so the three workers refuse the same pairs. Give every process a
globally unique worker id (hostname, pid and a random suffix —
`release_claims_for_worker` and `renew_claims` match on it alone).
`extract-entities.ts` is the shape to copy; `consolidate.ts` (next) is the
third consumer, and the one whose work is per PAIR rather than per thought.

### graph-centrality.ts

Reads the graph for importance (SMD-1938). "What is relevant to X" is
`search_thoughts`'s question; this answers the other one — what the brain holds
as central about X, or overall — with counts anyone can recompute, and no
hand-written SQL: **mentions** (distinct thoughts mentioning an entity),
**degree** (distinct entities an edge joins it to, either end), **support**
(distinct thoughts evidencing any edge touching it); around a subject, per
neighbour, **co_mentions** (thoughts mentioning both) and **support** (thoughts
evidencing an edge between them, any relation, either direction, the
per-relation counts shown). Reads only; one connection; `--limit` is 20 by default and at most 500.

```bash
bun graph-centrality.ts --url postgres://…                     # the whole graph: top entities by mentions, the hubs by degree, top thoughts
bun graph-centrality.ts --url … "Open Brain"                   # one subject's neighbourhood and the thoughts that tie it together
bun graph-centrality.ts --url … "Open Brain" --no-edges        # the control: co-occurrence alone
bun graph-centrality.ts --url … --types project,tool --json    # a typed subgraph, as data
bun graph-centrality.ts --url … "Open Brain" --status open     # as the live tickets build it: no Done or Canceled evidence
bun graph-centrality.ts --url … --decay-done                   # a settled ticket weighs 0.25 in every count
bun graph-centrality.ts --url … --status open --startable      # what you could start now: no ticket with an open blocker
bun graph-centrality.ts --url … --status open --decay-blocked  # a blocked ticket sinks to 0.25 instead, naming its blockers where listed
```

The subject resolves by 016's own rule, one rung at a time — exact
`normalized_name` (so "open-brain" finds "Open Brain"), then a name a human
merged in (`merged_from`) or an alias the model offered, then the five nearest
by trigram similarity at pg_trgm's default threshold, named as guesses. What
is ranked around is the entities sharing the first subject's normalised name —
"postgres" as a tool and as a topic are both it — and the other names an alias
or fuzzy rung returns are listed, unmarked, and not ranked around
(`subject_ids` in the JSON says which); a uuid is one entity, ranked around
alone, its same-name siblings under other types then its neighbours. A neighbour ranks
by co_mentions + support, and its per-relation counts can sum past support
when one thought asserts two relations; `--no-edges` drops the support term and every edge
column, so a run with and a run without say what the edges add over
co-occurrence — the drop-the-graph control. Entity ties break on mentions,
then the normalised name, then the type, never on a uuid or a timestamp;
thought ties break on the thought id, stable on one database and carrying no
recency: the same rows give the same order every run.

**Centrality here is attention, not value**, and every run prints the caveats
with its own numbers: edges are unweighted (SMD-1925 — on real runs every edge
carries confidence 1.00, so support is an edge's only weight); entity typing is
noisy (SMD-1935 — names that are only digits, dots, colons and spaces are out
of scope by default — a brain from before 056 holds them, and so can a name a
structured source states or an entity a human curated — `--keep-numeric` admits
them, `--types` narrows further, and the scope IS the graph: an entity outside
it is in no list and no count, the subject the one exception, so `--types tool
"Open Brain"` is the tools around a project); hubs and clusters inflate each other; ticket status is read
from synced metadata and by default not acted on (below); and only extracted
thoughts are in the graph, which the coverage line counts.

**Lifecycle** (SMD-1994). board-sync (SMD-1954) stamps every synced ticket's
`metadata` with Linear's `status`, `status_type` (triage / backlog / unstarted /
started / completed / canceled) and `linear_updated_at`, so a thought's
lifecycle is on its row and the script reads it. One rule carries the filter
and the decay: every thought has a **weight**, and every count of thoughts —
mentions, support, co_mentions, the per-relation counts — is a sum of weights.
`--status open|active|done` keeps the named lifecycles at 1 and weighs the
other known ones 0 (`open` = not completed or canceled; `active` = unstarted or
started; `done` = completed or canceled); `--decay-done` weighs a completed or
canceled thought `DONE_WEIGHT` = 0.25, pre-registered in the file, one value,
exact in binary, refused beside a filter (they are two answers to one
question). A row's lifecycle is its ticket's: a row carrying a ticket
(`issue`) or derived from one (`ticket` — SMD-2059's dated sections) takes
the status of the ticket's head — of the rows carrying that `issue`, one
nothing supersedes before one superseded, the newest sync before an older —
so a Done ticket's observations and its superseded earlier rows are settled
with it; a twin the sync chained under a head without an `issue` of its own
keeps its own lifecycle, which is none. A thought with no lifecycle — a hand capture, or a `status_type`
the file does not know — weighs 1 under every flag: it passes every filter,
and the output counts how many did rather than calling it open. Degree counts
neighbours, not evidence, so a filter removes an edge with no live evidence
and decay leaves it; a thought is listed when it weighs more than 0 and ranks
by its weight times its score, with its status beside it. The default,
`--status all` without decay, is every weight 1 — today's counts by
construction, so a Done ticket still counts as a live one until a flag says
otherwise, and the lifecycle caveat says so with the run's numbers: how many
thoughts carry a status, how many are settled, the latest `linear_updated_at`
(the status is as fresh as the last sync pass), and under a filter how many
thoughts weighed in. The status, and every rule below, is migration 058's
`node_state` (SMD-2074): `node_lifecycle()` without a dependency flag, which
reads `thoughts` and, since 068, `ob1_ticket_head` (both the capture group's),
and `node_state()` with one, which reads `thought_sources` too (the
`structure` group); when SMD-1997 folds
`thought_audit`'s transitions, the functions' bodies change and this script
does not.

**Startability** (SMD-2061). The lifecycle says a ticket is open, not that it
can be started. Migration 053 (SMD-1867) stores the board's relations as `link`
facets on the row holding a ticket's identity, `blocks` on the blocker and
`blocked_by` on the blocked, and `--startable` reads both directions (an edge
stated on one side only still counts). It multiplies a second factor into the
same weight: an **unsettled** thought whose ticket has an **open blocker**
weighs 0. Unsettled, because Linear keeps a relation after a ticket completes: a
Done ticket whose blocker is still open is settled, not blocked, and weighs what
its lifecycle says. A blocker is open unless its own lifecycle, resolved through
`source_thought()` and read by the ticket-head rule above, is completed or
canceled, so a settled blocker is not a blocker. Within a system that gates
(Sources, below: the board does), a blocker the brain does not hold, or one with
no status_type this tool knows, still blocks, and the output counts those. A row
derived from a ticket takes its ticket's blockers as it takes its status. Only
an active link counts (053 closes a relation the source dropped), and only
`blocks` / `blocked_by`: `child_of` makes nobody a blocker. A thought whose
ticket no gating dependency names counts as unblocked. The dependency caveat
line (`coverage.dependencies` in the JSON) gives the active dependency facets
and when the latest was written or closed, how many thoughts belong to a ticket
a (gating, below) dependency names on either side, how many the flag held back
in the run (took from a weight above 0 to 0), and how many of the held thoughts'
blockers are unsettled only for want of a known status. The edges are as current
as their source's last passes over both ends of a relation (board-sync's, for
the board): it is read from either side, so one removed at the source keeps its
effect, blocking where its system gates, until both are re-read. The flag
composes with `--status` and `--decay-done` (the weights multiply). Without it
(or `--decay-blocked`, below) the dependency read is not in the SQL, so every
other mode renders byte for byte what it did (the JSON's `options` carries two
more keys, `startable` and `decayBlocked`, both false) and a role without
`thought_sources` runs them.

**Blocked decay** (SMD-2181). `--startable` is a filter, so a blocked hub
vanishes rather than sinks. `--decay-blocked` reads the same dependencies by the
same rules and weighs a held thought `BLOCKED_WEIGHT` (0.25, pre-registered, one
weight) times its lifecycle weight instead of 0. It stays in the ranking, and
where it is listed it names its ticket's open blockers in a `blocked by` column
(`blockers` in the JSON rows; a Linear key bare, another system's as
`system:key`); the dependency line counts every down-weighted thought in the
run, listed or not. The filter and the decay are two answers to one question, so
the two flags are refused together, as `--decay-done` is beside `--status`. The
decay composes with `--status` and `--decay-done` by multiplying, though the two
decays never meet on one thought: a blocked thought is unsettled and
`DONE_WEIGHT` weighs only settled ones. Degree counts neighbours, not evidence,
and is unchanged by it. The JSON's `options` gains `decayBlocked: false`.

**Sources** (SMD-2218). The board is not the only writer of dependencies:
`ingest-records.ts --items` writes `blocks` / `blocked_by` for any system, and
both flags read them. A blocker is settled by its row's lifecycle, which a row
of another system has only if its source stated one (an items file, in
`facets.status_type`, one of the six types). So a system gates only when some
source row of it states a known status_type in its own metadata — a status a row
borrows through a Linear ticket claim does not count — and is then read exactly
as the board is, an unknown blocker blocking. A system that states none cannot
say a blocker is settled: its links gate nothing, blocking no thought and naming
no ticket, rather than hide its tickets for good, and the dependency line names
each source with its facets and says which gate nothing. While the board is the
only source, and states its lifecycle, the line reads as before. The JSON's
`dependencies.systems` lists each system's facets and whether it gates.

Exit 0 when ranked, 1 when no entity resolves (a near-miss whose only guesses
the numeric rule hid is still no entity: exit 1, and the line counts the hidden
guesses), 3 when the subject IS an entity — by id, name, alias or merged-in
name — that the numeric rule excluded (`--keep-numeric` would rank it), 2 for a
usage error, a brain without 016 or 058 (or whose 058 knows other status types
than the script) or a query that failed — never 1 for a failure or an
exclusion. `test-schema.ts` [44] runs the script's own SQL under PGlite over a
graph whose every count is known by construction, and its edges-on and
edges-off orders differ at every position; [54] holds 058's functions to the
contract a second reader relies on.

## Consolidation: proposing which thoughts supersede which

Migration 029 and `consolidate.ts`, its worker (SMD-1294). 025 gave `thoughts`
a `supersedes` column and `capture_thought` a way to set it, and nothing
populated it except a caller who already knew the answer at capture time. So a
decision captured in March and its reversal in June sat side by side, both
ranking on cosine alone, and `search_thoughts` handed a caller both with no
signal that one was dead. This is the loop GBrain runs overnight — sample
nearby pairs, ask a model whether they conflict, surface the result for review
— built from what the schema already had: 015's leases, 016's shared entities,
025's column, the metadata model.

**The one rule: the pass proposes, a person confirms.** The worker writes
`supersession_proposals` and never `thoughts`. From this table
`thoughts.supersedes` is written only by `review_supersession_proposal(id,
'accept')`, one proposal at a time — through `update_thought`'s provenance
envelope since migration 032 (SMD-1323), so the column has the one writer every
edit has; before 032 the function wrote it in an UPDATE of its own — under the
audit trigger with the reviewer as actor, so the audit trail shows who
confirmed what, and reversing a wrong one is one `--reject`. Nothing is applied
because a model said so; both GBrain's docs and the review of 025 arrive at the
same rule.

**Which pairs are judged.** `consolidation_candidates(thought)`: the older
thoughts that share at least one extracted entity with it, captured at least a
calendar day (UTC) earlier, nearest by exact cosine over that join, at or above
a floor, at most k — with pairs already proposed (in any state but 063's
`stale`) and thoughts already superseded left out, and, since 066, a pair one
side of which names the other in `derived_from` (a page and the evidence its
sections were generated from, a digest and its sources) never judged: a
derivation says what its input says by construction, and re-deriving is
`rebuild_derived`'s door, not supersession's (SMD-2292; direct members only,
the array is one level), and, since 079, a pair filed under two different
tickets that an active Linear link relates (`consolidation_tickets_linked`)
never judged: two records whose relationship is stated, each with its own
lifecycle (SMD-2448; unlinked tickets are still judged — a later ticket can
replace an earlier one's decision). Older-only means a pair is reached from its newer
side once, with no memory needed; the day rule keeps an import's burst from
being compared with itself (and means a same-day contradiction is not found,
stated rather than hidden). The shared-entity restriction is the cheap signal
before the expensive one: a conflict is about a subject both name, and the
judge cost is per pair. It also means a thought with no extracted entities has
no candidates, which is why the pool is **thoughts with entities, a vector,
that nothing supersedes, and no row under the key** (`consolidation_pool()`,
one definition read by the worker, its `--status` and preflight) — extraction
first, then consolidation, made structural rather than left to a trigger that
would judge a capture before
016's worker reached it and leave a terminal claim row behind. The gate cannot
see the other side of a pair: a newer thought judged while an older neighbour
is still unextracted is judged without it, and the pair is not revisited.
Since a candidate was captured on an earlier UTC date, a pass beside an
extract follower is safe for captures: their neighbours were almost always
extracted long before. What it misses is an older side that has no entities
or no vector yet when the newer side is judged:
- **Two captures either side of 00:00 UTC**, the earlier still in hand. One
  extract worker claims in queue order and finishes the earlier first; with
  two or more, the earlier can still be held.
- **A backlog.** A first run or a `--switch-key` pools every thought at one
  instant, claimed in no order, so drain it before consolidating (the
  `workers` compose profile, `deploy/README.md`, SMD-2424).
- **A failed extraction.** `--retry-failed` extracts it, but the newer
  thoughts already judged are not judged again.
- **A failed embedding.** A candidate needs a vector; `reembed.ts` gives it
  one, and the same holds.
- **An import dated older than thoughts already judged.** Same: its pairs
  with them are not judged.

The last three hold however the pass is run, once the newer thoughts have
been judged; a failed extraction or embedding repaired before that misses
nothing. k and the floor were chosen by measurement
(`evals/eval-consolidate.ts`; `evals/README.md` has the table) and are the
worker's `--k` and `--min-sim`.

**The judge.** One call per pair to the judge model — `OB1_JUDGE_MODEL`, else
the metadata model, so the harder task can run on a stronger model than every
capture's tagging (SMD-1901) — and only for a pair BOTH rows of which the
egress gate lets reach the chat endpoint (SMD-1903; the more restricted row
decides for the pair, a refused pair is recorded on the claim like a timeout,
and the banner's `egress:` line says what the run will do). `server-portable/consolidate.ts` holds the prompt: thought A (older) and B
(newer), dated, and one question — are they unrelated, related, does one
evolve from the other, are they a duplicate, or does one outdate the other
(prompt version 4, SMD-1873; p3 asked agree, unrelated or conflict, and called
119 of the 126 pairs a reviewer had rejected on the dogfood brain conflicts
again) — and when one outdates the other, which is current, decided from what
the texts say and not from the dates, with the words that show it quoted. A
supersession whose texts do not say is recorded `conflict_undirected` for the
reviewer to direct. Only `outdates` becomes a row; `related`, `evolves` and
`duplicate` relate two thoughts that both stand — a proposed duplicate would
hand one writer's near-copy the standing of another's thought, which three
review passes each found a way to do. Since 084 each is a **relation**: a
`relation` facet on the newer thought naming the older (`thought_facets`, kind
`relation`, origin `judged` — the kind's mark, not proof of the writer), stored
at the token probability of its word (else the written number) and written
only when the mass of related, evolves and duplicate together reaches the
floor (else the written number does), its lineage row (`derivations`, kind
`relation`) at the fingerprints judged, one standing per pair. A relation is
written once and only closed, and since 084 no facet changes its kind.
`record_thought_relation` keeps it when the pair is judged the same again,
replaces it when judged another word, key or score, and closes it
(`valid_until`) when a well-formed judgement sees none — unrelated, outdates,
or under the floor (a malformed or timed-out pair leaves it standing); the other
thought's delete closes it too, and the newer thought's takes it and its
lineage. `--status` counts the relations standing and `--list relations`
lists them, an edge whose text moved since flagged `EDITED SINCE JUDGED`
(until SMD-2726's `rebuild_derived` arm closes such an edge, clearing the
newer thought's claim — `DELETE FROM thought_work_claims WHERE work_type =
'<key>' AND thought_id = '<newer id>'` — has the next run judge the pair
again), one whose side is superseded or that another judge key wrote marked so
— the pass judges such a pair no more. On a brain without 084, or under a role
that cannot write them, the verdicts are counted only, and the run says so at
its start, in `--status` and in its summary; a follower re-checks on every poll,
and a write refused mid-pass stops relations there rather than failing the
thought. A pair judged then gets no relation until its claim is cleared. A role
granted before 084 that consolidates needs the structure group added (`bun
migrate.ts --url <owner's url> --grant <role> --groups
capture,server,worker,extraction,structure`; 084 adds no grant of its own). For a
brain that ran prompt 4 before 084, `--status` counts the thoughts judged
before 084 was applied and prints the `DELETE FROM thought_work_claims …`
that puts exactly those back in the pool, with the key (`--status`'s `job:`
line) filled in; check first that `--status` does not say a run under this
role would store none, since the re-judge costs the model calls of those
thoughts again whether or not it stores. The verdict rides
with its confidence, the judge's one-sentence reason (what a reviewer reads
first), the cosine, and the pass key `consolidate:<model>@p<prompt version>` —
the judge model on the row as 021 puts the embedding model beside the vector.
The confidence is the model's own token probability of `outdates` when the
endpoint returns logprobs (Ollama does for qwen2.5:7b, where the number the
model wrote was 0.80 on most pairs; whether the token probability ranks real
proposals is SMD-2705's to measure), else the number it wrote — also when the
alternatives naming a verdict held
under half the token's mass. The proposal's recipe in
`derivations` says which source (`judged.confidence_source`), with the judge's
verdict word, its token distributions, and whether its quote was found in the
side it named and not the other; the run summary counts proposals scored each
way. An endpoint and model that refuse `logprobs` with a 400 or a 422 and
then answer without it are asked without it for the rest of the run; an error
the retry gets too is the pair's own. A brain upgraded from p3 keeps p3's
pending rows, at their written 0.80, for a reviewer: the pass never re-judges
a pair that has one. `evals/eval-judge.ts` measures all of this on a
brain's own labels. The worker's agent id rides along as 016's mentions carry
theirs.

**Staleness**, the same pass's second output: `stale_entities(window)` names
the entities nothing has mentioned within the window, quietest first, each
with its newest capture.
`--stale` prints it; nobody acts on it.

### `consolidate.ts`

```bash
bun consolidate.ts --url postgres://…              # the backlog, then exit
bun consolidate.ts --url … --follow [SECONDS]      # …then keep polling for newly extracted thoughts, stamping a heartbeat each pass
bun consolidate.ts --url … --limit 25              # a trial: this many thoughts, then stop
bun consolidate.ts --url … --status                # the pass, and the queue
bun consolidate.ts --url … --dry-run               # what a run would do; writes nothing
bun consolidate.ts --url … --retry-failed          # failed rows back into the pool first
bun consolidate.ts --url … --list [pending|accepted|rejected|stale|lineage|all]   # lineage: unreviewed rows standing on a lineage pair (070)
bun consolidate.ts --url … --list relations   # the judged relations standing (084): related, evolves, duplicate, with both thoughts
bun consolidate.ts --url … --accept <id> [--direction newer|older] [--note "…"]
bun consolidate.ts --url … --reject <id> [--note "…"]
bun consolidate.ts --url … --stale [DAYS]          # entities quiet for DAYS (90; at most 2000000, inside Postgres's timestamp range)
#   --k N (3)  --min-sim F (0.6)  --min-confidence F (0.5)
#   --workers N (2; at most 2147483647: a connection each and a spare, Bun's pool max of 2^31)  --batch N (1; at most 2147483647, claim_thoughts' int)  --ttl SECONDS (900)  --heartbeat SECONDS (60, or a third of the lease; at least 1, and the lease must cover two)  --timeout SECONDS (120, per model call — this flag, as extract-entities.ts's, not OB1_LLM_TIMEOUT; at most 9007199254740, a call signal's range)
bun consolidate.ts --url … --accept <id> --force            # a thought edited since judged, a stale row, or a lineage pair (070)
```

**The cost, stated up front.** Up to `--k` calls to the metadata model per
thought with entities, recurring: every thought extracted after a run is judged
against its older neighbours by the next run or a `--follow` process. Locally
that is compute; on a hosted provider it is money per pair and BOTH thoughts'
text goes to the provider. `--dry-run` says how many thoughts a run would
judge before it judges any. Measured on the fork's 576-issue corpus at the
shipped `--k 3 --min-sim 0.6` with `qwen2.5:7b`: 517 pairs, one call per thought
with entities, 21 minutes, about 1,750 prompt tokens a call; 13 proposals, six
of them real on a hand grading — two per hundred thoughts, half worth accepting
(`evals/README.md` has the table and what the judge gets wrong).

**Reviewing.** `--list` prints the queue most confident first, each with the
judge's reason, both thoughts with their capture dates and `ID:` lines, and
the two commands that decide it; the MCP tool `list_supersession_proposals`
prints the same queue to a client. The reason sits on one line behind its
label (`reason:`, `Reason:` in the tool) and a review note on its status line,
each line break a space and each cut at 400 characters, so a judge steered by
a thought's text cannot start a line of its own — an `ID:` line a reader would
take as a thought's (SMD-2533). A row standing on a lineage pair — one
side's `derived_from` names the other, a page and its evidence — is tagged
`LINEAGE PAIR` with the reject to run (`--reject <id> --note "lineage pair
(066)"`); `--list lineage` lists the unreviewed ones, pending then stale, and
`--status` counts them (070, SMD-2313); `--accept` on such a row is refused
naming the reject unless `--force` says the pointer is meant — a guard on the
one accept door, not a verdict — and a row accepted before the pair became one
is tagged under `--list accepted` with `--reject <id>`, which clears the pointer
(029), as the repair. `--limit` is the pass's cap and is refused beside `--list`. `--dry-run` and `--status` are refused beside a decision, which they never stopped from being written (`--accept <id> --dry-run` accepted the proposal), and beside `--list` or `--stale`, which take the pass's place (SMD-2405); `--list` and `--stale` beside a decision read after it is written. Such a pair is never proposed since 066, and a
standing row is the reviewer's alone: the pass never replaces a pending one,
and settles a stale one on its next run (067). `--accept` writes the pointer
on the thought the verdict names as current (or the one `--direction` names — required for an
undirected verdict, and an override for a directed one) and refuses what would
leave the column wrong: the superseding thought already pointing at a third
thought (the column holds one predecessor; which is the reviewer's call), or a
pointer that would close a loop. `--reject` marks the row and, if it had been
accepted, clears the pointer while it still holds this proposal's value. A
decided pair is never proposed again, whatever happens to the claim table.
The verdict is about the texts as judged: each proposal records both
fingerprints when it is written, `--list` and the tool mark a thought edited
since, and `--accept` refuses such a pair unless `--force` says the reviewer
has read both texts as they are now. The fingerprints are of the texts the
judge was sent, taken with the text, so an edit that lands during the judge
call is visible too. When an acceptance writes the pointer (not when the column
already held the value) it moves the superseding thought's `updated_at` (001's
trigger fires on any column), which two readers take as an edit: a client's
`if_unchanged_since` from before the acceptance is refused, and 021's evidence
rule stops vouching for that thought's vector, as after any edit.

**Stale rows (063, 067).** A pending proposal whose text moved under the
verdict is set `stale` by `rebuild_derived` (an edit, a supersession, a
forget) and its newer thought requeued under the key that judged it. A stale
row is the next pass's work whatever key wrote it: every run re-pools each
stale row's newer thought under its own key (a pair both sides of which have a
vector, with no live or failed claim there — a failed claim is
`--retry-failed`'s), judges the thought's pairs
again — up to `--k` model calls per re-pooled thought, since its unrelated,
related and evolves pairs left no record, plus one per stale pair the top-k left out
that still meets the candidate rule, judged anyway — and either **replaces** the
row in place (an outdates at
the floor: `record_supersession_proposal`, back to pending under this key) or
**settles** it (unrelated, related, evolves, duplicate, an outdates under the floor, or a pair the
rule no longer admits — the note names which term: a side superseded, a
lineage pair (066: one side derived from the other), no shared entity, under
this run's similarity floor with the cosine; a stricter
`--min-sim` than the pair was proposed under settles it, the flag being the
rule): a rejection whose note begins `settled by the pass:`, the
lineage row rewritten at the texts judged (`settle_supersession_proposal`). A
text move under a pass-settled row sets it stale again; a person's rejection
stands for ever. A side without a vector waits for the reembed pool and the
run after its write; a stale pair whose call timed out, was refused by the
egress gate or drew a malformed answer leaves the row stale and the thought
failed, for `--retry-failed`. `--status` places each stale row against this
pass's pool — in it, waiting for a vector, failed in this pass, waiting for
the next run (a claim under another judge's key named beside it; `rebuild.ts
--status` reads the same rows without a key and names the keys) — and counts the pass's
rejections apart from a person's; `--list stale` tags each row's standing
and still offers the reviewer's decision (an accept takes `--force`).

**Identity** as `extract-entities.ts`: `OB1_WORKER_KEY` a key whose hash is in
`MCP_ACCESS_KEYS`; proposals carry the resolved agent id, and an acceptance is
audited under the key's name with the pass key as session. Without it the run
says so and proceeds unattributed.

**What preflight sees.** `consolidate pass` warns while a pass under any
`consolidate:` key has rows pending, leased or failed — the counts over the
thoughts with entities, and the command that finishes it under the key's own
judge model — and otherwise says `none unfinished`. The queue it leaves is the
`proposals` row's (SMD-2680): how many are pending, how long ago the oldest was
judged, how many pair two tickets the board does not link (079's links and a
`duplicate_of`, read now: a link made after the verdict takes the pair out) and how many
are stale, with `--list`
and the `list_supersession_proposals` tool. A queue is a reviewer's to work, not
a defect, so the row is ok while it is young and warns — never fails — once the
oldest pending verdict is older than `OB1_PROPOSALS_WARN_DAYS` (whole days, 7
unset; a pass that re-judges a stale proposal restarts its clock); `brain_info` and keyed `/health` carry the same counts, and the judged
relations standing by word beside them, so an unattended sleep pass's findings
show without a query. A key a worker holds a live lease under,
or whose follower stamped a fresh heartbeat and has not ended (between polls it
holds none), reads *running*, ok and with no remedy — a warning only for failed
rows beside it, which a follower never retries, naming the `retry_failed` tool;
one whose only leases expired names a worker that died holding them. A key
whose follower stopped or went stale points to the `workers` row's restart,
which finishes the pass, rather than a one-shot run beside it — even while the
claims a killed follower held keep live leases until they lapse (SMD-2423,
SMD-2261). A re-embed run killed outright reads running until its lease ends:
it has no heartbeat to say otherwise.

**Verified.** `test-schema.ts` [28] holds the candidate rule's every exclusion,
the one write, the review path's states and refusals with the audit row, the
queue and staleness against PGlite; `test-live.ts` [16] runs the worker end to
end against a stub judge — the audited accept under the key's name, the reject
that clears, a cleared claim table not re-proposing a decided pair, the pool
picking up a thought extracted since. `test-store-sql`/`-postgrest` [10] cover
the tool's read on both stores; `test-preflight` the line.

## Rebuilding derived artifacts (SMD-1732)

Migration 063's `rebuild_derived` is the one operation over the lineage table
061 built (its paragraph under "The migrations" says what it does per kind).
The rule it carries: the database re-derives only what it holds the inputs
for — a vector whose current text already has a snapshot row at the model —
and hands everything else to the worker that owns the recipe, through 016's
`requeue_thought_work`, under the worker's CURRENT key (what `db/reembed.ts`,
`db/extract-entities.ts` and `db/consolidate.ts` drain), with the reason
written on the lineage row (`stale_since`, `stale_reason`) until the
producer's next write clears it. A row whose artifact is gone is deleted. A
`derived_from` child is listed as irreproducible — prose no recipe re-runs —
and left standing. The tags have no pool: no worker re-tags a thought, so a
stale tags row is marked and waits for a re-capture or an edit that carries
the extractor's recipe.

### `rebuild.ts`

```bash
bun rebuild.ts --url … --input <id> [--reason <text>] [--force] [--dry-run]
bun rebuild.ts --url … --input <id> --gone [--fingerprints fp1,fp2] [--dry-run]
bun rebuild.ts --url … --orphans [--limit N] [--dry-run]
bun rebuild.ts --url … --status
```

`--input` calls the function once and prints its report — `rebuilt`,
`enqueued` (distinct (thought, pool) claims), `deleted`, `marked` (and how
many of those wait for no pool), `kept`, `current` (with the legacy count:
061 backfilled at the thought's current text, so a legacy row reads current
until `--force`), the irreproducible children, and every pool that gained
rows with the command that drains it. `--reason` defaults to
`operator: edit` / `operator: force` / `operator: forget`; say a better one —
it is what the marked rows carry. `--gone` is SMD-1723's shape (the input is
leaving): the row must still stand when it runs, since 061's drop trigger
leaves nothing to walk after a delete; the tool deletes no row and says so;
`--fingerprints` hands in the earlier texts' fingerprints the log holds, and
the function removes the snapshot rows at them where no standing thought
holds the same text. `--orphans` finds the lineage rows whose artifact is
gone while the thought stands — preflight's `lineage` WARN names this flag —
and calls the function once per thought. `--status` is the census: rows per
kind, the stale-by-fingerprint count, the marked count, the orphans, the
legacy rows, the stale proposals and where each stands against the judge
pools (067), and the pools with pending rows.
`--dry-run` runs the call inside a transaction and rolls it back: the report
is the function's own and nothing is kept. The tool calls no model and holds
no lease. Exit 0 ran; 1 the function refused as a value (`NOT_FOUND`,
`REPLAYING`) or a run failed; 2 usage, no URL, or a brain without 063. It
runs `SECURITY INVOKER` code over four groups' tables (capture, worker,
extraction, and the server group's `SELECT` on `ob1_config`), so the role needs
every group `migrate.ts --grant` issues — the worker group gained `DELETE`
on the snapshot for it (the grants table). test-live [31] drives it.

## Sleep: the passes while the brain is quiet (SMD-1794)

`sleep.ts` runs extraction and consolidation while the brain is quiet, and
stops them within `--poll` seconds of the first live call being recorded —
"dolphin sleep": one half works while the other keeps answering. The header
of `db/sleep.ts` holds the mechanics; this is what an operator needs.

```bash
bun sleep.ts --url … --follow      # sleep whenever the brain is quiet, for ever
bun sleep.ts --url …               # wait for quiet, sleep once until both pools drain or a call wakes it
bun sleep.ts --url … --dry-run     # the idle reading and each pass's pool; writes nothing
#   --quiet SECONDS (300)   --poll SECONDS (5; at most 60)   --workers N (1 for each pass: N extraction and, once it joins, N consolidation calls at once)
#   exits 0 done, or --follow stopped by one signal · 1 one sleep woken before both pools drained, a pass that ended by itself with 0, or an uncaught error · 2 usage, configuration, or a pass's refusal (under --follow, all but a start refusal by a pass that got past its start earlier, which is retried) · 130 a signal before one sleep ended, or a second signal
```

**Running it.** Until SMD-2678's compose service, on the compose stack (whose
Postgres publishes no port) run it in a one-off container of the `extract`
service, which mounts the checkout and carries the server's model settings,
`MCP_ACCESS_KEYS`, the owner's `DATABASE_URL`, and `OB1_WORKER_KEY` when
`deploy/.env` sets it — the command replaces the service's, so its refusal
without the key does not apply, and the passes then say they write with no
agent id. In the foreground, stopped with Ctrl-C; nothing restarts it:

```bash
podman compose -f deploy/compose.yaml --profile workers run --rm --no-deps extract bun db/sleep.ts --follow
```

Elsewhere it needs the same: the server's model settings (`OB1_METADATA_MODEL`,
`OB1_JUDGE_MODEL`, the endpoint and its egress declaration — or the passes work
another job key's pool), `OB1_WORKER_KEY` with `MCP_ACCESS_KEYS` for an agent
id on what they write, and a role a plain `migrate.ts --grant` provisions (the
`capture`, `worker` and `extraction` groups, `server` for the worker key). It
has no `--job`.

**What wakes it.** A write the audit recorded through a key not classified
`ingested`, and — only for the owner, and only under the server's
`OB1_QUERY_LOG=on` (off by default) — a read the server logged. Under a
`--grant` role, or with the log off, only writes wake it; the start says which.
board-sync's key is classified `ingested` on the stable brain; an unclassified
key's writes wake it (reembed, ingest-records, a migration's backfill) until
`SELECT set_agent_kind('<key name>', 'ingested')` says they are background
work. The passes it runs write no audit row, so they never wake it.

**What it does asleep.** Extraction alone until its pool drains, then
consolidation beside it — the order "Start `extract` alone on a backlog" asks
of an operator. A wake hard-stops both: every lease returned, the model call in
hand aborted, the thoughts in hand moved to the back of the queue. A thought
longer than every sleep is never finished while the brain keeps waking, and
consolidation does not join while it is pending (SMD-2694). A failed row stays
failed: `--retry-failed` is the operator's. A pass refusing at its start (the
model not served, the key refused) after it got past its start earlier in this
process is retried on SMD-2599's schedule (5 s, doubling, at most 5 min): that
mends a model re-pulled, a 402 cleared by topping up credit, a gateway's
passing 401/403/404 — not a revoked worker key or another process's
`--switch-key`, which are retried until you restart it with the right key. A
refusal at a pass's first start, or mid-pass (the provider refusing the
request itself), ends the scheduler with 2, as it ends a follower — so the
same 402 ends it mid-pass and is retried when a sleep's start meets it first.

**Heartbeat.** `--follow` stamps `heartbeat:sleep` at least every minute:
preflight's `workers` row reads "running a pass" while asleep, "alive" while
awake, "its last pass failed" while a pass's last word was a failure (into the
next sleep, until one of its passes stamps), and stopped once it ends. A pass
waiting at its start for a provider that does not answer stamps nothing, so the
row keeps its last word then. Its `consolidate pass` row reads a fresh one as the
scheduler working the current judge's key, rather than asking for a second
worker. Retiring it: `DELETE FROM ob1_config WHERE key = 'heartbeat:sleep'`.

**From the `workers` profile.** Its followers do not yield. Stop them
(`podman compose -f deploy/compose.yaml --profile workers stop extract
consolidate`), stop starting them (take `workers` out of `COMPOSE_PROFILES` in
`deploy/.env`, and out of any `--profile workers up`), and delete their
`heartbeat:extract:…` and `heartbeat:consolidate:…` rows, or preflight's
`workers` row asks for them back. The start and `--dry-run` name any with a
fresh heartbeat.

Not yet here: a budget per pass and per sleep and the re-derive pass
(SMD-2679), a compose service with preflight's own `sleep` row (SMD-2678).
test-live [38] drives it against a stub model.

## Extensions

The core schema needs **`vector`** and, since migration 011, **`pg_trgm`**.
`gen_random_uuid()` has been a Postgres built-in since 13 and `sha256()` since 11,
so `pgcrypto` is not required — despite five files elsewhere in the repo creating
it.

`pg_trgm` is created unconditionally. The index it exists for was opt-in until
migration 012 gave it a caller — `search_thoughts_keyword` — and is now **on by
default**, with `OB1_TRGM_INDEX=off` to omit it. The extension alone is inert:
catalog rows, no storage on the table and no cost on any write. Creating it
regardless is what makes enabling the index later a single statement instead of a
statement plus a privilege.

The flag is read only when 011 **applies**. Flipping it afterwards and re-running
the migrator does nothing, so `preflight.ts` compares the setting against
`pg_indexes` on every boot and prints the one statement to run. Every deployment
that applied 011 before this change is in that state by default: keyword search
works and sequentially scans until the index is built.

The two extensions differ in what they demand of the role applying the migration.
Measured on PG16 (`pg_available_extension_versions.trusted`), `pg_trgm` is a
*trusted* extension and `vector` is not — so a database owner can create pg_trgm
without superuser, while 001 already needs the stronger privilege. 011 adds no
requirement that was not already there.

## Benchmarking the trigram index and the keyword function

`bench-trgm.ts` measures what migration 011 costs and buys, because the number
SMD-925 arrived with was measured on somebody else's brain and does not transfer.

```bash
./with-postgres.sh bun bench-trgm.ts
OB1_BENCH_CORPUS=/path/to/corpus.json ./with-postgres.sh bun bench-trgm.ts
```

Without a corpus it generates from a built-in vocabulary. Pointed at one it builds
a bigram model of that text and samples from it, so the trigram distribution
resembles the real one — duplicating rows verbatim would collapse the index's
distinct-gram count and flatter it enormously. The corpus is only ever read.

Markers are planted at known frequencies (5 rows, 10%, 90%) so selectivity is a
controlled variable, and the two-character probe matches exactly the same rows as
the rare-word probe — so the sub-trigram limit is isolated from selectivity rather
than confounded with it. The number of matched rows is printed alongside each
timing, because a probe that accidentally matches nothing otherwise looks like the
best result in the table.

The headline result on our own data, and the reason the migration header is as
long as it is: **the crossover is somewhere between 1,000 and 10,000 rows.** Below
it the index is not slower, it is simply never chosen. Above it a 5-row `ILIKE`
improves by ~350x at 10,000 rows and ~1370x at 100,000 — but a word in 10% of rows
gets only 8-9x at either size, and a common word and any sub-trigram pattern are
unaffected at every scale. The full table, with the write cost beside it, is in
the header of `migrations/011_text_search_trgm.sql`.

### bench-querylog.ts

The two `query_log` costs SMD-1492 settles with numbers rather than prose. It ages
search rows so `prune_query_log` deletes only the oldest tenth — the small old tail a
real retention prune trims, the selective range the index is for, not the half-table
delete a Seq Scan would win anyway — on a fresh schema (every migration, so migration
047's `logged_at` index is built by the schema), then runs the retention `DELETE`
under `EXPLAIN (ANALYZE)` — rolled back so both arms see the same rows — with the
index and again with it dropped, reporting the plan for each and flagging the
Seq-Scan→index-scan flip only where it was actually observed (at small scales the
table is cheap enough that Postgres scans regardless — the crossover).

The write cost is two separate arms. One times a single **bulk** INSERT of
`WRITE_BATCH` rows into two tables differing only by the index: the round trip is
amortized across the batch, so the difference is the btree's per-row maintenance —
the "fourth index write cost" the ticket weighs, and the number a future BRIN
follow-up would try to erase (below the noise floor at these scales). The other
times `AWAITED_PROBES` **single** awaited INSERTs, one round trip each, on the
index-present table: that per-call millisecond is what `OB1_QUERY_LOG=on` actually
makes a search or fetch wait for before it returns, the cost the "keep the await"
decision accepts (a single awaited INSERT cannot isolate the µs-scale index cost —
the round trip swamps it — which is why the two are measured apart).

```bash
./with-postgres.sh bun bench-querylog.ts
OB1_BENCH_SCALES=1000000 ./with-postgres.sh bun bench-querylog.ts
```

Without a container it does nothing (`requireDatabaseUrl`); PGlite's tiny tables
would seq-scan whatever the index, which is why the prune teeth live here and not in
`test-schema.ts` (which asserts only that the index exists).

### bench-hnsw.ts

What a filtered `match_thoughts` returns against an exact scan of the same rows,
and whether the candidate LIMIT above the default count is honoured. Random
64-dimensional vectors with filter tiers planted at 50%, 10%, 1%, 0.1% and
0.01% of the table and at a fixed 900, 2,000 and 5,000 rows whatever the scale;
the function as shipped by 001–013, then 014 and every later migration applied
onto the same rows — the plans are read from the catalog, so the after arm holds
the function a deployment actually has.

```bash
./with-postgres.sh bun bench-hnsw.ts
OB1_BENCH_SCALES=10000,100000 ./with-postgres.sh bun bench-hnsw.ts
./with-postgres.sh bun bench-hnsw.ts --plans     # print the full plans
OB1_BENCH_LOAD=1,10 ./with-postgres.sh bun bench-hnsw.ts   # section F: under load at one and ten connections

# At scale (SMD-1018): one scale per container, and give the container the
# shared memory the parallel HNSW build keeps its graph in — at least the
# maintenance_work_mem the bench builds with (1 KB a row by default; the
# script's default /dev/shm of 1 GB covers the two published scales). The
# size is a cap on the VM's RAM, not a reservation: the ten-million-row run
# needs a podman machine or Docker VM with more than 11 GB (14.8 GB was
# used; `podman machine init` gives 2 GB), or OB1_BENCH_BUILD_WORKERS=0 to
# build serially in backend memory.
OB1_BENCH_SCALES=1000000  OB1_PG_SHM_SIZE=4g  ./with-postgres.sh bun bench-hnsw.ts
OB1_BENCH_SCALES=10000000 OB1_PG_SHM_SIZE=11g OB1_BENCH_MAINTENANCE_MEM=9GB ./with-postgres.sh bun bench-hnsw.ts

# Server settings for a run (SMD-1499): `-c name=value` pairs handed to
# postgres, each checked before the container starts. SMD-1499's sized runs
# set shared_buffers to the HNSW indexes' size this way.
OB1_PG_ARGS="-c shared_buffers=1GB -c work_mem=16MB" OB1_BENCH_LOAD=1,10 ./with-postgres.sh bun bench-hnsw.ts

# Before/after a redefinition of match_thoughts, from one tree: the after
# arm's schema stops at the named migration (the function before 040 here;
# 038 for the function before 039, 037 for the one before 038). Not with
# OB1_PG_KEEP below: a corpus cut at a migration is measured and dropped,
# never kept.
OB1_BENCH_UPTO=039 ./with-postgres.sh bun bench-hnsw.ts

# Keep the corpus between passes (SMD-1493): the first run under a name builds
# it and records the exact oracle's answers beside it (SMD-1562); every later
# run under the same name finds it, checks it, applies any migration the tree
# gained since, and skips the load, the builds and the exact pass. One corpus
# per name. A corpus kept under a tree before migration 039 is the exception:
# 039 rebuilds the two HNSW indexes as new relations, which the marker's
# physical fingerprint would read as the corpus rewritten, so the bench
# refuses such a reuse from the migrator's dry run, before anything is built
# — remove the volume and build again under this tree.
OB1_PG_KEEP=hnsw10m OB1_BENCH_SCALES=10000000 OB1_PG_SHM_SIZE=11g OB1_BENCH_MAINTENANCE_MEM=9GB ./with-postgres.sh bun bench-hnsw.ts
podman volume rm ob1-pg-keep-hnsw10m   # when done with it (the exit line prints this, with the runtime as found)
```

Queries are random vectors, not perturbed copies of a target. A perturbed copy
makes the target the global nearest neighbour, which no post-filter can lose;
the first draft did that and reported perfect recall for a function that returns
nothing at 1%. The exact answer is computed once per query and tier and both
arms are scored against it. Two tiers exist for the scan's failure shape rather
than the filter's: one with fewer matching rows than the candidate budget, and
one matching nothing — under 014 both take the exact branch, which is the
point. The three fixed-count tiers exist for the scale question: 900 rows is
the exact branch at its widest whatever the table holds, 2,000 rows is the walk
with the most tuples to pass (`v_fetch × N / matches` — 200,000 at ten million
rows, past the seeded cap), and 5,000 rows is the walk the seeded cap covers at
ten million rows but pgvector's default does not; a fixed count is planted only
where it is under half the table, and the run says which it dropped or merged
with a share tier. Section L reports the load:
insert rate, HNSW build time under the `maintenance_work_mem` used, and table
and index sizes. Section A also times asking for the function's ceiling (500
rows). Section C reads the live function body from the catalog, extracts each
filtered branch's statement with its plpgsql variables rewritten as parameters,
and EXPLAINs it under both custom and generic planning on the filter the
function routes to it (the walk on the thinnest tier above the threshold, the
exact branch on the broadest under it, the routing count on the broadest, the
thinnest and the empty filter, and the gate's sample of the heap — which gates
that count on a large table: 037's TABLESAMPLE, eight TID range probes since
038 — on the same three), because plpgsql may use either
plan. Section D
runs the walk's own statement on the thin and empty filters — which the
function never walks for — under a forced generic plan, to show what the seeded
scan bounds do when the walk is reached with next to nothing to find. Section
E runs every tier the function routes to the walk THROUGH the function under
the seeded bounds and again under pgvector's defaults, beside what the exact
branch would return and cost for the same tier if the threshold were raised to
cover it — the table 014's header's decision about the bounds rests on. The
headline table is in the header of `migrations/014_filtered_match_thoughts.sql`;
the scale tables are in FORK.md change 28; the real-corpus version is
`evals/eval-filtered.ts`.

Section F runs only when `OB1_BENCH_LOAD` names connection counts (SMD-1500).
`1,10` is one connection and the server's default pool of ten. It runs last for
its scale, so the sections above are measured as before. N connections, each its
own backend, call `match_thoughts` closed-loop for `OB1_BENCH_LOAD_S` seconds
(60) a run. There are three mixes:
- the unfiltered default path alone;
- the broad filter alone;
- a broad, a band and a thin filter in turn, one call each (50%, 1% and 900
  rows; at a million rows and up, the HNSW walk, the tier whose plan flips
  between GIN and the walk, and the exact branch).

It prints QPS per run, and per slot its calls, p50 and p99 beside sections A
and B's single-call medians, and how many of the exact top 10 its answers
hold. It also counts the answers that differed from a reference pass's (each
query asked once, on one connection, before the runs); the one-connection run
is that count's control. The database container's anonymous memory is sampled
from its cgroup through `pg_read_file` (a superuser on Linux; otherwise the
table says why not), against what 014's header prices the walks at. Its CPU
time and the rest of the machine's are read across each run, so a table says
how busy everything else on the machine was meanwhile: other containers, the
kernel and the machine's side of the network path (and, on a Linux host with no
VM between, the bench's own client). A failure under load is reported without
discarding the other sections, and the bench then exits 1. `bench-load.ts`
holds the loop; test-schema [73] holds its pure parts, test-live [39] the loop.
Six runs at 60 s add about seven minutes a scale.

The before arm runs only up to 100,000 rows: its defect is established there,
and above that every question is about the shipped function. The rows are
streamed from one seeded generator in two passes — the vectors, the queries
and the share tiers' membership at the published scales are exactly the
published corpus's; each row's metadata also carries the fixed-count tiers it
fell into, so the heap and the GIN index are a little wider — into a table
whose secondary indexes have been dropped and whose user triggers are
disabled, and the indexes are rebuilt after the load, timed. Bun's SQL driver
has no COPY protocol, so the rows go in as multi-row INSERTs, and only the
round-trips are timed; the load is never the long part, the index build and
the exact oracle are. A million rows takes
about seven minutes; ten million about forty and a container with 11 GB of
shared memory to build in; a hundred million is ~26 GB of vectors before the
index and was not run here (FORK.md change 28 says what a run needs).

Thirty of those forty minutes are the load and the builds, and the corpus is
deterministic, so a pass need not pay them twice. Under `OB1_PG_KEEP=<name>`
the container and a named volume outlive the run (see [Testing](#testing)),
and a scale above 100,000 rows is kept: once the load and every build have
finished the bench writes a marker row (`bench_hnsw_corpus` — the scale, the
parameters that shape the rows, the tier counts, section L's numbers), and the
next run at that scale finds it and reuses the corpus instead of rebuilding
it. What vouches for the rows is checked, not assumed: both row counts and the
corpus's first and last rows regenerated from the seed and compared, first;
then the migrator's ledger against the tree (the whole-schema arm is applied
through `migrate.ts` for this) — a recorded name the tree has no file for is
refused; then `migrate.ts --dry-run` and `migrate.ts` — a file edited since
the build is refused on the dry run's `DRIFTED` before anything runs, a
migration added since is applied onto the corpus, and any change to the
tables' rows or files since the build — the marker records each relation's
counters and file — refuses the corpus (its heap and graphs are no longer
the bulk-built ones) and marks it so every later run refuses too;
then both HNSW relations are read into the page cache, this run's queries'
confound is taken from the exact pass, and the oracle's premise is re-checked
whenever the ledger differs from the one it last passed under. The exact pass
itself is not paid again either (SMD-1562): it is most of a reuse's minutes at
ten million rows — about 450 full scans — and its answers are a pure function
of the rows, the queries and the oracle's statement, so the marker keeps them,
keyed by a digest of that statement (per tier and for the whole table, each
query's exact top-10 in distance order and the nearest cosine, with a digest
of each query). A reuse takes the answers whose queries are its own — the
stream's first Q are the same whatever the count asked, so the leading ones —
computes only the ones it lacks (a run with a larger `OB1_BENCH_QUERIES`, a
marker from before the answers were kept, a tree whose statement differs),
and writes its entry back beside any other tree's. Before it computes, the
plan the exact scan gets is read once and refused if it reaches the vector
index. The answers are trusted exactly as far as the rows are: they ride
inside the marker the checks above protect, and a corpus that changed is
refused before they are read. Section L's `source` column says `loaded` or
`reused (built …)` per scale and its `oracle` column `computed`, `reused` or
`n of Q reused, the rest computed`, and the run prints what it counted, which
files it applied and where the answers went. `test-bench-reuse.ts` holds the
reuse to the computation at 150,000 rows (see [Testing](#testing)). Under
`OB1_PG_KEEP` a run is exactly one scale above 100,000 rows, refused otherwise
before anything is connected to or dropped (an empty kept volume is the worst
such a refusal leaves, and the exit line names it): a kept database holds one
corpus, and the
published scales are never kept — the before arm needs 001–013 under the rows,
and a build that size is seconds — so run the small scales, or several
scales, without it. A kept database holding another scale than the one asked
for, or the same scale built from other parameters, is refused up front,
before anything is dropped: a kept build is never replaced without being
asked. Measured at ten million
rows: 37 min 9 s for the run that built the corpus, 7 min 24 s for the one
that reused it, with identical recall columns; at a million rows, 6 min 49 s
and 3 min 45 s. With the exact pass's answers kept in the marker (SMD-1562)
a reuse skips that pass — about five of a reuse's minutes at ten million
rows alone, most of the seven — and is into section A within three minutes
of connecting; sections A–E are cell for cell what a reuse that computed
them prints (FORK.md change 76 has the runs, measured on a shared machine).

### bench-plan.ts

Whether the *unfiltered* `match_thoughts` reaches the HNSW index, at the width
this fork ships (upstream #469, SMD-969). `bench-hnsw.ts` explains only the
filtered branches, at 64 dimensions; this one explains the unfiltered branch's
own statement — read from the catalog, as section C above does — at
`EMBEDDING_DIM`, under `EXPLAIN (ANALYZE, BUFFERS)`, at match_count 10, 50 and
500, in five arms: the function as 014 plans it, the same with `enable_seqscan
= off`, the same with `random_page_cost = 1.1` (the cost-model remedy the
ticket asked to weigh), the deployed function under its own SET clauses at
weight 0, and the deployed function with `recency_weight = 0.3` (migration
020) — the same
scan over a window four times wider, which is what a caller who opts into the
blend pays: at 10,000 rows and the default count,
1.8 ms and 3,434 buffers become 5.1 ms and 9,558, both candidate CTEs still
`Index Scan`; at count 50, 6.3 ms become 16.9; at the ceiling, 33 become 79;
at 100,000 rows, 2–3 ms become 8, 12–14 become 84 and 170 become 365, the
scans unchanged.

```bash
./with-postgres.sh bun bench-plan.ts                     # 1,000 / 10,000 / 100,000 rows at EMBEDDING_DIM
OB1_BENCH_SCALES=1000,10000 ./with-postgres.sh bun bench-plan.ts
OB1_BENCH_DIM=64 ./with-postgres.sh bun bench-plan.ts   # bench-hnsw's width, for contrast
./with-postgres.sh bun bench-plan.ts --plans             # print the full plans
```

The headline, 1,024 dimensions, one thought in five with a chunk row, the node
that produced each candidate CTE's rows and the shared buffers the whole
statement read:

| rows | heap / TOAST | count | as 014 plans it | buffers | `enable_seqscan = off` | buffers | `random_page_cost = 1.1` |
| ---: | --- | ---: | --- | ---: | --- | ---: | --- |
| 1,000 | 120 kB / 5.4 MB | 10 | seq / seq, 2.7 ms | 8,032 | index / index, 0.8 ms | 1,887 | index / seq |
| 1,000 | | 50 | seq / seq, 2.9 ms | 8,032 | index / index, 2.1 ms | 5,675 | seq / seq |
| 10,000 | 1.2 MB / 53 MB | 10 | index / **seq**, 5.3 ms | 15,412 | index / index, 1.8 ms | 3,404 | index / index |
| 10,000 | | 50 | seq / seq, 28.8 ms | 80,317 | index / index, 6.5 ms | 11,143 | index / seq |
| 10,000 | | 500 | seq / seq, 30.8 ms | 80,317 | index / index, 32.4 ms | 57,406 | seq / seq |
| 100,000 | 12 MB / 527 MB | 10 | index / index, 2.7 ms | 4,449 | the same plan | | index / index |
| 100,000 | | 50 | index / index, 12.1 ms | 17,391 | the same plan | | index / index |
| 100,000 | | 500 | seq / seq, 275 ms | 1,016,132 | index / index, 170–290 ms | 115,370 | index / seq |

Buffers are shared hits *and* reads — the default 128 MB of `shared_buffers`
cannot hold a 527 MB TOAST relation, so the large seq scans land mostly in
reads. The second table the bench prints is the filtered statements under
both settings, since the clause is function-wide: the routing statement takes
the GIN bitmap either way, the exact branch is unchanged, and the walk's plan
is the same or better (its chunk side moves from a seq scan to its HNSW index
at 10,000 rows).

The mechanism is in the heap / TOAST column: at 1,024 dimensions a vector is
~4 KB, past the TOAST threshold, so at 10,000 rows the heap is 912 kB and the
TOAST relation 53 MB. The planner prices a sequential scan by heap pages and
never counts the detoast reads — it estimated 114 pages, the scan read 66,780
buffers — so the estimate is wrong in kind, not by a factor, and a lower
`random_page_cost` moves the boundary without removing it. The sequential scan
is chosen wherever the heap is small: at the shipped width that is every brain
up to some tens of thousands of thoughts — the chunk table first, since it is
"small" in heap pages while every one of its rows is a vector — and the
ceiling at every size. At 100,000 rows the heap alone is 1,225 pages and the
estimate turns for the counts callers send, so the setting changes nothing
there but the ceiling, where the index touches a ninth of the buffers. At 64 dimensions the
vectors are inline and the planner is right, which is why the 64-dimensional
bench could not see this. The full table is in the header of
`migrations/019_match_thoughts_plan_and_rows.sql`; `test-live.ts` [5c] holds
the decision in CI at 2,000 rows.

### bench-keyword.ts

`bench-trgm.ts` measures a bare `content ILIKE '%needle%'`. `bench-keyword.ts`
measures the three things migration 012 added on top of it, none of which the
earlier benchmark can speak to:

```bash
./with-postgres.sh bun bench-keyword.ts
```

**Whether an escaped pattern still reaches the index.** `search_thoughts_keyword`
escapes `_` and `%` before wrapping the needle, because unescaped they are ILIKE
wildcards and `upsert_thought` would also match `upsert-thought`. But `_` is the
most common character in the identifiers the feature exists to find, and nothing
had checked that pg_trgm can extract grams across `\_`. It can: the index is used
at 10,000 and 100,000 rows, on the first call and on twelve more.

Those twelve extra calls are there because plpgsql may switch to a **generic
plan** after five executions of the same statement, built without knowing the
pattern. If one ever chose a sequential scan the function would be fast five
times and then far slower for the rest of the session, which no single-shot
timing can see. At 1,000 rows the first call sequentially scans and the next
twelve use the index — reproducibly, and it does not matter: below the crossover
both plans cost 2.9 ms and the planner is entitled to pick either.

That column reports a count rather than a verdict on purpose. Its first version
compared the twelve calls against the single probe before them and printed
`NO — PLAN CHANGED` at 1,000 rows, which was true and meaningless.

That is established from `pg_stat_user_indexes.idx_scan` read before and after the
call, not from a plan — `EXPLAIN` of a plpgsql function shows a Function Scan and
says nothing about what happens inside it. The first version of that check read
the counter immediately and reported "index not used" at every scale, while the
timings said 0.59 ms for a query a sequential scan does in 267 ms. Statistics are
flushed at most once a second; `pg_stat_force_next_flush()` fixes it. The
measurement was wrong, not the function.

**What the extras cost.** `total_count` is within noise of free, which is what the
migration header argues: the ordering already materialises the whole match set, so
the window adds no scan. The whole function is ~0.1 ms over the bare pattern at
100,000 rows.

**The ceiling.** A needle in ~10% of rows costs 79 ms at 100,000; one matching
*every* row costs 731 ms, and no index helps there. The second number is the one
an operator needs — it is the worst case any caller can reach, including by
accident with a one-character needle — and an earlier version of this script
printed only the first and called it the ceiling. Keyword search is fast for what
it is for, exact rare strings in single-digit milliseconds, and unremarkable
otherwise.

A decoy is planted that only an *unescaped* pattern can match, so a regression in
the escaping doubles the row count and the script refuses to print rather than
reporting a faster wrong query.

### Two things bench-trgm.ts has to do

Both easy to leave out, and both produced confidently wrong numbers first:

- **Drop the index before the baseline arm.** Since 011 landed, `resetSchema`
  builds it, so "before" is no longer the default state of a fresh schema.
- **Never write to the table between the two read arms.** The first version
  measured reads, then ran the write-amplification arm, then measured reads
  again — so the second arm scanned a heap the first never saw (770 KB against
  200 KB, for the same 97 live rows, because `VACUUM` reclaims tuples but only
  returns *trailing* pages). Patching that with a vacuum just moved the bias
  around: a plain `VACUUM` left the bloat, `VACUUM FULL` compacted below the
  baseline, and applying `VACUUM FULL` to both arms rewrote a 60 MB table and
  exhausted the container's 64 MB `/dev/shm` at the largest scale. The script now
  runs three passes over three freshly loaded tables — one for reads, one per
  write arm — so there is nothing to compact and nothing to correct for.

## The stable tier — a brain rebuilt from the records (SMD-1806)

The fork runs a brain on its own memory, so a migration meets real vectors before
an operator does. That brain — the **stable** tier — holds nothing that is not
rebuildable from the fork's records: FORK.md, the Linear board, the memory files
and git. It is a *derived view* over the records, never the record itself, so a
wipe costs one re-ingest, and that re-ingest is two commands:

```bash
# 1. the records → rows (bare: no vectors, no chunks yet)
bun ingest-records.ts --url postgres://… \
  --linear /tmp/linear-corpus-full.json --allow linear:corpus \
  --memory-dir ~/.claude/projects/<project>/memory
# 2. rows → vectors + chunks, through the owned embedding path (below)
bun reembed.ts --url postgres://…
```

`ingest-records.ts` reads six sources, each a record becoming one thought row
with a deterministic id and a `metadata.source` label (SMD-1806 rule 5 — an
agent-written capture is one source among several):

| source | what | needs |
| --- | --- | --- |
| `fork` | the fork's changes, one `changes/*.md` file each (SMD-1917) | in the tree |
| `commit` | git commit messages since the upstream pin (the fork's whole delta) | in the tree; `--since <ref>` to move the range start |
| `linear` | a corpus dump built by `evals/build-linear-corpus.ts` — each record's `issue`, through the Linear adapter: the row the board sync writes (SMD-1958) | `--linear <dump.json>` and `--allow linear:corpus` |
| `memory` | the `*.md` memory files (`MEMORY.md`, the index, excluded) | `--memory-dir <path>` or `OB1_MEMORY_DIR` |
| `markdown` | a Markdown / Obsidian vault, through the Markdown adapter: every `.md` (any case) at any depth, a `Templates/` folder and dot-folders included and a symlink followed; only `.obsidian/`, `.trash/`, `.git/` and `node_modules/` are skipped, by name at any depth. One vault per brain: the identity is the note's name and the vault root is stored nowhere, so a second vault's note of the same name overwrites the first's across runs (SMD-2228) | `--markdown <root>` or `OB1_MARKDOWN_DIR`, and `--allow <root>` as a path (a bare name is not resolved — SMD-2221); `--source markdown` takes the vault alone |
| `items` | ingestion-contract items from a file, one JSON object per line, emitted by a parser in any language — the import recipes' seam (SMD-2136); each row labelled with the item's own system | `--items <file.jsonl>` (`-` reads stdin) and `--allow <scope>`; `--source items` takes the file alone |

`--source all` (the default) ingests every source it has an input for and says on
stderr which it skipped; `--source <one>` restricts it; `--dry-run` counts per
source and writes nothing. The write is idempotent on the deterministic id: an
unchanged record is a no-op, an edited one updates in place, a new one inserts, a
different record whose content is byte-identical to one already stored is skipped
(the partial-unique fingerprint index) rather than crashing the run — so a rebuild
writes exactly the rows that moved. It **adds and updates, but does not remove**: a
record deleted from its source (a memory file removed, a ticket dropped from the
dump) leaves its row behind, so a run that must reflect deletions starts from a
wiped brain (the "a wipe costs one re-ingest" above), not an incremental pass. It
writes **bare** rows on purpose: vectors and
chunk rows are `reembed.ts`'s job, which walks the new rows through the claim table
and embeds them exactly as a capture would (chunking long records), so the two
tools together produce the same rows a live capture would.

**The write merges, and clears what the text no longer vouches for.** A row's
`metadata` is merged (`thoughts.metadata || record`), never replaced, so the
board sync's facets, the extractor's tags and 050's actor marks on a row survive
a rebuild over it; a record whose text stood while its metadata gained a key is
`patched`. A record whose text moved is `updated`, and its vector, its label and
its chunk rows are cleared — they were the old text's — so `reembed.ts`, which
pools rows without a vector, picks it up (SMD-1958's second half; before, a
rebuild over an embedded brain left a stale vector under new text that nothing
re-embedded). A record that carries the source's clock (the contract's
`watermark` — a Linear record's `linear_updated_at`) is written only when the
row's stored value is not newer, and at an equal value only when the row was
not written — by anyone — after the record's view was taken (the dump's
`fetchedAt`);
otherwise it is `stale`, nothing is written, structure included, and the run
says how many — the board sync had moved those tickets past the dump (SMD-1958,
"Two writers of one identity" below).

**The ingestion contract (SMD-1867).** The `linear` and `markdown` sources go
through an **adapter** — `ingest-linear.ts`, `ingest-markdown.ts`, each a pure
map from one source item to the five things `ingest-contract.ts` names: a stable
**identity** within the system (a Linear identifier; a note's name, which is
what a wikilink names — its frontmatter `id` is a facet), the **canonical** form byte for byte (the issue as fetched, as
JSON with keys in one order; the file's bytes), the clean **text** that is
stored and embedded (Linear's autolink markup stripped to the identifier; a
note's frontmatter dropped and its `[[wikilinks]]` flattened to their alias or
name), the **links** the source's structured layer states (cross-references,
parent, blocks / related / duplicate relations; wikilinks), the **mentions** it
names (project and labels; tags) and the **facets**. The rule the contract is
built on: *preserve the source, derive the text and the edges* — a corpus that
stripped and stored could never be written back to Obsidian or Notion without
shredding the page (SMD-949's connectors). So each such record's transaction
also writes, through migration 053, its canonical (`thought_sources`), its links
(`link` facets, as a set — a link the source drops is closed, never deleted) and
its mentions (`record_thought_entities` under `source:<system>`, confidence 1,
no model call — rows 016's extractor never displaces and never doubles: where
both name one pair the structured row stands); the three writes are
`ingest-structure.ts`'s `recordStructure`, a module of bun and the contract
alone so `sync-linear.ts` can load it inside its container (which mounts `db/`
and `server-portable/` and nothing else — the sync's `--self-check` holds its
whole import closure to those two). Re-ingesting an unchanged item
writes nothing at any of the four. Every adapter passes one test: its canonical
IS the input; the Markdown adapter enumerates what its text cannot reproduce
(`MARKDOWN_LOSSY`) and the two inputs it refuses rather than store mangled — a
file that is not UTF-8, one holding NUL (`MARKDOWN_LIMITS`). `bun
ingest-linear.ts --self-check` and `bun ingest-markdown.ts --self-check` run the
pure rules; `test-schema.ts` [48] drives 053 with the Linear adapter's output.
An item may yield **derived items** (`Ingested.derived`, SMD-2059): parts that
are thoughts of their own — a Linear ticket's dated sections — each with its
own identity, canonical, text, links and facets, written after the parent
under its scope and watermark with `derived_from` the row that holds the
parent's identity, whichever writer's it is.

**Items from a file (SMD-2136).** The third adapter is not a map but a seam:
`ingest-items.ts` reads a file of items already mapped — one JSON object per
line, the keys `Ingested` names (`identity {system, key}`, `scope`,
`canonical {form, mediaType}`, `text`, `links`, `mentions`, `facets`, and
optionally `createdAt` and `watermark {key, value, asOf?}`; `null` for either
is absent, what a Python emitter writes for `None`) — so a parser in
any language emits the contract and the pipeline writes it: no database client
in the recipe, no rewrite under `db/` (SMD-2126 routes four import recipes
here, three of them Python). The row is labelled with the item's own system
(`metadata.source` — a `chatgpt` row is `chatgpt`'s, not `items`'), lands on
the deterministic id for `(system, key)`, and gets everything an adapter's
record gets: the canonical byte for byte (the round trip holds by construction
— the canonical IS the line's `form`), the links as a set, the mentions under
`source:<system>`, the merge, the watermark, the vector left for `reembed.ts`.
Each line passes the contract's own rules — `SYSTEM_RE`, and not one of the
pipeline's own six sources (`fork`, `commit`, `linear`, `memory`, `markdown`,
`items`: a file's row on the board sync's id for a ticket would overwrite the
sync's row with no `held` to say so); `IDENTITY_MAX`; the six relations; the
six entity types; `normaliseLinks` / `normaliseMentions` — and what no column
holds: a byte that is not UTF-8 (the file is read as bytes and each line
decoded strictly, never repaired to U+FFFD; a UTF-16 file is named as such,
with or without its byte-order mark), a NUL or a lone surrogate
anywhere in the line, an object or array at level 64 or deeper (the line's
object is level 0, its `facets` level 1), a `createdAt` or `asOf` that is not
an instant a `timestamptz` cast accepts unrounded (February the 30th is
refused, not rolled to March as `Date.parse` would; year 0 and an offset past
`+15:59`, which PostgreSQL has no room for, are refused; a fraction stops at
six digits, the microsecond the column holds). Lengths count characters as
the column does — a key or a link target within 512, a mention name within
200. And what the pipeline's own knobs
could not act on: a `scope` with a `/` (`--allow` reads an entry with one as
a path) or a `,` (its separator) — spell a scope `chatgpt:export` — or with
surrounding whitespace, a `key` with surrounding whitespace (a link's target
is trimmed, so the row could never be linked). A malformed line
refuses the **whole file** with its line number and the field, exit 2, before
any write — a file half written is one the emitter cannot re-run cleanly, a
file refused is fixed and run again — and two lines of one identity are refused
together, since they would land on one row. `derived` is not taken from a
file: a part that is a thought of its own is a line of its own. A `watermark`'s
`value` is any string that sorts as it orders (the values compare as text; an
ISO-8601 instant in UTC is the usual). Two items whose `text` is byte-identical
are one row — the pipeline's rule for every source — and the run names the
dropped item and the one that holds its text on stderr, since an emitter
cannot see which of its lines fell; an item `skipped` (a row of another run
holds its text), `stale` (its `watermark` is judged as every record's is —
the row's value newer, or the same and written after `asOf`) or `held`
(another thought is this identity) is named the same way. A facet under
`actor_kind` or `actor_name` is refused — those are 050's trigger's, stamped
from the ingester's envelope — and a `facets.source` is overwritten with the
system. So is a facet naming another source's ticket (`issue`, `ticket`,
`linear_updated_at`): node_state, `source_thought` and the board sync read a
row carrying one as that ticket's, whatever its source, so an item names a
ticket as a link or a mention instead. A `createdAt` more than a day ahead of
now is refused too (SMD-2212). A facet integer at or past 2^53, or a magnitude JSON cannot hold, is
refused rather than stored as its neighbour or as `null`: write it as a
string (a Python emitter's `json.dumps` writes a snowflake id exactly;
`JSON.parse` does not read it so). The emitter an
import recipe copies, its own parser kept (`conv.created_at` is an ISO-8601
string with an offset, or `None` — `json.dumps` refuses a `datetime`;
`conv.raw` is the conversation as the export holds it, and the form is its
JSON text, a string):

```python
import json, sys
for conv in parse(sys.argv[1]):  # the recipe's own parser, unchanged
    print(json.dumps({"identity": {"system": "chatgpt", "key": conv.id}, "scope": "chatgpt:export",
                      "canonical": {"form": json.dumps(conv.raw, ensure_ascii=False), "mediaType": "application/json"}, "text": conv.summary,
                      "links": [], "mentions": [{"name": t, "type": "topic"} for t in conv.tags],
                      "facets": {"title": conv.title}, "createdAt": conv.created_at}))
```

```bash
python3 import-chatgpt.py export.zip > items.jsonl
bun ingest-records.ts --url postgres://… --source items --items items.jsonl --allow chatgpt:export --dry-run  # counts; a bad line is refused here
# or straight from the emitter, no file: python3 import-chatgpt.py export.zip | bun ingest-records.ts --url … --source items --items - --allow chatgpt:export
bun ingest-records.ts --url postgres://… --source items --items items.jsonl --allow chatgpt:export            # the rows
bun reembed.ts --url postgres://…                                                                              # the vectors
```

`bun ingest-items.ts --self-check` runs the rules over a good line and every
malformed kind, naming the line and field each is refused on; `test-live.ts`
[19] drives the flag end to end through the CLI against a real server.

**The allowlist (SMD-1813).** The adapter sources — `linear`, `markdown`, `items` — are external content —
stored un-isolated, embedded, sent to a model provider — and are ingested only
for a **scope** the operator cleared: `--allow <scope,scope>` or
`OB1_INGEST_ALLOW`, an exact match on the scope each record names (the corpus:
`linear:corpus`; a vault: its resolved root path; an item: the `scope` its
emitter wrote, an export or a workspace), never a prefix and never "the
whole workspace". The default is nothing; a record refused is counted per source
and the refusal names the knob that clears it. The fork's own records (`fork`,
`commit`, `memory`) are not external and are not gated.

**The brain reports its tier.** `OB1_TIER` (`stable` | `canary` | `working`,
default `stable`); the ingester stamps `ob1_config.tier` and `.last_ingest` on
every run, and preflight's `tier` check reports them beside the schema version,
warning when a server's `OB1_TIER` disagrees with the tier its database was
stamped as — a working server pointed at the stable database, the failure the
one-writer rule exists to prevent.

**Reaching it from a client.** The server speaks Streamable HTTP, so a client
adds it as one remote MCP entry, at `/mcp` on the stack's proxy (`SERVER_PORT`,
8000 unless set; deploy/README.md, "One origin"):

```bash
claude mcp add --transport http open-brain-stable http://127.0.0.1:8000/mcp \
  --header "x-brain-key: <key>"
```

## The canary and working tiers — refresh, replay, diff, promote (SMD-1806)

The **canary** is main's shadow and the **working** tier is a per-worktree
disposable copy; both are built from stable by one tool, `db/tier.ts`, whose four
verbs are the promotion pipeline:

```bash
# snapshot stable into the canary (or a working copy) and migrate it forward
bun tier.ts --refresh --from <stable-url> --to <canary-url> [--tier canary|working]
# replay stable's logged searches against the canary and report the ranking
bun tier.ts --replay  --from <stable-url> --to <canary-url> [--since <iso-ts>]
# the same, as a gate: exit 1 if a ranking moved (or a step failed), 3 if nothing was compared
bun tier.ts --diff    --from <stable-url> --to <canary-url> [--since <iso-ts>]
# after a soak: stamp the canary's version onto stable
bun tier.ts --promote --from <canary-url> --to <stable-url>
```

**`--refresh`** takes a faithful whole-database snapshot with `pg_dump | pg_restore`
(thoughts, vectors, chunks, query_log, provenance, agents, audit — everything a
migration might touch, so a migration meets *all* the real data), resets the target
and restores into it, copies the source's database-level settings the dump leaves
out (`ALTER DATABASE … SET` — migration 014's HNSW bounds, SMD-2037), then runs
`migrate.ts` forward with the merged tree. It is destructive to `--to`, so it
guards the target five ways.

- **It is not the `--from` database.** The source session is looked up in the
  target's `pg_stat_activity`. Two names for one server are still one server,
  and a copy that shares the source's `system_identifier` is still another.
- **It is a tier, or empty** (`targetRefusal`). A target is allowed when:
  - an earlier refresh marked it. Before its reset, each refresh sets
    `ALTER DATABASE … SET ob1.refresh_target`, which neither the reset nor the
    restore touches. A refresh that died after its restore therefore retries,
    even though the restore left the source's `tier=stable` in `ob1_config`;
  - it is stamped `canary` or `working`;
  - its public schema holds nothing but what extensions own;
  - it is an Open Brain schema with no thoughts.

  Anything else is refused, and the refusal names no override: the record
  (`tier=stable`), a brain with thoughts under no stamp, and another
  application's schema. For that check, `schema_migrations` alone does not
  make an Open Brain schema, since Rails and others use the name. `--promote`
  mirrors this and refuses a `--to` that is the `--from` database, marked, or
  stamped `canary`/`working`.

  The mark is read from the database's own setting only, never a role's or the
  server's, and only `canary` or `working` counts. Setting it needs a superuser,
  or `GRANT SET ON PARAMETER ob1.refresh_target` (PG15+); restoring pgvector
  needs a superuser in the default install anyway. It lasts until
  `ALTER DATABASE … RESET ob1.refresh_target`. `deploy/README.md`, "Refreshing
  a tier", has both statements.
- **It is loopback,** unless `OB1_ALLOW_REMOTE_DB=1`.
- **Each side's URL names one database every client reaches** (SMD-2317).
  Bun runs the guards and the drop, and libpq runs `pg_dump` and `pg_restore`,
  so a URL they read differently (a query key such as `?host=`, a fragment, a
  first-`@` host list) is refused on either side, as is one naming no host or no
  database. After connecting, each side's server must report the URL's
  database: an exported `PGDATABASE` beats the URL's in Bun. `--to` is asked
  again on the connection that marks and drops. No override lifts these.
- **The tools parse no URL.** `pg_dump` and `pg_restore` get a keyword
  connection string (`connect.ts` `toolTarget`): the URL's host and port, the
  database and login (`session_user`) the server reported, and only
  `sslmode`, `application_name` and `options`. The password is in
  `PGPASSWORD`, off their argv. Their environment keeps only the `PG*`
  variables that authenticate, so `PGHOSTADDR`, `PGSERVICE`, `PGOPTIONS` and
  the rest cannot send them elsewhere. Before the mark, `pg_dump` on that same
  string must find a table just created, in a schema of its own, through the
  connection that drops, or `--to` is left untouched.

It needs Bun
and a `pg_dump`/`pg_restore`, `pg_dump` at a major version of at least both
servers' (the source's for the dump, `--to`'s for the probe), and
no image the stack runs has both — the pgvector image has the client and no Bun,
`oven/bun` the reverse. **`deploy/tier.sh` is the runnable form** (SMD-2036): it
builds `db/tier.Dockerfile` (`oven/bun:1.4.0-alpine` + `postgresql16-client`, the
stack server's major) and runs this checkout's `tier.ts` in it on the stack's
network, so a refresh migrates forward with the tree it was run from —
`deploy/README.md` has the commands. A host with Bun and `postgresql-client >=` the
server can still run `bun tier.ts` directly. A branch that changes the
embedding model or width cannot inherit stable's vectors: `migrate.ts` refuses the
mismatch on the refreshed copy, so that branch's working tier is rebuilt from the
records instead (`ingest-records.ts --tier working` then `reembed.ts`, the claim
path; without `--tier` the ingester stamps `stable`) — a real test of the
re-embed path, not a cost.

**`--replay` / `--diff`** are the *live* half of the replay gate (SMD-1295, whose
`db/test-replay.ts` is the offline, model-free, fixture-vector half CI runs). For
each search stable logged since the canary's last refresh, the query is re-run
against the canary through the shipped retrieval and the returned ids are diffed
against the ids stable recorded — the measured per-PR **"what moved"**, in place of
the hand-written control run. The **keyword** arm replays with no model (the arm
`test-live` [20] exercises end to end); the **hybrid** arm re-embeds the query text,
so it replays only when a provider is configured (`OB1_EVAL_EMBED`, as
`evals/eval-replay.ts` uses) and is skipped-with-a-note otherwise; a row logged
before migration 045 carries a NULL arm and is skipped rather than guessed. Both
verbs print the window and how many rows it held, replayed and skipped. A window
that replayed none compared nothing, and `--diff` exits 3 on it: 0 is a pass, 1 a
ranking that moved or a step that failed, 2 a usage error or a refusal (SMD-2182).
A side that does not answer is named with its host and port.

The three tiers run as one stack, `deploy/compose.tiers.yaml` — three Postgres
services, one shared Ollama, each tier's MCP server and REST core, and one proxy
where each tier is a path: `/mcp`, `/canary/mcp`, `/working/mcp` (SMD-2294) —
built from the checkout (the published stable image is SMD-1860, not yet cut). A
client reaches the working tier as a second remote MCP entry a transcript can
tell from stable's:

```bash
claude mcp add --transport http open-brain-working http://127.0.0.1:8000/working/mcp \
  --header "x-brain-key: <key>"
```

A canary stood beside compose.yaml's stack with `deploy/canary.sh` answers the
same way, at `/canary/mcp` on that stack's port ("A canary beside the stack" in
deploy/README.md), and `--compare` takes the two URLs as they are, with a read
key in `OB1_COMPARE_KEY` (or `--a-key`/`--b-key`, or `?key=` on a URL):
`OB1_COMPARE_KEY=<key> bun db/tier.ts --compare http://127.0.0.1:8000/mcp http://127.0.0.1:8000/canary/mcp`,
each labelled by host and path.

**Deferred to SMD-1805 + SMD-1860:** the *canary CI job on push to `main`* (which
runs the refresh/replay/diff against the **published** images through the merge
queue; straight after a refresh the default window is empty and `--diff` exits
3, so the job replays a `--since` read before it or waits out a soak) and
`--promote`'s image-repoint half. The engine, the compose stack and the
end-to-end test ([20]) do not need them and are here now.

The `query_log.tier` column the tiers read is from migration 045 (SMD-1490): the
server stamps every query_log row with its `OB1_TIER` (stable | canary | working,
NULL for a plain brain). 045 also added `query_log.arm` (the retrieval arm a search
ran — `hybrid` or `keyword`) and populated the long-dead `filter` column: the search
tools now take a metadata filter (`metadata @> filter`, a shallow object) and log
it, so both replay halves can measure the filtered path against real use.

**Prune seeks, and the write is measured (migration 047, SMD-1492).** The canary
replays this log, so a lost row is a lost replay, and a scheduled prune (SMD-1794)
runs the retention delete at volume. `prune_query_log` deletes `WHERE logged_at <
cutoff` with no `agent_id` predicate, which 034's composite `(agent_id, logged_at)`
index cannot serve (its leading column is `agent_id`); migration 047 adds a plain
btree on `logged_at` so the delete range-scans instead of sequentially scanning the
whole log. The log write stays awaited on the request hot path deliberately —
fire-and-forget could drop a row the canary needs — and `bench-querylog.ts` (below)
measures both that awaited INSERT's cost and the prune plan flipping to an index
scan. A cheaper insert path (a BRIN in place of the btree, the log being
append-only with a monotonic `logged_at`) is a tracked follow-up (SMD-1950).

## Long-running workers report their liveness (SMD-2261)

board-sync was down for four days (2026-09-27 to 10-01) and nothing noticed:
its container had gone, and preflight's `tier` row printed the last ingest as
passing. The board-sync watermark cannot be the alarm — a quiet board stops it
too — so each long-running worker stamps a **heartbeat** after every pass,
whether or not the pass found work (`db/pass-stamp.ts`): `sync-linear.ts --loop`
and the `--follow` of `extract-entities.ts` and `consolidate.ts` — and
`sleep.ts --follow`, as `heartbeat:sleep`, at least every minute whether
asleep or awake, its followers stamping through it (SMD-1794). A one-shot run
stamps nothing, so it leaves no row to go stale, and neither does a dry run or
an audit.

One `ob1_config` row per worker and job — `heartbeat:board-sync`,
`heartbeat:extract:qwen2.5:7b@p2`, `heartbeat:consolidate:qwen2.5:7b@p3` — whose
value names the `job` (a claim worker's, as given — the restart works that
pool), `every_s` (the worker's interval, at least a minute), whether a pass is
`running`, the last pass's `outcome`, whether the worker has `ended`, and, for
extraction, the last judged block's malformed answers and whether they passed
SMD-2266's alarm. The time is the
row's `updated_at`, the database's `now()`.

- **`ok`:** the pass ran, whatever its rows came to — a document the model
  cannot read is a failed row and the malformed alarm's business, and rows
  failing for another reason (a role not re-granted) are `--status`'s to list,
  not the heartbeat's.
- **`failed`:** a worker of the pass stopped because the provider kept failing
  after its pauses (5, 15, 45 s), board-sync's pass reported errors, or a pass
  threw. A poll with nothing to do keeps the last pass's word, so a down
  provider reads failed until a pass with work runs again. One document that
  draws a repeatable 5xx stops its worker the same way, so it too reads failed
  until the next pass with work, whatever another worker finished.
- **`ended`:** the worker's process is gone — `stopped` on a signal or a
  follower's `--limit`, `failed` when the provider refused the request itself or
  a pass threw. Its row says so at once rather than "alive" until it goes stale.

A pass is stamped `running` as it starts and every `every_s` while it runs, so
a follower's first pass over a backlog reads alive, as lease renewal keeps its
claims. Each stamp writes the whole value, so a restarted follower's row
carries no malformed block until it judges its next one (48 answers or more,
judged once a pass drains the pool). A restart clears the alarm, so fix the
model first: a follower restarted on the same broken model reads healthy until
48 new answers trip it again, which on a quiet brain can take days. There is
one row per job, not per process: two followers of one job share it, the last
to stamp written. A tier refresh deletes the source's rows
(`tier.ts`), so a canary never reports stable's workers; a `pg_dump` restored
onto another host carries them too — alive for up to three intervals, then
stopped or stale — until deleted. A block the reader cannot trust is left off
the record; the heartbeat still counts.

**Who reads it.** Keyed `/health`, `brain_info` (a `Workers` row) and
`GET /v1/brain` carry every heartbeat as `database.workers`. Preflight's
`workers` row warns, with a remedy for each:
- when a heartbeat is older than three of its intervals, or its worker ended
  (the remedy names the command that starts it again);
- when a fresh one's last pass failed;
- when its last block passed the malformed alarm, which a follower otherwise
  says only on stderr.

A worker that never ran on a brain has no row, and nothing is said. A worker
retired on purpose leaves its row to warn until it is deleted
(`DELETE FROM ob1_config WHERE key = 'heartbeat:…'`, as preflight prints it).

**Grants.** The write is a plain upsert into `ob1_config`, which the `worker`
group holds (`migrate.ts --grant … --groups worker`); compose's `board-sync`
connects as the database owner. A role without it is told once, and the work
goes on: a heartbeat is reporting, never a reason to stop.

## The board in the brain (SMD-1954)

`ingest-records.ts` above loads the Linear board from a corpus dump, once, for a
rebuild. The fork's running brain needs the board **continuously**: a ticket filed
while a session works should be findable in the next, and one that moves to Done
should read Done. `sync-linear.ts` is that sweep, and `deploy/compose.yaml`'s
`board-sync` profile runs it on a schedule:

```bash
bun sync-linear.ts --url postgres://…                # one pass
bun sync-linear.ts --url … --dry-run                 # what a pass would write
bun sync-linear.ts --url … --audit                   # the lockstep census: missing / stale / extra; exit 1 when any of the three
bun sync-linear.ts --url … --loop                    # a pass every OB1_BOARD_SYNC_INTERVAL seconds (300), each stamping a heartbeat
bun sync-linear.ts --url … --full                    # re-render and compare every issue, not only the moved ones
bun sync-linear.ts --url … --only SMD-1954,SMD-1865  # these identifiers, whatever the plan says of them
bun sync-linear.ts --self-check                      # the pure rules and the write decisions, no network, no database
```

`LINEAR_API_KEY` (a personal API key; the tool only reads) comes from the
environment or a `.env` on `db/env.ts`'s search path; `OB1_LINEAR_INITIATIVE`
(default `Open Brain`, an exact name or a prefix naming exactly one) says whose
projects are the board; the provider knobs are the server's, resolved as
`reembed.ts` resolves them.

**The brain is the state.** A pass lists every issue's identifier and `updatedAt`
(two requests for three hundred), reads the brain's ticket rows, and the diff is
the work: an identifier with no row is **missing** and is captured; one whose row's
`linear_updated_at` is older than Linear's (or absent — a hand capture, adopted on
first sight) is **stale** and is fetched in full and compared; the rest are left
alone. A ticket row is one whose `metadata.issue` names an identifier (this tool's
rows and `ingest-records.ts`'s — one key, so a rebuilt stable brain is adopted, not
duplicated) or, before adoption, whose text opens with the hand-capture header
(`SMD-N — title` / `Project: … · Status: …` / the Linear URL). A note that merely
begins with an identifier is not one and is never touched. There is no done-file
to lose; a pass killed halfway is finished by the next.

**What a write is.** New: `captureThought` with the vector, the extracted tags and
the facets Linear knows over them (`source: linear`, `issue`, `project`, `status`,
`status_type`, `priority`, `labels`, `parent`, `url`, `linear_updated_at`).
Changed text: `updateThought` with a fresh vector, fresh tags, and every facet over
them, one statement. Same text, facets behind (the adoption case): a metadata patch and no
model call — on the dogfood brain 224 of 268 hand captures rendered byte-identical
and cost nothing but the patch. Every write goes through `server-portable/store-sql.ts`
as the actor `board-sync` via `db/sync-linear.ts`, the egress gate asked first
(refused, the row lands without a vector and the audit row says so), so a synced
ticket differs from a captured one in `metadata.source` alone. The text, the
facets and the structure are the Linear adapter's (`ingest-linear.ts`, SMD-1867):
Linear's autolink markup (`<issue …>SMD-x</issue>`) is stripped to the identifier
in the text, and once the head row is settled — captured, adopted, patched or
edited — the pass records beside it, with no model call, the issue as fetched as
its canonical (`thought_sources`), its cross-references, parent and relations
(`blocks`, `blocked_by`, `relates_to`, `duplicate_of`, from both sides of each
relation) as `link` facets, a set that follows the board — a relation removed in
Linear is closed, not deleted — and its project and labels as mentions under
`source:linear`, which 016's extractor leaves standing (migration 053; SMD-1865's
second item). So "the issues blocking X" and "everything under epic Y" are
answered from the edges, not the prose. "Same
text" is judged by `content_fingerprint_of` — the rule `update_thought` refuses
duplicates by, asked of the database — so a paste with a trailing newline is the
same text. When one identifier has several ticket rows — the hand re-captures —
the **head** is the row that already holds Linear's text by that rule, else the
row no other row of the group supersedes (the chain is the truth; age is the
tiebreak), and the group is chained under it by `supersedes` (032): head → next →
… → last, every differing pointer cleared first and then set, so no step closes a
loop. A pointer the hand set to a thought outside the group is kept at the chain's
tail, not erased. So a ticket moved back to a state an older paste recorded costs
no model call: that paste becomes the head and its facets are patched. Nothing is
deleted; the head's own write lands first, and a pointer the database refuses
(a hand-set chain through an outside thought that loops back) is reported under
*chain refusals*, never a reason the text did not land. When none of the ticket's
rows holds Linear's text but another thought does, that thought is read: one
that reads as this ticket, or as no ticket at all (a paste made after the row was
adopted, with or without the header the grammar reads), is folded in as the head
and chained; a text under ANOTHER ticket's claim is an outside holder, refused
before any model call and never re-keyed — the facets are patched without
`linear_updated_at` and `text_refused_by` names it, once, so the ticket stays
*stale* in `--audit` and is retried each pass, at one lookup and no write, until
the holder moves — reported under *refused*; the marker is cleared, on the head
and on any twin, once the head holds the text. A new ticket whose text a stray
row already holds (a paste the header grammar did not recognise) adopts that row
with a patch of the facets that differ. One issue the API refuses in a batch fails
that identifier alone, under *errors*; a batch Linear refuses whole (a rate limit)
ends the fetch and the batches behind it are reported not attempted, for the next
pass. The census carries each issue's project, state and label names beside its
`updatedAt`, so a rename — which never bumps `updatedAt` — makes the ticket stale
on the next pass. When the text moves, the tags are extracted
again with the vector (a fallback tag set from a provider outage would otherwise
stand on current text forever), every facet goes over them (a `status` or an
`issue` the model read out of the description must not win), and a stale
`metadata_extraction_failed` the fresh tags do not carry is set to null — the
nearest a shallow merge comes to removing it (`tagsOverExisting`, the rule in
`server-portable/metadata.ts` every writer that edits a tagged row shares). A row
whose tags fell back at capture, with its text unchanged, is not this tool's to
repair: that is SMD-1975's retag worker, for every thought and not ticket rows
alone; a row that landed without a vector is `reembed.ts`'s, as any vectorless row
is. Labels render and store
sorted, whatever order Linear returns them. A ticket deleted in Linear (trashed)
falls out of the census and its row reads *extra*; a completed one Linear
archived stays a ticket. `--only` syncs the identifiers named whatever the plan
says of them, and names one the census lacks; `--audit` takes no `--only`. The
scheduled path reads ticket rows by their claim (`metadata ? 'issue'`, indexable)
and adds the header scan over every thought's text — a sequential scan — only
when that plan has a *missing* identifier, since a hand paste is the one thing
that could hold it; `--full` and `--audit` always scan. Under `--loop`, SIGTERM
ends the pass after the issue in hand (the compose service allows 60 s); the next
pass finds what was left.

**Two writers of one identity.** `ingest-records.ts --linear <dump>` and this tool
both key a ticket on `metadata.issue`, and since SMD-1958 they write the same
row: the dump carries each issue as the API gave it (`issue`, the selection this
tool fetches — `ISSUE_FIELDS`, the adapter's), both feed it to the one Linear
adapter, and the text, the facets, the canonical, the links and the mentions
come out byte for byte the same. Run in either order on one brain, the second
writer finds nothing to write — `test-live.ts` [22] drives both orders over the
real store. Three rules keep it so. *The identity has one holder:*
`thought_sources` names one thought per `(linear, SMD-N)`; this tool takes the
identity for the ticket's head row (`record_thought_source(…, p_take)` — the head
moves when an older paste becomes the chain's head, and the structure moves with
it: the old head's linear links are closed and its `source:linear` mentions
removed, so the ticket's edges are read once), and the ingester, whose ids are
deterministic, does not: a corpus record for a ticket this tool captured first
comes back `held`, its transaction rolled back, no second row, counted and said
— while a ticket the ingester wrote first is this tool's to keep, on the
ingester's row. *Metadata merges:* the ingester never replaces a row's
`metadata`, so the tags and 050's marks this tool's capture put there survive a
rebuild. *The source's clock wins:* the record carries the issue's
`linear_updated_at` as its watermark, and a row whose stored watermark is newer
— this tool moved the ticket after the dump was built — is not written; the
record is `stale`, its structure unrecorded, and the row keeps the current
text. Without that a Monday dump on Friday would move every ticket that moved
back to Monday, and the next pass forward again. Where Linear's clock cannot
settle it — a project, state or label **renamed** in Linear leaves `updatedAt`
where it was, and this tool re-renders the ticket from the census — the
brain's does: the dump carries its build instant (`fetchedAt`), and at an equal
watermark a row written after it is left as it is and the record is `stale` too
(the builder's clock and the brain's must agree to the order of that gap; a
dump with no build instant writes at an equal clock). `updated_at` is the
brain's last write by anyone — a facet patch, a re-embed, a retag, a hand edit
as much as this tool's re-render — so a rename the dump did see can read
`stale` behind such a write; this tool's next pass lands it from the census,
so the cost is a delay and an overstated count, never a lost write. The dump
holds the issues the builder kept — those whose description and comments make
a non-empty text (`OB1_CORPUS_MIN_CHARS` can drop more), in the state it was
asked for (`OB1_CORPUS_STATE`, `completed` by default) — and every other
ticket is this tool's alone. A dump built before the `issue` field
is refused by name with the rebuild command — one renderer, not two.

**A ticket's dated sections are thoughts of their own (SMD-2059).** A level-2
heading carrying an ISO date — `## Update 2026-09-19 (board audit)`,
`## Corrected 2026-09-22 — …` — is a dated observation about a premise that
moved, and inside the ticket's row no filter or report reaches it (SMD-1951's
finding). The adapter yields each such section as a derived item on an
identity of its own (`SMD-N#<slug of the heading>`): an `observation` dated by
the heading, `derived_from` the ticket's row, `child_of` it, the section's
Markdown as its canonical, the facet `ticket` naming the ticket (never
`issue`, which is this tool's claim on a ticket ROW). This tool writes the
parts beside the head row once it is settled — found by identity on later
passes, patched, edited or captured as the ticket's own text is, each with its
own vector and tags — and the report's `sections` line counts them; the
ingester writes the same parts from the dump. The ticket's text is unchanged:
it is what people search for and cite. Headings only; a bold `**Corrected**`
paragraph is prose, and a `## ` line inside a fenced code block is code (an
unclosed fence runs to the end, as CommonMark reads it). A renamed heading is
a new part and the old row stays (neither writer removes) — and while the old
row holds the text, the renamed part reads as held by it and is refused on
each pass that visits the ticket (a change in Linear, or `--full`); two
sections whose text comes out identical are one part, and a near-twin (the
fingerprint folds case and whitespace) is refused by this tool before any
model call and read `skipped` by the ingester. A part this tool captured whose
structure write then failed stands without its identity and is refused the
same way until SMD-2075 adopts it. A part's
`created_at` is the heading's date from the ingester and the capture's moment
from this tool (a capture takes no date). Parts land only once the ticket's
head row is settled — a ticket whose text another thought holds gets none, and
`--dry-run` counts none — and a part whose parent no row holds yet carries no
`derived_from` until a run finds one. A brain from before this change gains
its parts as each ticket next moves, or all at once from one `--full` pass.

**Structure on a brain from before 053.** A scheduled pass fetches only the
missing and stale tickets, so the rows a brain already held gain their
canonical, links and mentions only as each ticket next moves in Linear. To
record them for every ticket at once, run one `--full` pass after applying 053:
every issue is fetched and compared, the rows read *unchanged* or *patched*,
and the structure lands beside each head row (no model call, ~1 s of Linear per
fifty issues). On a brain without 053 the tool says so at boot and writes rows
alone. A ticket whose structure write fails — a validator refusal, a race —
has its watermark cleared so the next pass fetches it and tries again, every
pass until it lands: one fetch, the facet patch, the hook's rolled-back
transaction and the clearing patch per failing ticket per interval — two audit
rows — and the error under *errors* in every report, which is the signal
to look. The retry is not capped; a ticket that fails forever costs that
forever, and says so each time.

**Not removed, not commented.** An issue deleted in Linear or moved out of the
initiative keeps its row (`--audit` lists it under *extra*; `ingest-records.ts` has
the same rule). Comments are the corpus builder's for the retrieval eval; the board
mirror keeps the hand captures' shape, which had none. A Linear webhook would be
exact and immediate; it needs an inbound URL (SMD-1846) and SMD-1862's handler,
which would call this tool's `syncIssue` with the one identifier it was told.

**What it tells the board (SMD-2681).** The board comes in; consolidation's
findings about it went nowhere until someone read the queue. With
`LINEAR_COMMENT_API_KEY` set, every pass (not `--audit`, and not `--only`,
which brings in only the named tickets' links) ends with `board-findings.ts`'s
step: a pending `outdates` proposal (029) or a standing `related`, `evolves`
or `duplicate` relation (084) between two tickets the board does not link is
posted as one comment on the newer ticket — the ticket of the thought the
judge saw as newer. The same step runs on its own:

```bash
bun board-findings.ts --url … --dry-run   # what would be posted and what the gate would refuse — the board unread, so a pair already on it is listed too; no Linear request, no row
bun board-findings.ts --url …             # post, up to the cap
bun board-findings.ts --url … --cap 2     # the 24-hour ceiling this run applies, over OB1_FINDINGS_POST_CAP
```

- **Which findings.** Two Linear rows (`metadata.source = 'linear'`:
  board-sync's tickets and their dated sections) filed under two different
  tickets — 079's identity, `coalesce(metadata->>'ticket', metadata->>'issue')`,
  which must read as an identifier (`SMD-123`) — that no active Linear link
  joins: neither 079's `consolidation_tickets_linked` nor a `duplicate_of`
  either way. That is SMD-2680's board-pair rule, asked when posting (a link
  made after the verdict never moves the proposal, and the pass has just
  brought in the links of every ticket Linear says moved — a link added
  without moving either ticket's `updatedAt` waits for a `--full` pass), narrowed to Linear rows: a fork change record
  or a capture can carry a `ticket` too, and its text is not the board's, so
  `brain_info`'s board counts can be higher than what is posted. A session
  note, or any thought that is not a Linear row, on either side is never
  posted.
- **One comment per ticket pair.** Several proposals or relations between rows
  of the same two tickets are one comment. It names the two tickets, each
  finding's word and direction and the judge's confidence, a proposal's
  one-line reason (as code, so a link or a mention in it is shown, not
  rendered), and how to act: a proposal is decided in the brain
  (`cd db && bun consolidate.ts --accept <id>`, or `--reject <id>`); a
  `related` or `evolves` relation by linking the tickets as related on the
  board, which this tool's next pass brings back, after which 079 leaves the
  pair out of the candidates; a `duplicate` by marking one a duplicate of the
  other, after which the pair is not posted again (079 still pairs it for the
  judge). It proposes only: no link is added, no status moved, no description
  edited.
- **Posted once.** Migration 087's `board_findings_posted` holds one row per
  ticket pair and word (`outdates`, `related`, `evolves`, `duplicate`), so a
  relation a re-judge replaced at another score is not posted again, and a pair
  is posted again only for a word not posted for it before (a proposal judged
  the other way round is not). The comment's last line is a marker,
  `ob1-finding SMD-A SMD-B words`, in letters, digits, hyphens and spaces:
  Linear keeps a comment as rich text and returns
  markdown derived from it, so the marker is read back with identifiers
  un-autolinked and escapes undone. Before posting, both tickets' comments are
  read (the first 250 of each); a word a marker already names — another brain
  posted it, or this one lost its row — is recorded `found` and not posted.
  So a person who writes the line on either ticket silences that word for the
  pair. Two brains on one board read each other's markers; two that post the
  same pair in the same moment can both post.
  Each post holds one lock for the whole brain, re-reads what is recorded and
  re-counts the day's posts under it, then posts and writes its rows in that
  transaction: a post that fails records nothing and the next pass tries
  again, and two posters at once post neither a pair twice nor past the cap. A
  run killed after Linear answered and before the commit leaves the comment
  with no row; the next run finds its marker and records it `found`, which the
  cap does not count.
- **Bounded.** At most `OB1_FINDINGS_POST_CAP` comments (default 5, 0 to 100)
  in any 24 hours, counted from the comments this brain recorded posting — a
  comment Linear made after the step gave up on it is recorded `found` later,
  and not counted, and each brain counts its own; best first, by the
  judge's confidence and then age. The confidence does not yet rank real
  findings (SMD-2705), so the cap is the guard. A bad value stops the tool with
  exit 2, as a bad interval does — in board-sync, when the key is set.
- **A ticket off the board.** A ticket deleted in Linear, or moved out of the
  initiative, keeps its row (above). Board-sync passes the step this pass's
  census, and a pair with a ticket off it — or one this pass failed to fetch,
  whose links it did not bring in — is left alone, no Linear request,
  while a ticket on it that the comment key cannot find fails the pass: the
  key does not see the board's teams. The census is as old as its pass: a
  ticket deleted while a pass runs fails that pass's post once, and the next
  census drops it. A pair that fails every pass — a team the comment key
  cannot see — keeps the heartbeat `failed`; give the key the team, or, as
  the owner, record the pair as told with a `found` row in
  `board_findings_posted` for each word. Run on its own, `board-findings.ts` has
  no census: Linear's "Entity not found" is reported as no such ticket and
  asked again next run; any other error is a failure.
- **Through the egress gate.** The comment leaves to `api.linear.app`, so it
  is gated as a subject of its own: type `board-finding`, source
  `board-findings`, and its text for a `marker:` term — values a capture is
  unlikely to carry, since `OB1_EGRESS_ALLOW` is the server's too and a term
  admits any row carrying its value. Under the default deny nothing is posted:
  board-sync says so once at start and leaves the step off, and
  `board-findings.ts` prints what it would have posted. Opt in with
  `OB1_EGRESS_ALLOW=type:board-finding`. That term lets the comments out
  and nothing else: board-sync's own embeddings still need their endpoint
  declared local or a term of their own, and board-sync judges its up-front
  refusal without it. The two thoughts are not gated
  themselves: both are the board's own rows, and what leaves is a remark about
  them, to that board.
- **Its own key.** `LINEAR_COMMENT_API_KEY` is a key that can comment, never
  `LINEAR_API_KEY`: that one is someone's whole account, which this tool only
  reads with. Board-sync warns when the two are the same key. The key is read
  from the environment or a `.env` on `db/env.ts`'s search path and never
  printed. Unset, the step is off and nothing is said.
- **Exit and heartbeat.** A post that fails (Linear refused, answered without
  creating it, or did not answer within 20 s) is reported and fails the pass,
  so `heartbeat:board-sync` says `failed`; the next pass tries again.
- **Grants.** The `structure` group holds `SELECT, INSERT` on
  `board_findings_posted` and `SELECT` on `supersession_proposals`; the step
  also reads `thoughts` and `thought_facets` (the capture group's) and
  executes 079's function — `--groups capture,structure`. A role that lacks
  any of them is said once at start and the step stays off; a dry run needs
  the reads alone. Compose's `board-sync` connects as the owner and
  needs nothing.

## Testing

Two suites cover most of it, because one of them cannot reach everything, and a
third covers the one thing the test image cannot reproduce.

```bash
bun test-schema.ts                          # 2712 assertions, PGlite, no container
./with-postgres.sh bun test-live.ts         # 1228 assertions, real server, throwaway container (fewer when a group is skipped — PostgreSQL 18, JIT off — or a recipe's env file skips a case: [26]'s four sweep cases under recipes/lint-sweep/.env or .env.local, [29]'s no-URL case under recipes/thought-enrichment/.env.local)
./with-postgres.sh bun test-search-path.ts  # pgvector installed OFF the search_path (managed-Postgres shape)
bun test-cli.ts                             # every script's flags through cli.ts — no database
bun test-connect.ts                         # every script's connection through connect.ts — no database
bun test-engines.ts                         # the engines (migrate.ts, extract-entities.ts, consolidate.ts, reembed.ts) import with no side effect, refuse through run() — no database
bun test-worker-bootstrap.ts                # every claim worker's egress and identity bootstrap, and the outage rules and probe, through worker-bootstrap.ts — no database
bun test-weekly-digest.ts                   # the digest's ranking, chunking and its egress subject/gate — no database
bun test-board-findings.ts                  # the findings poster's grouping, comment, marker, cap and egress subject — no database
bunx tsc --noEmit                           # every .ts here, strict, against the server's exports — no database
```

Every script here reads its arguments through `cli.ts` (SMD-2134), one table
per script of what each flag takes, scanned before anything else runs. A flag
the script does not have, one given twice, one that takes a value followed by nothing, another flag or a
blank, a value joined with `=`, or a value where no flag takes one exits 2 with
the script's flag list; `--help` prints the list and exits 0; a number is
decimal digits only. An engine's `run()` refuses a blank option first, in the
scanner's words, through `cli.ts`'s `blankProblem` (`reembed.ts` since SMD-2304,
`extract-entities.ts` and `consolidate.ts` since SMD-2425). A refusal names the argument's position, never its text —
an argument can be a password or a key. Before it, `consolidate.ts`
and `extract-entities.ts` ignored a flag they did not know, so `--K 10` ran the
default `--k` and exited 0 (SMD-2015). `test-cli.ts` holds the scanner's rules,
that every entry point imports `cli.ts` and nothing else reads `process.argv`,
and runs each entry point with a flag it does not have and with `--help`.

Every script reaches its database through `connect.ts` (SMD-2302): `--url`, else
`DATABASE_URL`, else exit 2 with one refusal (a URL that does not parse is
refused too, and never printed); one client constructor; and one answer to
"may this database be reset?". `tier.ts --refresh` and the suites'
`dropSchema` both ask it, and print why not.

The resolver refuses a URL that Bun and libpq would take to different places
(SMD-2317): a query key other than `sslmode`, `application_name` and `options` (Bun sends
`database=` and `user=` to the server, which keeps them; libpq follows `host=`,
`port=`, `dbname=` and `service=`), a `+` in the query (a space to Bun), a
query part libpq refuses (empty, no `=`, a second raw `=`, an `sslmode` in
capitals), a fragment, an `@` other than the one ending the user, a `,` or
`%2C` in the host, or a `.`/`..` path segment (Bun resolves it, libpq does
not). Put the database in the URL's path. The reset rule then has three
parts:
- **The URL must name its host and its database,** and its port while
  `PGPORT` is exported. With no host, Bun connects to localhost over TCP and
  libpq to the unix socket; with no database, the shell's `PGDATABASE` would
  choose what is dropped; with no port, Bun takes `PGPORT`.
- **Its host must be loopback by name** (`localhost`, `127.0.0.1`, `[::1]`,
  `0.0.0.0`), or `OB1_ALLOW_REMOTE_DB=1` must be set.
- **Once connected, the server must report the database the URL names**
  (`pg_catalog.current_database()`), over TCP. Bun lets an exported
  `PGDATABASE` beat the URL's database, so this is asked on the connection
  that drops.

`OB1_ALLOW_REMOTE_DB` lifts the loopback host and the TCP requirement, and
nothing else: the other refusals say which database would be dropped. The
server's address is not compared with loopback, because through a container's
published port it is the container's. `hnsw-graph.ts`,
`graph-centrality.ts` and `tier.ts --replay/--diff` decide their exit code
after connecting and return it from `closeThenExit`, which closes the pool and
flushes their output first, as `migrate.ts`, `extract-entities.ts`,
`consolidate.ts` and `reembed.ts` do with their `run()`'s code (SMD-2304).
`test-connect.ts` holds the rule as a truth table, runs the door, and checks
that no script outside the suites reads `DATABASE_URL`, builds a client or
exits inside the door.

`migrate.ts` is also an engine (SMD-2304): `import { run } from "./migrate.ts"`
defines it and does nothing else, and `run({ url, dryRun, baseline, reapply,
force, grant, sql, writer })` is the CLI's run, returning the exit code — its
lines go to the `Writer` it is given (`cli.ts`; the CLI passes the console),
the migration files are read per call, and a client passed in is used in
place of the URL and never closed. It must be one connection (the `max: 1`
option), and it keeps the session state the run sets — lock_timeout, pgvector's
schema on search_path when it is off the path, the `ob1.acl_*` settings — so
pass one dedicated to the run, not a pooled connection another caller gets
next. The CLI is a thin `if (import.meta.main)` over it. `test-engines.ts`
holds each engine to that: an import opens no connection, prints nothing and
installs no process listener; the engine's code holds no exit, handler, argv
scan or console call; and `run()` refuses in the CLI's words before
connecting.

`extract-entities.ts` is the second (SMD-2304 PR 2): `run({ url, sql, env,
workers, batch, ttl, heartbeat, timeout, limit, follow, dump, job, status,
dryRun, switchKey, retryFailed, retryPartial, retryLeftOut, decide, writer,
signal, onPass })`. A number left out takes the CLI's default and one given is
held to its flag's rule, refused in the CLI's words; `env` is what the run
reads for the model, endpoints, egress policy and worker key (process.env when
absent). A caller's client needs a connection per worker and a spare the
heartbeat beats through (`max` at least workers + 1), and the worker key
resolves on a connection of its own, so a keyed run needs `url` beside `sql`;
a reserved connection or a transaction's handle is refused (one connection
whatever `max` it reports). `signal` stops the pass as a first signal does —
every worker after the thought in hand, waking a follower's sleep — and,
aborted before the pass, stops the run before its next write with 130
(`--status` and `--dry-run` read on). `onPass` is called once as the pass
begins, where the script installed its handlers, with the pass's stop
(`lease.ts`'s `PassStop`): the first call stops after the thought in hand;
one while it is already stopping (a second, or the first after the provider's
refusal stopped the workers) returns the release of every worker's leases,
and the thought in hand is abandoned — nothing written or released for it,
its model call aborted and no further window or retry sent (SMD-1794; a
`--decide` decider call in hand is waited for). The CLI installs
`lease.ts`'s `stopOnSignals` there, which exits 130 when that release
settles or after 3 s, and takes it off when run() settles — a signal
after that ends the process as one before the pass does.
`consolidate.ts` is the third (SMD-2304 PR 3), on the same shape: `run({ url,
sql, env, workers, batch, ttl, heartbeat, timeout, k, minSim, minConfidence,
limit, follow, stale, dump, list, accept, reject, direction, note, force,
status, dryRun, retryFailed, writer, signal, onPass })`, the numbers held to
the CLI's rules and order (`cli.ts`'s `numberProblem` judges an in-process
number by value, in the scanner's words), and the review flags' own rules
— which combine, a --list word, a proposal id, the pass's note marker — in
`reviewProblem`, an exported pure function the CLI and run() both refuse
through. `list` and `stale` only read, and read on under an aborted signal,
as `--status` does; a decision (`accept`, `reject`) writes, and stops under
one as a run does. A decision, like a run, resolves the worker key, so with
OB1_WORKER_KEY set it needs `url` beside a caller's `sql`. The judge
takes an AbortSignal, so the hard stop also aborts the call in hand: run()
returns at once in-process, as extract's does.
`reembed.ts` is the fourth (SMD-2304 PR 4): `run({ url, sql, env, workers,
batch, ttl, heartbeat, job, retire, acceptFailed, all, status, dryRun,
switchModel, retryFailed, retryFallbacks, writer, signal, onPass })`, with
`acceptFailed` the ids (`[]` for the flag alone). The numbers are held where
the CLI holds them — `--workers` and `--batch` first, `--ttl` and
`--heartbeat` after the embedding configuration, the CLI handing run() the
number it read (`cli.ts`'s `numberIn`) — and the modes' rule (one thing at a
time, `--all` only with `--accept-failed`) is `modeProblem`, a pure function
the CLI and run() share. The model and width are read from `env` by
config.mjs's own rules (`embeddingContract`), so the key, the checks and the
vectors name one model. It resolves no worker key, so a caller's `sql` needs
no `url` beside it. `--retire` and `--accept-failed` write, and stop under an
aborted signal as a run does; the hard stop abandons the row in hand once its
call returns (the embedder takes no signal; a database statement waiting on a
lock has no bound, and a vector already sent lands).

The claim workers bootstrap their egress, identity and error handling through
`worker-bootstrap.ts` (SMD-2303). **Egress:** one banner line, and one blanket
gate that stops a pass before it claims when the policy would refuse the call
whatever the row — its wording one text per case, the pass's verb ("extracted" /
"judged" / "re-embedded") the only difference — plus the identity re-gate.
`reembed.ts` gates its embeddings endpoint (and, with `OB1_CHUNK_CONTEXT`, warns
on the blurbs endpoint); `sync-linear.ts` wraps the bare reason in its own
sentence. **Identity** (`extract-entities.ts` and `consolidate.ts`):
`workerIdentity` checks `OB1_WORKER_KEY` against `MCP_ACCESS_KEYS` and resolves
it through the store's capped path (`SqlStore.resolveAgent`, which bounds
`lock_timeout` — the raw call the workers ran did not), refusing a revoked key
and warning when none is set. **Errors and actors:** one `classifyError`
classifies a provider error into thought / transient / fatal for both workers
(extract adds the `max_tokens`→fatal rule as an option), and `consolidate.ts`,
`reembed.ts` and `ingest-records.ts` build their audit actors through
`actorPayload` rather than by hand. **Outages** (SMD-2599): a `--follow`
worker of either kind waits a database outage out — `databaseUnavailable`
names the errors that mean the database is not answering (a connection
refused, closed or timed out; SQLSTATE class 08, 57P01–57P03, 53300), and
`waitOut` checks again after 5 s, doubling to 5 min, until it answers or a stop
wakes it; a thought in hand records nothing, and its lease is returned when the
database is back. It waits a provider outage out the same way.
- **Outages:** a transient error past the pauses, the model missing (`modelMissing`: a 404 that names the model, as while Ollama pulls it), and a timeout after which the probe gets no answer either.
- **What happens:** the thought in hand goes back to the pool unrecorded, and the follower probes until the provider answers. The probe (`probeChat`) is a one-token chat call to the pass's model, not GET `/models`, which Ollama answers while chat does not.
- **The thought's own fault:** `ProviderOutage` records failed a thought that fails again within 15 minutes of a probe answering. With several workers, which co-held thought is blamed for a provider crash is a race, and a provider that crashes again within the window can fail re-claimed thoughts. SMD-2641 retries suspects one at a time.
- **At start:** a follower probes once before it writes anything, the worker key's registration included, and waits for a provider that does not answer only after every other refusal. A model the provider does not serve, a refused key or a wrong base URL exits 2; an unreachable provider is waited for. Extract's escalation model is checked by GET `/models`, which loads nothing, and refused only where the list names models as chat does; one the start could not confirm draws exit 2 at its first 404, and one it saw that goes missing is waited for by name.

A run without `--follow` keeps every exit and failure it had. The module returns its outcome rather than
exiting, so an engine's `run()` returns it as a code — `extract-entities.ts`'s,
`consolidate.ts`'s and `reembed.ts`'s (SMD-2304).
`test-worker-bootstrap.ts` holds the egress wording, the drop-the-gate mutant,
the `classifyError` rules, the identity cases that refuse before connecting and
the outage rules and schedule, and the probe against a stub; `test-live.ts` [24b] the capped resolve, and
[10] and [16] each follower outlasting a database cut through a relay and a
provider outage (a 503, and in [10] the model missing, a hung provider, a
thought that fails every time, and the refusal at start); and `test-cli.ts`'s census checks that
no `db/` file outside the module reaches `refusesEverything`, `describeEgress`,
`resolve_agent(` or `parseKeyRecords`.

`weekly-digest.ts` (SMD-2239) is the first **sink** on this harness — it pages
the week's `thoughts`, has the chat model synthesize an importance-ranked digest,
and delivers it to Telegram, a file, or stdout. Two hops leave the box and both
pass the gate: the synthesis (the thoughts → the chat provider) through the gated
dialler `providerCall`, and the Telegram send (the digest → `api.telegram.org`)
through `mayLeaveBox` against the endpoint `telegramEndpoint` derives from
`OB1_TELEGRAM_API_BASE` / `OB1_TELEGRAM_LOCAL`. The gate names content units, not
hosts, and a digest belongs to no single row, so it declares its own —
`metadata.type = "digest"`, `metadata.source = "weekly-digest"`, the worker key
as the actor — and one term opts the sink in: `OB1_EGRESS_ALLOW=type:digest` (or
`source:weekly-digest`, or `actor:<key>`). Under the default deny with no such
term the send is refused, the refusal names the rule, and the digest is printed
to stdout instead — nothing reaches Telegram; `--output stdout|file` never leaves
the box (the synthesis still does). The sensitivity boundary is fail-closed: with
no `sensitivity_tier` column the run refuses rather than page every row, unless
`--no-sensitivity-filter` says so. `test-weekly-digest.ts` holds the ranking, the
chunking and the gate over a digest subject (the drop-the-gate mutant and each
allow term); `test-live.ts` [36] the sink end to end — a stub that records zero
Telegram sends under deny and one when allowed.

```bash
bun weekly-digest.ts --url … --output stdout                 # synthesize + print; no send hop
bun weekly-digest.ts --url … --window 14 --min-importance 3  # a wider window, a lower bar
OB1_EGRESS_ALLOW=type:digest bun weekly-digest.ts --url …    # post to Telegram (TELEGRAM_BOT_TOKEN/CHAT_ID)
```

The last line is the type check CI runs in the portable-server job (SMD-1932):
`tsconfig.json` here mirrors `server-portable/tsconfig.json`, and `package.json`
pins `@types/bun`, `typescript` and `@types/node` at the server's versions
(`check-fork-consistency` 18 holds the type-checked directories in step). The workers,
benches and suites import `../server-portable/*.ts` and are the first callers
to break when a shared signature moves; before this nothing compiled them, and
SMD-1903's required `subject` argument reached `reembed.ts`'s provider probe as
a runtime error that blamed the provider. Run it after any edit here; it needs
`bun install` in this directory and in `../server-portable`, and nothing else.
A plain-JavaScript module a `.ts` file here imports needs a `.d.mts` beside it
(`config.d.mts` beside `config.mjs`, `version.d.mts` beside `version.mjs`) —
without one the import is an implicit `any` and the check refuses it, which is
how SMD-1806's ingester met the step when it imported two `scripts/*.mjs`
(TypeScript since SMD-1870, so their declaration files went).

`test-search-path.ts` relocates pgvector into a schema off the connection's
`search_path` — how Supabase and several managed providers ship it, where
`CREATE EXTENSION IF NOT EXISTS vector` no-ops and the bare `vector` type does
not resolve — and asserts the runner heals its own session while preflight names
the persistent fix. The test container installs pgvector into `public`, on the
path, so nothing else in the matrix sees this; the suite restores it afterward,
which `ci-parity.sh` needs since it shares one Postgres. Its [7] holds the path
the migrator gives migration 021's transaction, `pg_temp` taken out, to the
schemas Postgres reads in the raw path (SMD-2247).

`with-postgres.sh` starts `pgvector/pgvector:0.8.6-pg16`, exports `DATABASE_URL`, runs
the command and removes the container on exit. It prefers podman (including the
macOS `/opt/podman/bin` location that is often off `PATH`) and falls back to
docker. CI does not use it — GitHub Actions supplies the database as a service
container.

`OB1_PG_KEEP=<name>` keeps the database instead: the container's data
directory is a named volume, `ob1-pg-keep-<name>`, which the removal on exit
leaves in place (the container itself is stopped with time to checkpoint, then
removed as always); a later run under the same name starts a fresh container
on that volume — the image, `/dev/shm` and port given then apply — and hands
the command the same database. The container carries the name too, so a
second invocation while one is running under it is refused rather than sharing
the database, and for a kept volume that already exists the readiness wait is about thirty minutes (1,800 tries, a second or more apart) rather than one, since a
kept data directory may start into crash recovery. `bench-hnsw.ts` uses it to
reuse a loaded corpus across passes (SMD-1493). Only `bench-hnsw.ts` should
run under a kept name: any suite's schema reset refuses a database holding a
kept corpus (set `OB1_DROP_KEPT_CORPUS=1` to drop it deliberately). What was
kept is yours to remove, and the exit line prints the command with the
runtime as the script found it (`/opt/podman/bin/podman` where `podman` is
off `PATH`):

```bash
podman volume rm ob1-pg-keep-<name>
```

The kept corpus and the exact answers its marker keeps (SMD-1562) have a
suite of their own:

```bash
./with-postgres.sh bun test-bench-reuse.ts   # nine bench runs at 150,000 rows against one database, ~3 min
```

It runs the bench eight times against the wrapper's one throwaway database,
telling only the bench that the database is kept (to the bench, "kept" is
the variable and the marker row; the volume is the wrapper's concern): a
build with five queries, a reuse with three (every answer the marker's), the
marker's answers stripped as a marker from before SMD-1562 has none and three
again (computed, and the marker extended), an answer given a duplicated id
and a query digest changed (computed for; one of three reused), then six
(three from the marker, three computed) and six again (all from the marker)
— asserting sections A, B, D and E agree, timings aside, between each run
that read the marker and the run on the same index that computed; then the
corpus marked `rewritten` and the next run refused before the oracle is
consulted. Two builds would
give two HNSW graphs and two recall figures, which is why every comparison
is on one index. It drops its marker table on the way out. Not in CI or
`ci-parity.sh`, for the three minutes of exact passes it costs.

### hnsw-graph.ts

Reads a pgvector HNSW index page by page and says which live rows its entry
point cannot reach. A vector search is a walk from the index's entry point over
its neighbour lists, so a live row in a component the entry cannot reach is
invisible to every search that walks; the walk itself cannot show that, since a
short answer from an approximate index looks the same whether the graph has a
hole or the beam stopped early. This decodes the pages the walk reads —
pgvector 0.8.x's `HnswMetaPageData`, `HnswElementTupleData` and
`HnswNeighborTupleData`, through `pageinspect`'s `get_raw_page` — and computes
reachability from the graph itself, then joins to the table so "live" means a
row the session can see.

```bash
./with-postgres.sh bun hnsw-graph.ts                              # both shipped indexes
bun hnsw-graph.ts --url "$DATABASE_URL" --index thoughts_embedding_idx --json
```

`pageinspect` is superuser-only, so this is a diagnostic for a database you
administer — the suites' throwaway containers, a local brain — not a check the
server runs on a managed database. It exists because of SMD-1632: over the
suite's near-equidistant vectors (orthogonal unit axes, every pair at cosine
distance 1.0) pgvector's neighbour-selection heuristic keeps few edges and the
graph is not connected, so a search misses a live row its own vector matches —
which is what flaked `test-live.ts` [7] before SMD-1574 moved its reads to the
exact branch. `test-live.ts` [17] drives it: the walk misses most axes of an
orthogonal corpus and none of a random one, and every row the decoder calls
unreachable is one the walk misses. A random, production-shaped corpus is fully
reachable; `REINDEX` does not clear the degenerate case (a rebuild of an
equidistant graph is no more reachable), so it is not the remedy the finding
first assumed. See FORK.md's SMD-1632 section.

### What only the live suite can catch

- **The migration runner.** `migrate.ts` talks to a server over TCP with `Bun.sql`.
  PGlite is not a server, so the ledger, `--dry-run`, `--baseline` and drift
  detection were untested until `test-live.ts` existed.
- **Driver-level parameter binding.** The double-encoding bug below is invisible to
  a test that writes SQL literals. It only appears when a client binds a JS value
  to a `jsonb` parameter.
- **The planner.** Whether HNSW is actually chosen, rather than merely present.
  [5] shows the index is reachable; [5c] shows it is chosen: the unfiltered
  branch's own statement, read from the catalog and run under the function's
  SET clauses at the configured width over [5b]'s 2,000 rows and 400 chunk
  rows, is an `Index Scan` on both HNSW indexes at match_count 10 and 50 under
  both plan modes — and, checked first, the same statement without 019's
  setting leaves at least one CTE off its index at that scale, so the section
  is not passing vacuously; where a planner takes both unaided (a narrower
  width, a tuned server) that control is skipped with the reason and the count
  reads 228 with 2 skipped. The same statement with `recency_weight = 0.3`
  (migration 020) is the same two index scans over a window four times wider —
  the `Limit` nodes read 160 at match_count 10.
- **Filtered recall at scale.** [5b] loads 2,000 random rows through a real HNSW
  index, tags 1% of them, and asserts a filtered `match_thoughts` returns exactly
  what a full scan returns. Under 007 that filter returned almost nothing.
- **Concurrent claims.** [8] holds ten leases open in one transaction while
  another connection claims under a 2 s `lock_timeout` — a wait would fail it —
  then races four workers on four connections through a 600-row pool and
  asserts on ids: none claimed twice, the union exactly the pool. A worker
  "dies" on a 2 s lease and a second worker receives its rows after expiry,
  on their second attempt. [8e] is the heartbeat (migration 031): a worker on
  a 5 s lease beats at 4.5 s, a claim past the original deadline gets none of
  its rows and its release succeeds; it stops beating and a claim after the
  renewed deadline receives its rows on their second attempt. [9] then runs
  `reembed.ts` with 600 ms embeddings, sixteen per claim and a 6 s lease
  renewed every second — a batch near ten seconds, well past its lease — and no
  row reaches a second worker. PGlite
  has one connection, so two sequential claims there are disjoint whether or
  not `SKIP LOCKED` does anything.
- **Two legacy twins fingerprinted at once.** [6b] holds one connection's
  `update_thought` on the first twin open in a transaction while a second
  connection re-embeds the other: `pg_locks` shows the second waiting on the
  *advisory* lock, not on the unique index, and once the first commits it
  returns ok with `duplicate_of` and a NULL fingerprint. With the lock line
  removed the same scenario waits on the transaction id and raises `duplicate
  key value violates unique constraint "idx_thoughts_fingerprint"` — measured,
  which is why the assertion names the lock type.
- **A capture and an edit of one text** (migration 033). [6e] holds a
  2-argument `upsert_thought` of text X open on one connection while a second
  edits another row into X: `pg_locks` shows the edit waiting on the
  *advisory* lock, and once the capture commits it is told
  `DUPLICATE_CONTENT` rather than raising 23505 — the case 018's header left
  open. Then a 4-argument capture of Y with windows held open while a
  3-argument re-capture of Y waits on the same lock: the windows stay when the
  labels match and go when they do not, where before 033 the read found no
  row and left them either way. And a capture naming `supersedes` is NOT held
  by the supersession lock an edit holds (since 035; at 033 it waited on it).
  `test-upgrade.ts` [12] applies 033 onto a populated 032: no row moves, the
  bodies carry every earlier piece and the sentinel, a capture through the
  2-argument form is attributed.
- **A re-capture writes no provenance** (migration 035). [13] captures a
  chain through `upsert_thought` and re-captures one text naming different
  provenance: the existing values stay, a row with none stays with none, and
  the return says `existed` and the pointer that stands. `test-upgrade.ts` [13] applies 035 onto a
  populated 033 whose re-capture had just filled a pointer: the pointer stays
  (no data change), the next such re-capture fills nothing, and no capture
  takes the supersession lock.
- **The routing count is gated by a sample of the heap, drawn by TID range**
  (migrations 037 and 038). [5d] loads 15,000 rows at the configured width
  into a vacuumed heap (asserting every page holds a live row, so no page
  the sample draws is empty),
  applies the last definer (041 — 039's body, run with `jit = off` and its
  two planner paths pinned) with its
  floor lowered to zero, and counts GIN index scans per call: the broad
  filter makes exactly one fewer under the gate than under 020's
  body (the collection skipped on every call — 037's TABLESAMPLE draw could
  reach fewer than three pages and miss, so the band was 0.75–1.0 then), the
  thin filter the same number (the collection ran), and both answer exactly.
  `test-schema.ts` [8e] holds the body's shape — the TID range probe, DISTINCT
  blocks, a LEFT join so an empty page counts among the pages drawn, the
  probe's LIMIT — and the three conditions, then runs the statement read out
  of the installed body on a compacted heap: five draws judged by the rule on
  a table too small to skip, each reaching two pages or more; its plan, TID
  Range Scans and no sequential scan; one block drawn eight times over counted
  once; and, an eight-block band emptied and vacuumed, the probe pinned to it
  reports eight pages drawn, no hit and eight buffers touched;
  `test-upgrade.ts` [14] applies 037 onto a populated 036 and [16] 038 onto a
  populated 037 — no column, signature, row or privilege moves — and each,
  after a hand re-apply of 014 puts the 4-argument form back, applies the
  migration under test alone and finds one form again.
- **The walk's index is half precision** (migration 039). `test-schema.ts`
  [38] holds the swap's every case — a re-run and a hand re-apply of 001
  rebuild nothing, a vector index put back under the name is swapped again, a
  staging index built beforehand is adopted — and pairs the body's cast with
  the plan: an Index Scan by the index's name under the body's ORDER BY, none
  under the raw column's; [20] compares the candidate CTEs to 014's with the
  cast taken out. [5] holds both plans on a real server; [5d] applies the
  last definer before it drops the index, the order 039's swap needed (it
  would have built one over its loaded rows). `test-upgrade.ts` [17] applies 039 onto a populated 038 — no row,
  signature or privilege moves, the walk agrees with the exact answer before
  and after, the index OIDs survive a re-apply, and an INVALID staging index
  (an interrupted `CREATE INDEX CONCURRENTLY`) is rebuilt rather than adopted.
  The recall, the bytes and the decision are `evals/eval-quant.ts`'s, on real
  vectors (FORK.md change 81).
- **match_thoughts runs with `jit = off`** (migration 040). [5e] turns off
  each planner path the sample has exactly one of (`enable_tidscan`,
  `enable_nestloop`, `enable_hashagg` with `enable_sort`) at session level
  on a heap with the floor lowered. For the one path 041 leaves unpinned
  (hashagg with sort): the statement read out of the body, explained under
  the function's settings, keeps its TID Range Scan at `disable_cost` and
  has no JIT block, the same statement with `jit` forced on has one, and
  through the function the mutant with 040's clause RESET pays the compile
  on every call (~50 ms) where the clause costs the default's time — on
  PostgreSQL 14–17; on 18, which counts disabled nodes instead of costing
  them, [5e] asserts that nothing is compiled either way and skips the
  mutant arm. `test-upgrade.ts` [18] applies 040 onto a populated 039: the
  body byte for byte 039's, `jit=off` beside 014's and 019's clauses, no
  row or privilege moves, and the last definer applied alone drops a
  hand-re-applied 014's 4-argument form.
- **match_thoughts pins the two planner paths its statements are built
  around** (migration 041: `enable_nestloop = on`, `enable_tidscan = on`).
  [5e]'s tidscan and nestloop cases now find the default's plan under the
  session's setting — a TID Range Scan at an ordinary cost, no `Disabled`
  node on 18, fewer buffers than the heap has pages — and, with the pin RESET (the
  mutant), `disable_cost` back on 14–17 and on 18 the disabled node back and,
  under `enable_tidscan = off`, the probe a sequential scan of the whole heap
  per block (SMD-1703's state). [5f] loads 6,000 rows with chunks and, under
  a session `enable_nestloop = off`, explains the three RETURN QUERY
  statements read out of the body under the function's settings: every join
  a Nested Loop touching the default's buffers; with the pin RESET a Merge or
  Hash Join touching at least the heap's page count more (the whole primary
  key, and every chunk row on the walk); and through the function the pinned
  call returns the default's ten rows under the setting. `test-upgrade.ts`
  [19] applies 041 onto a populated 040: the body byte for byte 040's, the two
  pins beside 014's, 019's and 040's clauses, no row or privilege moves, and
  the last definer applied alone drops a hand-re-applied 014's 4-argument
  form. `test-schema.ts` [20] and [21] pin exactly five clauses; preflight's
  `candidate scan` reads the pins beside 019's clause and 040's and names
  041, the last definer, as the remedy.
- **The backfill holds the table** (migration 023). [6c] plants a legacy
  singleton and two twins, runs `backfill_content_fingerprints()` on one
  connection inside an open transaction, and has a second capture the
  singleton's text and a third re-embed the newer twin: `pg_locks` shows both
  waiting on the *relation* lock; once the first commits the capture returns
  the singleton's id — merged, not doubled — and the edit is told
  `duplicate_of` the older twin rather than raising 23505. `reembed.ts
  --status` lists the same one group before and after. `test-upgrade.ts` [6]
  shows the doubling at 022 before applying 023 over it, then the merge.
- **The windows stay while the label vouches for them** (migration 022). [7]
  captures a thought at `old-model` with two windows through the 4-argument
  form and finds it by its second window; re-captured with the same text
  through the 3-argument form at the same model it keeps the windows and is
  found by the window and by the new vector; at another model it has no
  windows, is no longer found by the old window's axis and is found by the
  new vector's; a re-capture with no vector keeps the windows with the vector
  and its label. The found-by reads filter on a metadata key only that
  thought carries, so `match_thoughts`'s exact branch answers them and no
  HNSW walk decides (SMD-1574). The walk had missed live rows outright: over
  the suite's tied unit-axis vectors pgvector's graph is not connected and a
  search cannot reach them, which [17] reproduces and `hnsw-graph.ts` reads
  from the index (SMD-1632); [4], [11] and [15] moved to the exact branch for
  the same reason. `test-upgrade.ts` [5] shows the defect at 021
  before applying 022 over it, then both halves of the rule.
- **The re-embed, end to end.** [9] runs `reembed.ts` as a subprocess against a
  stub provider: refused without `--switch-model`, then two workers over
  thirty-eight rows including three chunked ones (one of whose whole-content
  calls is throttled with a 429, once — the other must still get its whole
  vector; the third is refused whole with a 413 every time, and must end
  succeeded with its head window, the refusal on its claim row, and the other
  two unaffected), a poisoned one, one whose first request is never answered
  under a 2 s `OB1_LLM_TIMEOUT`, one with no vector and two legacy twins with
  NULL fingerprints and the same text but for whitespace; asserts every vector,
  the chunk rows, one audit row rather than thirty-seven, both twins succeeded
  with exactly one fingerprinted and the pair named in the run and under
  `--status`, the refused thought listed under `--status` and the timed-out one
  failed with the setting named, a `--ttl` under two heartbeats refused with
  exit 2 before the pool exists, `ob1_config`, a re-run that processes only a
  later capture, the poisoned row accepted with `--accept-failed` (refused
  first without ids, for an id whose row is not failed, and beside a run flag;
  then succeeded with the caveat, its vector kept, counted and listed under
  `--status`, refused a second time), `--retry-failed` resetting the attempt
  count and giving the throttled thought its whole-content vector without
  touching the accepted row, `--retry-fallbacks` giving the refused one and the
  accepted one their whole-content vectors once the stub relents and clearing
  both caveats, and exit 1 while another process holds a lease. Preflight runs as a
  subprocess at four points — after a run killed just after it recorded the
  new model (the stub freezes every request but the probe, so the whole pool
  and nothing else is left for it to report), after the first run, while the
  ghost lease is held, and once every row is terminal — and each time prints
  the counts the tool printed; last, the recorded model is switched back and
  `--switch-model` to it again starts the pool over and re-embeds every row
  rather than finding nothing to do. Since 021: every re-embedded row carries
  the model that produced its vector; a server still on the old model
  re-captures one text and captures a new one after the pass finished, and
  preflight's `vector models` warns from the rows while the claim table says
  nothing, `--status` prints the corpus by model, a plain run under the model's
  own key re-embeds exactly those two while the suite's backfill key would pool
  every thought without a row, and a capture the switched server made is never
  pooled; one of the two rows the old server wrote is the poisoned text, so it
  keeps the old model's vector and label until the operator accepts it under
  the model's own key — preflight then says none unfinished and counts the
  vector as detail, a plain run leaves it, and a metadata edit since reopens
  it; `--retire` removes an abandoned switch's key as preflight's remedy names
  it, and refuses the recorded model's key, another tool's, an empty one and
  one with a live lease; the switch-back at the end moves the rows too, and a
  record moved by hand alone re-embeds no finished row.
- **Entity extraction, end to end.** [10] runs `extract-entities.ts` against a
  stub model that answers from a table, so the expected graph is known exactly:
  seven entities, fourteen mentions, five edges from ten thoughts, one of which
  answers in prose and fails. The worker authenticates with a minted key and
  every mention carries its agent id. Then the ticket's four checks: a second
  run makes no model call and leaves the graph byte-identical; an edit through
  `update_thought` re-enqueues the thought and the stale entity does not
  survive; a delete leaves no edge citing the thought and the relation another
  thought still evidences keeps that one row; and `--follow` extracts a capture
  made while it polls, then exits 0 on the first signal. Last, a thought over
  `OB1_EXTRACT_MAX_WINDOWS=2` is released succeeded with a `partial:` caveat,
  its opening's entities and edge in the graph and its closing's entity not, `--status` counting
  and listing it apart; `--retry-partial` under the default bound reads it
  whole and clears the caveat (SMD-2240). Then, under a bound of two, a
  two-window thought whose second window the stub answers in prose is released
  succeeded with that window named in its caveat, the other window's entities
  and edge in the graph, a three-window thought so is released with the window
  and the bound both named, and a two-window thought answered in prose
  throughout is failed; `--status` counts and lists the two kinds of partial
  row apart, the row of both among the windows left out and counted over the
  bound too; `--retry-left-out`, run as `--status` advises — another model,
  `--job` this pool's key — the stub answering now, takes those two and not the prefix, saying one is a
  prefix too, and clears their caveats and adds the windows' entities, and
  `--retry-partial` then takes the prefix (SMD-2260). Three 24-window papers
  with 4, 3 and 1 windows in prose — the stable brain's reference-list papers
  as the 7B reads them, 8 of 72 answers — are written and the run exits 0 with
  no alarm; four 12-window papers with 5 windows each in prose, 20 of 48
  answers and no row failed, exit 3 where they exited 0, naming
  `--retry-left-out` alone; three 12-window papers with 5 each in prose and 12
  one-window notes in
  prose, 27 of 48 answers, exit 3, before the notes' failures' 1, the stderr
  line naming the share and the model, the papers' rows standing; a `--follow`
  process given 48 notes in prose prints the line as it polls, not at its
  stop, and exits 0 on SIGINT; and `--retry-failed` over the 60 notes, still in
  prose, exits 3 saying their documents may be at fault; a `--follow --limit`
  that trips on its last pass says it exits 3, and does (SMD-2266).

### What test-schema.ts asserts

`bun test-schema.ts` applies every migration to a real PostgreSQL 17 in-process and
asserts 749 properties (at migration 032), including:

- every migration applies, **and applies twice without error**
- the table shape and every index access method match the guide
- the trigram index is **present** under the shipped default, and the flag gates
  it in both directions — a flag whose two states produce the same schema is not
  a flag, and asserting only the on-direction would pass against a migration that
  ignored the flag entirely. When present it is not merely there but reachable:
  with `enable_seqscan` off the planner picks it for a leading-wildcard `ILIKE`,
  which a bare `gin (content)` would not satisfy
- `search_thoughts_keyword` is exact (`upsert_thought` does not match
  `upsert-thought`, `100%` is not a wildcard), counts occurrences, reports a
  `total_count` that agrees with an independent `count(*)`, and returns the right
  rows for a two-character needle the index structurally cannot serve
- **paging is stable when the plan changes underneath it.** The obvious version of
  that test — page six tied rows and look for repeats — passes whether or not the
  `ORDER BY` has a unique final key, because at that size Postgres returns ties in
  the same order every time. The real test alternates `enable_seqscan` between
  pages over 400 tied rows. Measured with the tiebreak removed: 2 repeats, 398 of
  400 covered. With it: 0 and 400
- both `upsert_thought` overloads resolve — the 3-arg form has no default on
  `p_embedding`, because a default would make the 2-arg call ambiguous and break
  every existing caller with `function is not unique`
- fingerprint dedup normalises whitespace and case, and merges metadata rather
  than overwriting it
- the atomic overload stores an embedding in one statement, and a `NULL` embedding
  on re-capture does not blank an existing vector
- `match_thoughts` orders by cosine similarity, honours `match_count`, and filters
  by `jsonb` containment
- the threshold comparison is **strict** — a row whose similarity exactly equals
  the threshold is excluded. Anyone reimplementing this in raw SQL must keep the
  strict `>` or result counts change silently.
- **the filter is applied inside the candidate scan** (migration 014): with sixty
  nearer rows of one kind in front of them, both rows of the filtered kind come
  back — including one reachable only through its chunk — a NULL filter is
  unfiltered, `match_count = 50` returns 50, the ceiling is the one
  `config.mjs` defines, and `pg_proc.proconfig` carries
  `hnsw.iterative_scan=relaxed_order` and nothing else — not the two walk
  bounds, which live on the database so `ALTER DATABASE` tuning is never
  overridden, and not a forced plan mode, which the branch-per-path body made
  unnecessary. A later `CREATE OR REPLACE` that drops the SET clause, or adds a
  bound or a plan mode to the function, fails here rather than in search. The
  exact branch is held to the unfiltered answer on the same rows, and [8c]
  holds the walk branch — reached only above 1,000 matching rows — to an exact
  scan, and [8d] that rows with no vector and no chunks do not count towards
  that threshold; the bounds' seeding is asserted, that re-applying 014 leaves an
  operator's database-level value alone, and that a value set only for the
  session (standing in for `ALTER ROLE`) does not stop the seed
- no `auth.uid()`, `auth.role()`, `service_role` grant, or RLS survives
- a non-object `p_payload` raises rather than silently storing `{}`
- `thought_chunks.context` exists and is nullable, and **both** functions that
  write chunk rows carry it through. Checking only `upsert_thought` would pass
  against a migration that strips context on the first edit
- `thought_work_claims`' state machine: the pool is idempotent to build, an
  unknown id fails the foreign key rather than being skipped, only the holder
  can release and only once, a clean shutdown returns rows without counting an
  attempt, an expired lease is handed out again with the attempt counted and
  is marked failed after three, a deleted thought takes its claims with it,
  and the `CHECK` refuses a claimed row without a lease
- the caveat rule is stated at the table (migration 028): the live comments on
  `thought_work_claims.last_error` and `release_thought` carry both meanings by
  status, that NULL on success is clean, the rule as the column's, and a pointer
  to `reembed.ts`'s header for reader behaviour — whichever migration wrote them
  last; the acceptance prefix is named by its constant, not quoted; neither
  carries `--`; and a succeeded release with `p_error` stores it while NULL
  leaves the column NULL
- `extract_search_needles` (migration 017) takes quoted and backticked spans as
  written and identifier-shaped tokens — `SMD-944`, `upsert_thought`,
  `db/config.mjs`, `getUserById`, `0.8.6` — and not bare numbers, two-character
  strings or ordinary words; de-duplicates case-insensitively; stops at eight
- `search_thoughts_hybrid` returns **exactly `match_thoughts`' rows in
  `match_thoughts`' order for a query with no needle**, at three thresholds; puts
  the exact hits first for an identifier alone (the gate), the one with a vector
  before the one without, then the vector arm's rows; scores a row both arms
  return as presence plus its vector rank, so it outranks any row in one arm;
  keeps an exact hit whatever the threshold; reports a needle in more than 100
  thoughts as common and boosts nothing with it; passes the filter to both arms;
  clamps `match_count` to 1–100; and left `upsert_thought`, `match_thoughts` and
  `search_thoughts_keyword` alone
- the entity layer: the resolution rule case by case (a ligature normalises,
  an accent does not; "Postgres" and "PostgreSQL" stay apart), the `CHECK`
  vocabularies match the lists `server-portable/entities.ts` parses against,
  `record_thought_entities` drops the unknown type and the unlisted relation
  and counts them, stores symmetric relations ordered, is idempotent down to
  the entity ids, replaces and prunes on re-extraction, refuses a stale
  fingerprint; `merge_entities` refuses across types and keeps the loser as an
  alias; the trigger is silent until the key is set, ignores metadata-only
  edits, and revokes a live lease on a content edit
- **an unchanged edit is never a duplicate** (migration 018): of two NULL-
  fingerprint rows with the same normalised text, re-saving the first's own
  text gives it a fingerprint and re-saving the second's succeeds with
  `duplicate_of` naming the first and its own fingerprint still NULL; editing a
  third row *into* that text is still `DUPLICATE_CONTENT`; a whitespace-only
  edit moves the text and not the fingerprint; a legacy row with no twin is
  backfilled; a metadata-only edit touches neither; `if_unchanged_since` still
  refuses a stale write; and `update_thought` is still one function whose body
  names 008's actor, 009's guard, 013's context, 016's fingerprint function and
  the advisory lock
- **the plan setting and the row estimates** (migration 019): `match_thoughts`
  carries exactly `hnsw.iterative_scan=relaxed_order` and `enable_seqscan=off`
  and declares `ROWS 10`, `search_thoughts_keyword` declares `ROWS 25`, a
  composing `EXPLAIN` estimates 10 and 25 rows, the keyword body is 012's byte
  for byte and `match_thoughts`' three candidate CTEs and routing statement are
  014's (re-applied and compared), re-applying 012 alone resets its estimate to
  1,000 — and re-applying 014 puts the 4-argument function back *beside* 020's,
  after which a 4-argument call is `function is not unique`
- **the recency blend** (migration 020): one `match_thoughts` and one
  `search_thoughts_hybrid`, the new signatures; at weight 0 the rows, their
  order and their similarities are 019's — 019's own function installed from
  its file under another name and compared over eighteen calls reaching the
  unfiltered and the exact branch — and `score` equals `similarity` exactly; a
  thought found only through a chunk is found through the recency path; two
  rows swap as the weight crosses the formula's crossover, a shorter half-life
  moves the crossover where the formula says, and one weight gives opposite
  orders under two half-lives; the threshold gates the raw similarity; weights
  are clamped, a non-positive half-life refused, a NULL `created_at` scores as
  infinitely old and `-infinity` likewise, `+infinity` brand new, and neither
  is subtracted at weight 0 (PostgreSQL 16 refuses that); a recent row ranked
  61st by similarity comes first under a weight, which only the widened window
  allows; rows with equal scores come back in id order, through a LIMIT too;
  the fused function follows the weighted order with its `similarity` still
  the cosine, returns the newest row *above* the threshold when given a weight
  and a threshold, puts a keyword hit below the threshold first under a
  weight, ranks an unembedded hit captured today above an old embedded one at
  weight 1, orders a literal-only query by the blend; `v_exact` is sized from
  the unweighted window; and 020 replays the old function's ACL across its
  DROP — a revoke and a grant on the 4-argument form both carried to the
  6-argument one, a role the defaults grant to stripped when the old form had
  revoked it, and a hardened 6-argument form left alone on a re-run
- **the vector's model** (migration 021): the column, text and nullable, with
  its comment; `upsert_thought` writes the envelope's `embedding_model` beside
  the vector, NULL without it, through the 2-argument form and beside a NULL
  vector; a re-capture with a vector relabels, one without keeps vector and
  label, a metadata-only one too; `update_thought` relabels with a vector, blanks the label with
  content and no vector, leaves a metadata-only edit, and a 7-argument call
  resolves through the default; a re-embed and a label-only change write no
  audit row; one `update_thought` of nine parameters (032) carrying 018's body by
  name, 032 the last definer of `update_thought`, 025 of `upsert_thought` and of the audit
  trigger; 018 re-applied puts a second form beside it and a 7-argument call is
  `not unique` until the last definer is re-applied; and the ACL replayed across the drop of
  the 7-argument form, the four cases above for this function
- **provenance through the edit path** (migration 032): `update_thought`'s
  ninth parameter sets, leaves, replaces and clears `supersedes` and
  `derived_from` — one audit row per change with the actor and nothing else
  moved — and refuses a ghost, a self-pointer and a loop direct or through a
  chain with nothing written; the four exceptions and a double-encoded
  envelope; `if_unchanged_since` guards a provenance edit;
  `validate_derived_from` answers as `upsert_thought`'s inline copy does, input
  by input; `review_supersession_proposal` writes through `update_thought`
  (its acceptance is an `update_thought` audit row, its loop refusal names the
  pair) and holds no `UPDATE` of `thoughts`; 021 re-applied leaves its
  8-argument form beside the 9-argument one and an 8-argument call is `not
  unique` until 032 is re-applied, and the ACL crosses that drop too
- **the windows stay while the label vouches for them** (migration 022):
  through a window planted directly (see below), a re-capture through the
  3-argument `upsert_thought` at the same model moves the vector and keeps
  the windows; at another model, naming no model, or over a row whose label
  is unknown it removes them; one with no vector keeps windows, vector and
  label, and so does a 2-argument re-capture; a first capture has nothing to
  remove; the body carries the `ob1:vector-replaces-chunks` sentinel and
  reads the row's label `FOR NO KEY UPDATE` before the write; the 4-argument form is 013's; three overloads, 022 the last definer
  of `upsert_thought`; and the trap — 021 re-applied puts 021's body back and
  a re-capture at another model leaves the windows again, until 022 is
  re-applied
- **every legacy singleton, and the oldest of each twin group, takes its
  fingerprint once** (migration 023): rows planted with NULL fingerprints —
  a singleton, twins dated apart, a pair whose older row has no `created_at`,
  a row whose text a captured row already holds, a row whose key a stale
  holder carries — and one call: the singleton, the older twin and the dated
  raw row take their keys (three written), the rest stay NULL and the stale
  key is untouched; no `updated_at` moves, no audit row, the trigger enabled
  again; a capture of the former singleton's text merges into it, an
  unchanged edit of the newer twin names the older as `duplicate_of`; a
  second call writes nothing; `p_limit` bounds a batch and the third returns
  0 with the blocked rows still there; one function; 023 re-applied re-runs
  the call and moves nothing
- **a vendored schema applied to a migrated brain replaces no function a
  migration owns** (SMD-1250): the owned set is read from the migration files
  as `scripts/check-fork-consistency.ts` check 7 reads it, and the three last
  definers preflight's remedies spell are pinned; `schemas/enhanced-thoughts/schema.sql`
  applied whole leaves every owned body and overload byte for byte while its
  own columns and functions arrive; then what upstream's file did — 003's
  2-argument body over 005's raises nothing, changes one body, and a
  double-encoded payload is emptied silently again; 022 over 025 keeps 022's
  sentinel and drops 025's envelope, which preflight's recogniser sees; the
  last definers re-applied put every body back
- **`graph-centrality.ts` counts what it says it counts** (SMD-1938): over a
  graph built by `record_thought_entities` with every count known — a
  subject, three neighbours, a numeric-named `person`, a merged entity — the
  script's exported SQL runs through PGlite: mentions, degree and support as
  the header defines them, the numeric entity in no list and no count and in
  every one when kept, the merged name resolving through `merged_from`, the
  ladder's five outcomes (id, exact, alias, fuzzy, none) and its stop for a
  numeric name that is an entity, the grouping of several returned names
  around the first, the neighbourhood's
  order with edges on differing from the order without at every position,
  two runs byte-identical, the caveats in the rendered text with the run's
  numbers, and the flags refused as documented; the thoughts carry the
  lifecycles board-sync stamps (Done, In Progress, Backlog, Todo, Canceled,
  none, an unknown `status_type`), every count above read at weight 1 so the
  default is the drop-the-filter control, then the same graph under `--status
  open` / `active` / `done` and `--decay-done` — the settled thoughts' evidence
  gone or at a quarter, the neighbourhood's order moving at two positions,
  degree unchanged under decay, the unstamped thoughts listed under every
  filter and counted, the caveat carrying the freshness and the counts, and
  decay beside a filter refused (SMD-1994)

One thing this suite deliberately does NOT assert: that a context survives a
capture, an edit and a payload that omits it. Writing chunk rows through the
4-argument `upsert_thought` crashes PGlite's WASM build in this process —
`received invalid response: 0` when the payload is bound as a parameter, `Out of
bounds memory access` when it is inlined — and it reproduces with migrations
001-012 applied and no 013, at any position in the file, on a second instance as
well as the shared one. So it is the harness rather than the migration, and the
round trip is asserted in `test-live.ts` [7] against a real server instead.

### The double-encoding trap

Both overloads read metadata as `COALESCE(p_payload->'metadata', '{}')`. The `->`
operator returns NULL for anything that is not a JSON object, so a caller that
passes a JSON *string* stored empty metadata and got a success back — content and
embedding written correctly, metadata gone.

Client libraries differ on this. `Bun.sql` binds a JS string to a `jsonb`
parameter as a JSON string (`jsonb_typeof = 'string'`), not an object; pass a JS
object instead. Upstream has already fixed this same class twice, in
`thought-enrichment` and `add_household_item`.

Migration 005 makes it raise. Valid calls — an object, `NULL`, or the `'{}'`
default — are unaffected.

## Caveats

- **Not yet run against a managed Postgres.** Verified against PGlite (PostgreSQL 17
  in WASM) *and* a real `pgvector/pgvector:0.8.6-pg16` container, but neither is RDS or
  Neon. Run `--dry-run` first against the real target.
- **HNSW index build time is not represented.** On an empty table it is instant; on
  a populated one it is not. Build it after a bulk load, not before — and with
  `maintenance_work_mem` sized for the graph, which a parallel build keeps in
  `/dev/shm`: a container's default 64 MB fails the build past a few hundred
  thousand rows ("could not resize shared memory segment"), so `deploy/compose.yaml`
  sets `shm_size` (`POSTGRES_SHM_SIZE`), and where it cannot be raised
  `max_parallel_maintenance_workers = 0` builds in ordinary backend memory.
  `bench-hnsw.ts` section L has the build times by scale. Migration 039
  rebuilds both HNSW indexes over `embedding::halfvec` on a populated brain,
  writers held for the build, in the migrating session's
  `maintenance_work_mem` — the server's 64 MB unless the role was given more,
  and past some 25,000 vectors that is pgvector's slow on-disk phase. Size it
  first: about 2.5 KB per vector across `thoughts` and `thought_chunks`
  (250 MB per 100,000, 2.5 GB per million), `/dev/shm` at least that under
  parallel workers; with the graph in memory the build ran at about 100 µs a
  row with four workers, and the migrator prints the vector count and the
  setting in force just before 039. It adopts staging indexes built beforehand
  with `CREATE INDEX CONCURRENTLY` under the names its header gives, which is
  the path for a brain past a million rows.
- **Data migration is not covered here.** These migrations create the schema. Moving
  rows is `pg_dump --data-only`, plus `bun reembed.ts --switch-model` if the model
  family changes at the same width.

## Related

- `../FORK.md` — what this fork changes and why
- `../server-portable/` — the runtime-neutral server (Phase 3)
- `docs/01-getting-started.md` — the original prose the schema was extracted from
