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
  the `test-search-path.ts` note under Testing.
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
`OB1_TRGM_INDEX` is on and the index is absent; 023's call runs again and takes
its lock (`OB1_BACKFILL_LIMIT` bounds it, as on a first apply; it writes nothing
when no row is waiting); 025 re-validates its constraints over the table. 021's
evidence backfill runs as written, the acceptances out of its sight (above);
030, reached after it in the same transaction, finds nothing of 021's to take
back and corrects the own-key labels an earlier paste of the body left
(SMD-1193, SMD-1421).

## Expected outcome

`bun test-schema.ts` prints `1645 assertions: 1645 passed, 0 failed` and `PASS`.
Against a real database, `bun migrate.ts` reports fifty-four (54) migrations applied, and
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
051 SMD-1804, 052 SMD-1296, 053 SMD-1867, 054 SMD-2090).

Migration 044 records `schema_version` in `ob1_config` — the version the brain was
migrated under (`MAJOR.MINOR.PATCH+upstream.<sha>`; 044 wrote the pre-first-release
baseline `0.0.0+upstream.9543c29`), and every release cut appends the migration
that writes its version as the last file of the range it freezes: 048 writes
`1.0.0+upstream.9543c29`, the first release (`001..048`), and 051 writes
`1.1.0+upstream.9543c29`, the second (`049..051`). `preflight` prints the
value beside the ledger's highest migration and warns when a server is older than
the brain, or a brain has run past its version's range. Both are introduced by a
fragment or a cut rather than a hand-numbered change, so they are named here by
their ticket (FORK.md's "Versioning" and "Cutting a release", SMD-1804, SMD-1860).

The decision that `thought_audit` is the write-side source of truth and the
`thoughts` row its projection — the write functions appending the event first
and one projector writing the row, the audit trigger becoming the check, the
table kept for the community's DDL — is `../docs/event-log-as-truth.md`
(SMD-1997). Its three steps are filed (SMD-2115, SMD-2116, SMD-2117) and none
has landed: at 053 the row is still written first and the trigger derives the
event from it, as the paragraphs below describe.

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
`update_thought`; nothing over MCP sends one yet (SMD-1724, 1725, 1733).

Migration 049 widens `ob1_agent_keys.scope`'s CHECK from `read, write` to
`read, write, capture` (dropping every CHECK on the column first, whatever name a
restore left it under) — the third key scope `server-portable/auth.ts` mints for
a session-end hook (`bun keygen.ts --scope capture`: `capture_thought` alone, no
read tool, no update, no delete; `recipes/session-capture-hook`). The column is
010's record of the scope a key last presented, not a gate; without the widening
`resolve_agent()` would have refused the row and every capture through such a
key would have landed without its agent id. Named by ticket for the same reason
as 044 (SMD-1298).

Migration 050 puts the writer on the row (SMD-1726): two reserved keys in
`thoughts.metadata`, `actor_kind` and `actor_name`, stamped by a BEFORE trigger
(`thoughts_stamp_actor`) from the write's envelope through 046's registry lookup
and never from the payload — a caller's own values under either key are
overwritten or removed. The actor follows the content: a capture and a
content-changing edit stamp from the key present, a metadata-only edit keeps the
mark. In metadata rather than columns because 014's `metadata @> filter` route
over 001's GIN index already reaches it: `said_by` and `actor` on the search and
list tools are that filter, and every hit prints `By: <key> (<kind>)`.
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
issues every group at once.

| Group | Object (migration, or `schemas/` file) | Privileges |
| --- | --- | --- |
| **capture** — the server's own connection; preflight refuses a role missing any of it | `thoughts` (001) | `SELECT, INSERT, UPDATE, DELETE` |
| | `thought_chunks` (007) | `SELECT, INSERT, DELETE` |
| | `thought_audit` (008) | `INSERT` |
| | `thought_facets` (042) | `SELECT, UPDATE` — the delete guard reads the citations that name a thought and, detaching, writes them, on every delete |
| | `ob1_agents` (046) | `SELECT` — the audit trigger reads the key's kind on every write that carries an actor (SMD-1730) |
| **server** — the server's soft extras, beyond capture; never fatal to a bare capture (the `SELECT` on `ob1_agents` 046 made hard is in capture, above), but `resolve_agent` *upserts* the agent tables, so attribution needs the writes, not just `SELECT` | `ob1_config` (006) | `SELECT` |
| | `ob1_agents` (010) | `SELECT, INSERT, UPDATE` |
| | `ob1_agent_keys` (010) | `SELECT, INSERT, UPDATE` |
| | `thought_audit` (008) | `SELECT` — a capture-only key may supersede only a thought whose capture row is its own (SMD-1298); without this the server refuses that pointer and names the grant; `thought_changes` (052, SMD-1296) reads the log for the MCP tool of the same name, and names the grant too |
| **worker** — `reembed.ts`, `consolidate.ts`, `extract-entities.ts`: claim work, upsert a job key into `ob1_config`, and (consolidate) record/resolve proposals | `thought_work_claims` (015) | `SELECT, INSERT, UPDATE, DELETE` |
| | `ob1_config` (006) | `INSERT, UPDATE` |
| | `supersession_proposals` (029) | `SELECT, INSERT, UPDATE` |
| **extraction** — the entity-extraction worker, additionally | `ob1_entities` (016) | `SELECT, INSERT, UPDATE, DELETE` |
| | `thought_entities` (016) | `SELECT, INSERT, DELETE` |
| | `ob1_entity_edges` (016) | `SELECT, INSERT, DELETE` |
| **querylog** — the opt-in query log (`OB1_QUERY_LOG=on`, off by default, SMD-1295); the server writes it only when enabled, and only inserts | `query_log` (034) | `INSERT` |
| **community** — the schemas under `schemas/`, applied by hand beside the migrations (SMD-1796). Upstream's files granted these to Supabase's `service_role` and enabled RLS with a policy for it; neither exists off Supabase, so the files grant nothing now and this group does — the privileges upstream gave its service role, plus what Supabase's default privileges hid: `USAGE` on a `BIGSERIAL` column's sequence, and `EXECUTE` on a function `REVOKE`d `FROM PUBLIC`. Issued for whichever files you have applied; the rest are skipped and named | `thought_audit` (schemas/thought-audit — 008's table; upstream's `SELECT, INSERT`, kept) | `SELECT, INSERT` |
| | view `thought_provenance` (schemas/thought-audit, `author-session-id.sql` — a view over `thoughts`, which needs its own `SELECT`) | `SELECT` |
| | `agent_memories`, `agent_memory_source_refs`, `agent_memory_artifacts`, `agent_memory_relations`, `agent_memory_review_actions`, `agent_memory_recall_traces`, `agent_memory_recall_items`, `agent_memory_audit_events` (schemas/agent-memory) | `SELECT, INSERT, UPDATE, DELETE` |
| | `openbrain_agents`, `agent_memory_keys` (schemas/per-agent-identity) | `SELECT, INSERT, UPDATE, DELETE` |
| | function `lookup_agent_memory_key(text)` (schemas/per-agent-identity; SECURITY DEFINER, `REVOKE`d `FROM PUBLIC`) | `EXECUTE` |
| | `ingestion_jobs`, `ingestion_items` (schemas/smart-ingest) | `SELECT, INSERT, UPDATE, DELETE` |
| | sequences `ingestion_jobs_id_seq`, `ingestion_items_id_seq` (schemas/smart-ingest; `BIGSERIAL` ids) | `USAGE, SELECT` |
| | function `append_thought_evidence(bigint, jsonb)` (schemas/smart-ingest; SECURITY DEFINER, `REVOKE`d `FROM PUBLIC`) | `EXECUTE` |
| | `entities`, `edges`, `entity_extraction_queue`, `consolidation_log` (schemas/entity-extraction — upstream's tables, not 016's `ob1_*`) | `SELECT, INSERT, UPDATE, DELETE` |
| | `thought_entities` (schemas/entity-extraction names 016's table under `IF NOT EXISTS`; the **extraction** row's privileges exactly, so the merge widens nothing) | `SELECT, INSERT, DELETE` |
| | sequences `entities_id_seq`, `edges_id_seq`, `consolidation_log_id_seq` (schemas/entity-extraction; `BIGSERIAL` ids) | `USAGE, SELECT` |
| | `thought_edges` (schemas/typed-reasoning-edges) | `SELECT, INSERT, UPDATE, DELETE` |
| | sequence `thought_edges_id_seq` (schemas/typed-reasoning-edges; `BIGSERIAL` id) | `USAGE, SELECT` |
| | function `thought_edges_upsert(uuid, uuid, text, numeric, integer, text, timestamptz, timestamptz, jsonb)` (schemas/typed-reasoning-edges; `REVOKE`d `FROM PUBLIC`) | `EXECUTE` |
| | `wiki_pages`, `wiki_sections` (schemas/wiki-pages) | `SELECT, INSERT, UPDATE, DELETE` |
| | `wiki_section_revisions` (schemas/wiki-pages; append-only — upstream's intent, kept) | `SELECT, INSERT` |
| | functions `wiki_upsert_page(text, text, text, jsonb, text)`, `wiki_write_section(uuid, text, text, text, text, jsonb, uuid[], integer, text)`, `wiki_accept_pending(uuid, text)` (schemas/wiki-pages; `REVOKE`d `FROM PUBLIC`) | `EXECUTE` |
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

Plus `USAGE ON SCHEMA public`. The migrations' own tables need no sequence
grant — every primary key is a `uuid` or a natural key — but three community
schemas use `BIGSERIAL` ids, and an `INSERT` into such a table needs `USAGE` on
the sequence (`permission denied for sequence …` with the table fully granted),
so the **community** group names those six sequences; an identity column
(`wiki_section_revisions.id`) needs none. Both are measured, not recalled:
test-schema [40] grants the tables alone and watches which inserts are still
refused. Functions are executable by `PUBLIC` by default, so only the community
functions upstream `REVOKE`d `FROM PUBLIC` — the SECURITY DEFINER ones, and the
wiki RPCs — are listed, for `EXECUTE`; the rest (the brain-stats, enhanced-thoughts,
readwise and CRM RPCs) need nothing. `ob1_config` appears twice — `SELECT` for
the server's own read, `INSERT, UPDATE` for a worker's job key — as does
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
them, so a locked-down deployment can grant a subset by hand. A role that only
ever runs the server needs the **capture** and **server** groups; add **worker**
for the role your bulk passes connect as, and **extraction** on top of that for
entity extraction. The **community**, **extensions** and **recipes** groups are
issued for whichever schema files you have applied — the objects not yet
present are skipped and named, so run `--grant` again after applying one; apply
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

### `reembed.ts`

```bash
OB1_EMBEDDING_MODEL=bge-m3 bun reembed.ts --url postgres://… --switch-model
bun reembed.ts --url … --status              # where the pass stands
bun reembed.ts --url … --dry-run             # what a run would do; writes nothing
bun reembed.ts --url … --job reembed:x@1024:ctx   # a backfill under the same model (keep the reembed: prefix — preflight reports by it)
bun reembed.ts --url … --retry-failed        # failed rows back into the pool first
bun reembed.ts --url … --retry-fallbacks     # …and the rows stored with a head window (below)
#   --workers N (2)   --batch N (8)   --ttl SECONDS (900)   --heartbeat SECONDS (60, or a third of the lease when that is shorter; at least 1, and the lease must cover two)
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
every start and warns, in the counts `--status` prints, for every unfinished
key that starts with `reembed:` (the configured model's key, or a backfill's;
extraction keys are left out because 016's trigger keeps that pool fed). No
marker to clear: the claim table is the record of the pass and nothing else.
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
bun extract-entities.ts --url … --follow [SECONDS]      # …then keep polling for new captures
bun extract-entities.ts --url … --limit 25              # a trial: this many, then stop
bun extract-entities.ts --url … --status                # the pass, and the graph so far
bun extract-entities.ts --url … --dry-run               # what a run would do; writes nothing
bun extract-entities.ts --url … --retry-failed          # failed rows back into the pool first
#   --workers N (2)  --batch N (1)  --ttl SECONDS (900)  --heartbeat SECONDS (60, or a third of the lease; at least 1, and the lease must cover two)  --timeout SECONDS (300, per model call — per window of a long thought)
bun extract-entities.ts --url … --switch-key           # required when the model or prompt version differs from the recorded key
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
one call could not finish, where windows alone reached 10 to 13. The answer is
streamed, and a call is aborted the moment its answer holds three copies of one
item (`RunawayDetector`, `RUNAWAY_REPEATS`; SMD-1960) — the loop is visible on
the stream long before the budget, so a runaway costs seconds rather than the
minute the budget allows (the 32 stragglers' pass measured 1,796 s against
3,158, 31 of 32 extracting; the 32nd extracts on a re-run under the shipped
retry rule, so 32 of 32 is derived, not re-measured whole) — and a call
aborted so is retried as a cut one is, the retry read whole, since a penalised
answer was measured to repeat an item three times and recover; an
answer that enumerates distinct ids is not a loop by that rule and runs to the
budget, which stays the bound. A thought whose retry also runs away is recorded
failed, retryable. The window is the **metadata model's**, not the embedding
model's: `OB1_EXTRACT_CHUNK_TOKENS` when set, else derived from the model's
served context (`KNOWN_CHAT_MODEL_WINDOW`, measured as `KNOWN_MODEL_WINDOW` is)
and held at the size the default model was measured to finish reliably; a model
the table does not list gets that default. The banner's `window:` line and
preflight's `extraction window` row print the same sentence. The prompt version
is 2 — a pass under it re-extracts a brain whose thoughts were cut at 8,000
characters under p1 — so the first run after upgrading needs `--switch-key`.
`--dump`'s line carries `windows`, `retried` and `abortedMs` — how far into
the call a runaway was aborted on the stream — and, for a windowed thought,
each window's own answer in `parts` beside the merged one. Why, measured:
`evals/README.md`, "Entity extraction in windows".

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
of scope by default, `--keep-numeric` admits them, `--types` narrows further,
and the scope IS the graph: an entity outside it is in no list and no count,
the subject the one exception, so `--types tool "Open Brain"` is the tools
around a project); hubs and clusters inflate each other; ticket status is read
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
thoughts weighed in. `LIFECYCLE_CTE` is the one place the status comes from;
when SMD-2074 folds `thought_audit`'s transitions into a node-state
projection, that CTE reads it and nothing downstream changes.

**Startability** (SMD-2061). The lifecycle says a ticket is open, not that it
can be started. Migration 053 (SMD-1867) stores the board's relations as `link`
facets on the row holding a ticket's identity, `blocks` on the blocker and
`blocked_by` on the blocked, and `--startable` reads both directions (an edge
stated on one side only still counts). It multiplies a second factor into the
same weight: a thought whose ticket has an **open blocker** weighs 0. A blocker
is open unless its own lifecycle, resolved through `source_thought()` and read
by the ticket-head rule above, is completed or canceled, so a settled blocker is
not a blocker. A blocker the brain does not hold, or one with no lifecycle,
still blocks, and the output counts those. A row derived from a ticket takes
its ticket's blockers as it takes its status. Only an active link counts (053
closes a relation the source dropped), and only `blocks` / `blocked_by`:
`child_of` makes nobody a blocker. A thought with no link facet counts as
unblocked. The dependency caveat line gives the number of active dependency
facets, how many thoughts belong to a ticket whose relations were read, how
many weighed 0, how many blockers are unsettled only for want of a lifecycle,
and the latest link written or closed. The edges are as fresh as board-sync's
last pass. The flag composes with `--status` and `--decay-done` (the weights
multiply). Without it the dependency read is not in the SQL, so every other
mode's output is byte for byte what it was and a brain without 053 runs them.
With it, a brain without 053 is exit 2. `DEPENDENCY_CTE` (`dependencySql`) is
the seam SMD-2074's node-state projection replaces.

Exit 0 when ranked, 1 when no
entity resolves (a near-miss whose only guesses the numeric rule hid is still
no entity: exit 1, and the line counts the hidden guesses), 3 when the subject
IS an entity — by id, name, alias or merged-in name — that the numeric rule
excluded (`--keep-numeric` would rank it), 2 for a usage error, a brain
without 016 (or, under `--startable`, without 053) or a query that failed — never 1 for a failure or an exclusion. `test-schema.ts` [44] runs the
script's own SQL under PGlite over a graph whose every count is known by
construction, and its edges-on and edges-off orders differ at every position.

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
a floor, at most k — with pairs already proposed (in any state) and thoughts
already superseded left out. Older-only means a pair is reached from its newer
side once, with no memory needed; the day rule keeps an import's burst from
being compared with itself (and means a same-day contradiction is not found,
stated rather than hidden). The shared-entity restriction is the cheap signal
before the expensive one: a conflict is about a subject both name, and the
judge cost is per pair. It also means a thought with no extracted entities has
no candidates, which is why the pool is **thoughts with entities, a vector,
that nothing supersedes, and no row under the key** (`consolidation_pool()`,
one definition read by the worker, its `--status` and preflight) — extraction
first, then consolidation, made
structural rather than left to a trigger that would judge a capture before
016's worker reached it and leave a terminal claim row behind. The gate cannot
see the other side of a pair: a newer thought judged while an older neighbour
is still unextracted is judged without it, and the pair is not revisited, so
run the pass after extraction has finished rather than beside it. k and the floor were chosen by
measurement (`evals/eval-consolidate.ts`; `evals/README.md` has the table) and
are the worker's `--k` and `--min-sim`.

**The judge.** One call per pair to the judge model — `OB1_JUDGE_MODEL`, else
the metadata model, so the harder task can run on a stronger model than every
capture's tagging (SMD-1901) — and only for a pair BOTH rows of which the
egress gate lets reach the chat endpoint (SMD-1903; the more restricted row
decides for the pair, a refused pair is recorded on the claim like a timeout,
and the banner's `egress:` line says what the run will do). `server-portable/consolidate.ts` holds the prompt: thought A (older) and B
(newer), dated, and one question — agree, unrelated, or conflict, and for a
conflict which is current, decided from what the texts say and not from the
dates. A conflict whose texts do not say is recorded `conflict_undirected` for
the reviewer to direct. Only conflicts become rows; the verdict rides with its
confidence, the judge's one-sentence reason (what a reviewer reads first), the
cosine, and the pass key `consolidate:<model>@p<prompt version>` — the judge
model on the row as 021 puts the embedding model beside the vector. The
worker's agent id rides along as 016's mentions carry theirs.

**Staleness**, the same pass's second output: `stale_entities(window)` names
the entities nothing has mentioned within the window, quietest first, each
with its newest capture.
`--stale` prints it; nobody acts on it.

### `consolidate.ts`

```bash
bun consolidate.ts --url postgres://…              # the backlog, then exit
bun consolidate.ts --url … --follow [SECONDS]      # …then keep polling for newly extracted thoughts
bun consolidate.ts --url … --limit 25              # a trial: this many thoughts, then stop
bun consolidate.ts --url … --status                # the pass, and the queue
bun consolidate.ts --url … --dry-run               # what a run would do; writes nothing
bun consolidate.ts --url … --retry-failed          # failed rows back into the pool first
bun consolidate.ts --url … --list [pending|accepted|rejected|all]
bun consolidate.ts --url … --accept <id> [--direction newer|older] [--note "…"]
bun consolidate.ts --url … --reject <id> [--note "…"]
bun consolidate.ts --url … --stale [DAYS]          # entities quiet for DAYS (90)
#   --k N (3)  --min-sim F (0.6)  --min-confidence F (0.5)
#   --workers N (2)  --batch N (1)  --ttl SECONDS (900)  --heartbeat SECONDS (60, or a third of the lease; at least 1, and the lease must cover two)  --timeout SECONDS (120, per model call — this flag, as extract-entities.ts's, not OB1_LLM_TIMEOUT)
bun consolidate.ts --url … --accept <id> --force            # a thought was edited since the pair was judged
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
prints the same queue to a client. `--accept` writes the pointer on the thought
the verdict names as current (or the one `--direction` names — required for an
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

**Identity** as `extract-entities.ts`: `OB1_WORKER_KEY` a key whose hash is in
`MCP_ACCESS_KEYS`; proposals carry the resolved agent id, and an acceptance is
audited under the key's name with the pass key as session. Without it the run
says so and proceeds unattributed.

**What preflight sees.** `consolidate pass` warns while a pass under any
`consolidate:` key has rows pending, leased or failed — the counts over the
thoughts with entities, and the command that finishes it under the key's own
judge model — and otherwise says `none unfinished`, with the number of
proposals pending review beside it and the `--list` that shows them: a queue
is a reviewer's to work, not a defect.

**Verified.** `test-schema.ts` [28] holds the candidate rule's every exclusion,
the one write, the review path's states and refusals with the audit row, the
queue and staleness against PGlite; `test-live.ts` [16] runs the worker end to
end against a stub judge — the audited accept under the key's name, the reject
that clears, a cleared claim table not re-proposing a decided pair, the pool
picking up a thought extracted since. `test-store-sql`/`-postgrest` [10] cover
the tool's read on both stores; `test-preflight` the line.

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

`ingest-records.ts` reads five sources, each a record becoming one thought row
with a deterministic id and a `metadata.source` label (SMD-1806 rule 5 — an
agent-written capture is one source among several):

| source | what | needs |
| --- | --- | --- |
| `fork` | the fork's changes, one `changes/*.md` file each (SMD-1917) | in the tree |
| `commit` | git commit messages since the upstream pin (the fork's whole delta) | in the tree; `--since <ref>` to move the range start |
| `linear` | a corpus dump built by `evals/build-linear-corpus.ts` — each record's `issue`, through the Linear adapter: the row the board sync writes (SMD-1958) | `--linear <dump.json>` and `--allow linear:corpus` |
| `memory` | the `*.md` memory files (`MEMORY.md`, the index, excluded) | `--memory-dir <path>` or `OB1_MEMORY_DIR` |
| `markdown` | a Markdown / Obsidian vault, through the Markdown adapter | `--markdown <root>` or `OB1_MARKDOWN_DIR`, and `--allow <root>` |

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

**The allowlist (SMD-1813).** The two adapter sources are external content —
stored un-isolated, embedded, sent to a model provider — and are ingested only
for a **scope** the operator cleared: `--allow <scope,scope>` or
`OB1_INGEST_ALLOW`, an exact match on the scope each record names (the corpus:
`linear:corpus`; a vault: its resolved root path), never a prefix and never "the
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
adds it as one remote MCP entry:

```bash
claude mcp add --transport http open-brain-stable http://127.0.0.1:8010/mcp
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
# the same, printing ONLY what moved and exiting non-zero if anything did (the gate)
bun tier.ts --diff    --from <stable-url> --to <canary-url> [--since <iso-ts>]
# after a soak: stamp the canary's version onto stable
bun tier.ts --promote --from <canary-url> --to <stable-url>
```

**`--refresh`** takes a faithful whole-database snapshot with `pg_dump | pg_restore`
(thoughts, vectors, chunks, query_log, provenance, agents, audit — everything a
migration might touch, so a migration meets *all* the real data), resets the target
and restores into it, then runs `migrate.ts` forward with the merged tree. It is
destructive to `--to`, so it guards the target three ways.

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

It needs Bun
and a `pg_dump`/`pg_restore` whose major version is at least the source server's, and
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
before migration 045 carries a NULL arm and is skipped rather than guessed.

The three tiers run as one stack, `deploy/compose.tiers.yaml` — three Postgres
services, one shared Ollama, three servers on three loopback ports — built from the
checkout (the published stable image is SMD-1860, not yet cut). A client reaches the
working tier as a second remote MCP entry a transcript can tell from stable's:

```bash
claude mcp add --transport http open-brain-working http://127.0.0.1:8012/mcp
```

**Deferred to SMD-1805 + SMD-1860:** the *canary CI job on push to `main`* (which
runs the refresh/replay/diff against the **published** images through the merge
queue) and `--promote`'s image-repoint half. The engine, the compose stack and the
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
bun sync-linear.ts --url … --loop                    # a pass every OB1_BOARD_SYNC_INTERVAL seconds (300)
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

## Testing

Two suites cover most of it, because one of them cannot reach everything, and a
third covers the one thing the test image cannot reproduce.

```bash
bun test-schema.ts                          # 1645 assertions, PGlite, no container
./with-postgres.sh bun test-live.ts         # 703 assertions, real server, throwaway container (fewer, as one skipped group, on PostgreSQL 18 or without JIT)
./with-postgres.sh bun test-search-path.ts  # pgvector installed OFF the search_path (managed-Postgres shape)
bunx tsc --noEmit                           # every .ts here, strict, against the server's exports — no database
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
which `ci-parity.sh` needs since it shares one Postgres.

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
  (migrations 037 and 038). [5d] loads 25,000 rows at the configured width,
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
  would have built one over its 25,000 rows). `test-upgrade.ts` [17] applies 039 onto a populated 038 — no row,
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
  per block (SMD-1703's state). [5f] loads 12,000 rows with chunks and, under
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
  made while it polls, then exits 0 on the first signal.

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
