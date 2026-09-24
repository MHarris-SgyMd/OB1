# The event log is the source of truth (SMD-1997)

An architecture decision record. **Decided 2026-09-24: the fork designates
`thought_audit` the write-side source of truth for a thought, and the `thoughts`
row a projection of it — a projection that keeps the table's name, the table's
DDL surface and the table's write functions, so nothing a vendored contributor
does changes.** Both gates the ticket set were measured open before the
decision: the replay reuses every vector by the key the schema records
(SMD-1998, `evals/README.md` § "Can the read model be rebuilt without
re-embedding the world?") and the write functions can append the event first
and project the row in the same transaction with an empty contributor delta
(SMD-1999, § "Does the extension contract survive the move?"). This page is
the decision, the shape it commits to, what it declines, and the path from
053 to it in three additive steps (SMD-2115, SMD-2116, SMD-2117).

The thesis the ticket filed under is **understanding is a fold, not a
column**: what the brain believes is the projection of every event to date,
so a better model is a replay rather than a migration, and "what did the brain
hold on that date" is a query rather than archaeology. The finding that made
this an evolution rather than a rewrite: at 053 the fork had built about
two-thirds of an event-sourced system and not named it as one.

## The decision

1. **The log is the truth for the thought row.** Every capture, edit and
   deletion of a thought is one row of `thought_audit`, written before the row
   it describes; the `thoughts` row is derived from that event in the same
   transaction. From step 2 of the path there is one truth — the row is what
   its event says, checked by the trigger that used to derive the event.
2. **`thoughts` stays a table.** Not a view, not a table under another name
   behind a compat view. The community schemas run `ALTER TABLE thoughts ADD
   COLUMN`, `CREATE INDEX ON thoughts`, `REFERENCES public.thoughts(id)` and
   row-level triggers, and 053's own capture runs `INSERT … ON CONFLICT`;
   Postgres refuses every one of them on a view (measured, SMD-1999 C6). The
   guard rail in `CLAUDE.md` — never alter or drop a core `thoughts` column,
   adding is fine — stands word for word.
3. **The write functions are the projector.** `upsert_thought`,
   `update_thought` and `delete_thought` append the event and call one
   projector, `ob1_project_thought_event`, that writes the row. The audit
   trigger becomes the check under `ob1.projecting` and keeps appending for a
   raw write, so a community schema's or a backfill's write to the row is
   audited exactly as today.
4. **Read-your-writes by construction.** The projector runs inside the
   writer's transaction. There is no queue, no catch-up subscription and no
   window in which an agent reads a row its own write has not reached — the
   requirement the prior-art scan made hard (Tacnode's counterpoint: an
   eventually-consistent read model breaks an agent that writes then reads).
5. **The three verbs are a read, not a column.** Ingested, expressed and
   comprehended are determined, in that order of precedence, by columns the
   event already carries — `trust` (a ceiling the trigger enforces from the
   registry's kind; a payload can lower it to `ingested`, never raise it),
   `origin` (the door — the in-tree writer's own name, not the payload's) and
   `action`; `stance` describes how a thing was asserted and decides nothing.
   A verb column would be a second declaration beside the columns that
   determine it, free to disagree with them and one more thing a payload
   could claim. The mapping is below.
6. **Everything derived is a projection with a recorded key, and the
   expensive ones are snapshotted.** The vector by `(content_fingerprint,
   embedding_model)` in a snapshot table the replay reads; the graph, the
   chunks, the proposals, the facets and the capture-time metadata by the
   lineage rows SMD-1731 specifies. Nothing derived is authoritative; anything
   derived can be rebuilt; the rebuild is incremental by its key, never total.
7. **Two clocks.** Transaction time is the event's `created_at` and `seq`
   (050); valid time is its `valid_from` / `valid_until` (046). The as-of read
   over transaction time is the replay with a bound; the as-of read over valid
   time is a filter on the window (SMD-2011, SMD-1725). A contradiction closes
   a window; it does not delete.
8. **Deletion is real and forgetting is an amendment.** `delete_thought`
   removes the row (a tombstone event, the row gone); forgetting a thought's
   content from the log is the second named amendment of the append-only
   table (SMD-1723), by `thought_id` over every row that holds the text.

## What the schema already held at 053

The evidence the ticket collected, checked against the migrations:

- `thought_audit` (008) is append-only by trigger, written inside the mutating
  transaction, and since 046 (SMD-1730) carries who holds the key
  (`actor_kind`), the ceiling on the content (`trust`), the door (`origin`),
  what the write declared (`stance`, `cites`, `valid_from`, `valid_until`) and
  the claim it filed (`actor_context.claimed`) — "the log of record", in that
  migration's own title. 050 (SMD-1726) gave it an order (`seq`) and put the
  writer on the row.
- Every derived tier is already treated as disposable: re-extract (016,
  SMD-1879), re-embed (021, SMD-1021), re-label (SMD-1951), consolidate (029,
  proposes and never applies), the calibration ledger built as a read model
  (SMD-1809). Projection discipline, done one tier at a time.
- The snapshot key for the most expensive-looking projection exists on the
  row: `content_fingerprint` (003, 023) and `embedding_model` (021, SMD-1068).
- A change feed exists (`thought_changes`, 052); supersession and derivation
  (025) are replacement and lineage events already in the diff.
- SMD-1729, the claim-log program, is event sourcing under another name — its
  Phase 1 (1730 the event shape, 1731 lineage, 1732 the rebuild primitive) is
  this decision's substrate, and this record adds the three steps that make
  the thought row itself a projection (1d, 1e, 1f in that phase).

## What the two gates measured

**Gate 1 — can the read model be rebuilt without re-embedding the world?**
(SMD-1998, PR #142.) On the dogfood brain as found, 440 thoughts and 1.83 M
characters: a projection rebuild reuses **440 of 440** vectors by the recorded
key; 10 edits recompute exactly 10; a comprehension-only change recomputes 0;
the fresh vector equals the cached one to within 2.2e-16 on the 21 sampled
rows and 1.1e-16 on the 7 window vectors; the worst case, a model bump,
re-embeds the whole brain in minutes on host Ollama — 8.4 by rows, 5.0 over
the rows between the extremes, 7.6 by characters. The premise inverted: a full
re-extract of the graph costs about 4.5 hours one row after another (the 7B
extractor, median 36.9 s a thought; 5.1 hours under the 27B), thirty-two times
the re-embed — an order of magnitude rather than a digit, since the claim log
recorded those seconds under two workers while the embed sample ran alone.
The comprehension projections are the expensive ones, and their keys are the
weakest (the graph records an `extraction_key` and no fingerprint; the
capture-time metadata records nothing; the chunk rows record no recipe). And
the log was not yet the payload store: a capture row carried `metadata`, not
`content`, so the log alone held the text of 217 of 440 live thoughts.

**Gate 2 — does the extension contract survive the move?** (SMD-1999, PR
#150.) Two shapes prototyped across four schemas on a throwaway Postgres at 053
against one scripted set of writes, the criteria and the bar posted before the
run; the third reasoned from the first's measured surface.
**Option 2** — the functions append then project, the trigger checks — is GO:
every write returns what 046 returns; the log and the rows equal 053's on
every caller-visible column outside three additions to the event; the lock
orders of 033, 032 and 036 hold with the same locks in the same order; one
audit row and one claim per logical write; a capture is visible to a `SELECT`
and to the keyword search in the same session; the whole log replays into
rows equal to their copy on every column, the vector from the snapshot
included, bar four raw rows' NULL keys, which the projector fills. **Option 1** — a view named `thoughts` over a renamed table with
`INSTEAD OF` triggers — is NO-GO twice: 053's functions fail every capture
(`ON CONFLICT` has no constraint to name on a view), and with option 2's
bodies behind it the community surface fails whole (`ADD COLUMN`, `CREATE
INDEX`, `REFERENCES`, a row trigger, and `xmax`, which `db/ingest-records.ts`
reads). Row locks work through a simple view; the DDL surface is the
obstacle. Option 3 (a projection table beside a compat view) shares that
surface. The cost is the round trip: medians between 0.5 and 1.9 ms in a
laptop container, the ratio between ×0.65 and ×1.8 across fourteen timed runs
plus one edit run at ×3 under load — the noise exceeds the effect.

## The event

One row of `thought_audit` per write to one thought. The columns, and where
each came from:

| Column | Meaning | Since |
| --- | --- | --- |
| `thought_id`, `action` | the aggregate and the verb on it: `capture`, `update`, `delete` | 008 |
| `diff` | capture: the creating metadata — and, from step 1, the **content** and a backdating writer's **`created_at`**; update: before/after of what changed — and, from step 1, the **key's move**; delete: the previous content and metadata in full | 008, 025, SMD-2115 |
| `actor_name`, `canonical_agent_id`, `author_session_id` | who, as the key's name, the registry's id, the session | 008, 010 |
| `actor_kind`, `trust` | who holds the key (`operator`, `agent`, `ingested`) and the ceiling on the content, the same three words, never above the kind; a raise is clamped and filed in `actor_context.claimed` | 046 |
| `origin` | the door — the server, integration or worker the write came through | 046 (SMD-1541's `via`, promoted) |
| `stance`, `cites`, `valid_from`, `valid_until` | what the write declared: `stated`, `retrieved` or `inferred`; the thoughts it rests on; when the fact was true in the world | 046 |
| `source` | the row's own `metadata.source`, one vocabulary | 008, narrowed by 046 |
| `created_at`, `seq` | when the system learned it (one value per transaction) and the order it was written in | 008, 050 |
| `backfilled_at` | the one amendment the immutability gate allows, stamped | 046 |

Three things were added to that shape by the decision and nothing else,
because the differential in SMD-1999 held every other column equal: the
content on a capture (gate 1's finding); the row's `created_at` on a capture
when the writer set one — the ingester backdates a record to its own time, and
without it every ingested record replays at the write's clock; and the key's
before/after on an update — 018 sets `content_fingerprint` NULL for a text
another row already holds, a decision a replay cannot re-derive from the
content. The log grows by the corpus: 1.83 M characters of text beside a
4.3 MB audit table (table and TOAST) on the dogfood brain at gate 1's census. 046 chose the partition key (`RANGE` on
`created_at` by month) and did not apply it; SMD-1947 benches the log at a
million rows.

### The three verbs, as a read

| Verb | What it is | Read as |
| --- | --- | --- |
| **Ingested** | an external observation handed in through an adapter (SMD-1867's contract; `db/ingest-records.ts`) — source-faithful, with its observed-at and its trust | first in precedence: `trust = 'ingested'` (an operator's key handing in a page is `actor_kind = 'operator'`, `trust = 'ingested'` — the case that settled two columns in 046) |
| **Comprehended, on the row** | the brain's own cognition landing on the thought row: a supersession or derivation pointer (025, 029's accept), a kind label (SMD-1951); a re-embed's vector flip is one until step 2 and a projection refresh with no event after it | second: `action = 'update'` from a worker's door — `origin` names it and the sub-type is the door. Today each writer passes its own string (`consolidate`, `db/reembed.ts`, `ingest-records`, the servers' names) and the labelling pass left none: a normalised door vocabulary is a gap this read needs closed (below, "Not decided here") |
| **Expressed** | a direct capture or edit by a person or an agent: "I assert this" | otherwise: `action in ('capture', 'update')` from a server's door, `trust in ('operator', 'agent')`; the `stance`, when declared, says how it was asserted (`stated`, `retrieved`, `inferred`) and moves the verb not at all |
| **Comprehended, off the row** | extraction (entities, edges), chunking, proposals, calibration | not rows of this log — projections with their own lineage row (SMD-1731's `derivations`: inputs, recipe, `artifact_kind`), rebuilt by `rebuild_derived` (SMD-1732; neither built yet) |

Why the fourth row is not in `thought_audit`: the log is the log of one
aggregate, the thought. An extraction reads a thought and writes entities and
edges; it is a derivation with inputs and a recipe, and gate 1 measured it as
the projection whose rebuild is dearest and whose key is weakest — what it
needs is the lineage row that names its input's fingerprint and its recipe,
so that a rebuild is a walk from the changed input, not a fold of a second
log. `thought_sources` (053) is the ingested payload itself with its
`canonical_hash` beside it — the shape every projection's key should copy.

## The write path

At 053 the row is written first and the trigger derives the event from
`OLD` and `NEW` afterwards: the log describes, it does not decide. From step 2:

1. The function takes the locks it takes today, in the order it takes them —
   033's advisory lock on the fingerprint, 032's row lock, 036's supersession
   lock first on a delete.
2. It computes the event (`ob1_thought_diff`, 046's diff rule as a function)
   and appends it (`ob1_append_thought_event`, 046's trigger tail: the kind
   from the registry by the envelope's agent id or the key's name, the trust
   ceiling, the door, the claim filed, 046's late gate).
3. It calls `ob1_project_thought_event(event, vector, model, replay := false)`,
   which writes the row: capture → INSERT with the event's `created_at` when
   it carries one and the event row's own otherwise (never the clock of a
   replay), update → UPDATE by the event's afters, delete → DELETE. The
   projector announces itself in three settings — `ob1.projecting` (the
   event's id), `ob1.projecting_thought` (the row it writes),
   `ob1.projecting_replay` — runs 050's stamp under the amendment setting,
   clears `ob1.event` (046's rule against a raw write in the same transaction
   inheriting an earlier call's stance), and before it returns clears the
   three and restores `ob1.actor_amend` and `ob1.cited_delete` to what they
   were: a raw write later in the same transaction meets the appending arm,
   not the check.
4. The audit trigger fires as today and, seeing `ob1.projecting`, **checks**
   instead of appending: the row must be the event's AFTER image (a subset
   rule for the key, a live-only rule for the vector's presence) and must not
   have moved a column the event does not name; a mismatch is SQLSTATE
   `OB002` and the transaction fails. Outside `ob1.projecting` the trigger
   appends as 046 does — a raw write is audited, never refused.

**A projected write cascades, and the check has a rule for it.** A
tombstone's `ON DELETE SET NULL` (025) moves every successor's pointer and
042's guard bumps a citing thought's stamp, all under the delete's
projection. The rule that measured right: a bump (an empty diff) is nothing;
a successor's nulled pointer is appended as its own update event live (as 046
does today) and skipped on a replay, since the log already holds that event
and will replay it; anything else refuses. The check compares the event's
AFTER image rather than its before/after pair, so a cascade that pre-applied
part of a later event still verifies.

**A vector onto a row that has one is a projection refresh, not an event.**
`ob1_refresh_thought_vector` writes the vector and its label under
`ob1.projecting = 'vector'`, appends nothing and leaves `updated_at` alone —
its stamp is the snapshot's `taken_at`. Today's re-embed goes through
`update_thought`, bumps `updated_at`, and so reads as a change to a caller
holding an `if_unchanged_since`; the decision treats that as the defect. The
snapshot is fed by a trigger on the row store that records live writes only:
under `ob1.projecting_replay` it does nothing, so a fold never moves a
`taken_at`; a raw writer's vector enters it like any other, since the row
store is what the snapshot trusts today. A fold into another schema reads
the source brain's snapshot — the snapshot travels with the log, and a dump
of the log without it is a dump that re-embeds.

**"No event, no write" — the deltas against 053, accepted.** SMD-1999's
record named four and its bodies a fifth; the decision takes all five: an
identical re-capture no longer bumps `updated_at` (053's `ON CONFLICT DO
UPDATE` does — a write that changes nothing is not a write; `thought_changes`
and `if_unchanged_since` read the log and the row's stamp, and neither should
move); an edit whose patch changes nothing writes nothing — no row, no bump —
where 053 bumps `updated_at` and records no audit row; a vector refresh
leaves `updated_at` alone (above); `update_thought`'s stale-read refusal
stands and its second check in the UPDATE's own WHERE, unreachable under the
row lock taken first by 046's own argument, goes; the 2-argument
`upsert_thought` takes the row lock the other forms take, under the same
advisory lock.

**The log is faithful, not corrective.** A raw content edit that leaves 018's
key stale replays with the key still stale and the stale vector kept; a key
the event does not move stays, a vector the event does not flip stays unless
the snapshot holds one for the new text. The one thing a replay fills is a
raw insert's NULL key — 003's rule lives in the functions, and a raw insert
never had it. A replayed tombstone never refuses (042's guard runs in detach
mode; the citations are a projection rebuilt apart). A projector that
corrected the log on the way would make the row disagree with its event and
the check would refuse it; that is the point of the check.

## Projections, their keys, their rebuild

| Projection | Table | Key it records at 053 | Rebuild | What the decision requires |
| --- | --- | --- | --- | --- |
| the thought row | `thoughts` | `id` — it is the aggregate | the fold: replay the log through the projector (SMD-2117) | steps 1–3 |
| the vector | `thoughts.embedding`, `embedding_model` | `(content_fingerprint, embedding_model)` — recorded; the prompt template and the requested width ride on the model name by convention (`embed.ts`'s `EMBEDDING_PROMPTS`; `KNOWN_MODEL_DIMS` for the width) — code, not data, so a template change under one name invalidates every vector with the key unmoved, and gate 1's cosine bar is the check for that | from the snapshot by key; the provider only on a miss | `ob1_embedding_snapshot (content_fingerprint, embedding_model) → embedding, taken_at` as the prototype has it, fed by a trigger on the row store, plus the width on the row (SMD-2116); the recipe on the lineage row (SMD-1731) |
| the chunk rows | `thought_chunks` | the parent's label vouches (022); no recipe of their own | re-chunk, re-embed the windows | the recipe (tokens, overlap, context, blurb model) on a lineage row (SMD-1731) |
| the graph | `thought_entities`, `ob1_entities`, `ob1_entity_edges` | `extraction_key` — half a key: no fingerprint of the input | re-extract from the surviving input — the dearest projection (hours, not minutes) | the input's fingerprint beside the key (SMD-1731); a "done" keyed by the payload's fingerprint, not by the pass (gate 1's staleness pattern) |
| capture-time metadata | `thoughts.metadata` (`type`, `topics`, `people`) | none — no model, no prompt version | re-run the extractor | a lineage row from the fifth producer (SMD-1731, SMD-1254) |
| supersession proposals | `supersession_proposals` | `older_fingerprint`, `newer_fingerprint`, `judge_key` — recorded | re-judge on a key change | none; the shape to copy |
| the facets | `thought_facets` | derived from `thought_sources.canonical` (053), whose `canonical_hash` is beside it | re-derive from the canonical | none; the shape to copy |
| the change feed | `thought_changes` (052) | a read over the log | none — it is the log | reads a capture's head from the event (SMD-2117) |
| `node_state` | SMD-2074, not built | — | a fold of status transitions from the log and the link facets | the first read-model fold to build on this log |

The rule the table applies: a projection's key names everything its value is
a function of — the input's fingerprint and the recipe — or the rebuild
cannot be incremental. The vector is the worked example that already holds;
the graph is where the discipline pays first (gate 1: thirty-two times the
cost, an order of magnitude rather than a digit; half the key). `node_state`
is the first fold to build because it is small, its want already measured
(SMD-1994: 11 of 16 High-priority OB1 issues — 69% — Done or closed and ranked
identically to live work; 136 of 330 — 41% — Done across the whole board) and it reads status
from the scalar the log replaces
(`metadata.status_type` is the lossy overwrite; the transitions are in
`thought_audit` since 046).

## Time

Two clocks, both on the event. **Transaction time** — when the brain learned
it — is `created_at` (one value for every row a transaction writes) with
`seq` as the tiebreak (050). **Valid time** — when it was true in the world —
is `valid_from` / `valid_until` (046), declared by the write, nullable and
honest about it. Zep/Graphiti's four timestamps are these two pairs.

The **as-of read over transaction time** is the replay with a bound: fold the
log in `(created_at, seq)` order to the last event at or before the time
asked and the rows are the brain as it stood — the same code as the rebuild,
`db/replay.ts --as-of` (SMD-2117), into a working tier or a named schema,
never over the live rows. The bound is the pair and `created_at` comes first:
`seq` alone is exact only for rows written after 050 (the rows before took
theirs in heap order at the ALTER, which 046's backfill and VACUUM had
reordered), as 050's own comment says. The **as-of
read over valid time** is a filter on the window, on the row or the facet,
which SMD-2011 wires: a supersession closes the older thought's `valid_until`
at the newer one's observed-at instead of flagging it, the default read is
valid-now, `valid_at` returns the state believed true at a time, and a fact
with no known end has an open window. The two answer different questions and
both are answerable because both axes are stored; a read that hides rows by
either clock says how many it hid (SMD-1725).

## Deletion and forgetting

**Deletion stays real.** `delete_thought` removes the row; the event is a
tombstone carrying the previous content and metadata in full (008), so the
row is recoverable from the log alone and the delete is survivable. Poisoning
defence (SMD-1724) and privacy both need true forgetting, which an
append-only log fights, so the decision names how it is done rather than
leaving the log to fight it:

- **Forgetting is an amendment, not a deletion of log rows.** 046's
  immutability gate allows one named amendment (the kind-fill, stamping
  `backfilled_at`); SMD-1723's redaction is the second: under its own setting
  it blanks the payload — content, the before/after text, the previous
  content on the tombstone — on **every** row of the log for that
  `thought_id`, and writes a row saying it did. With content in the capture
  row from step 1, a thought's text lives in its capture, in every content
  update's before/after and in its tombstone; the redaction is by thought, not
  by row.
- **A redacted thought projects to nothing.** The projector refuses a capture
  event with no content (SQLSTATE `OB003`), so a redaction that blanked the
  text would otherwise stop every fold at that thought. The rule: the
  redaction's saying-so row is a tombstone for the fold — the projector skips
  every event of a redacted `thought_id` and the fold reports the count. A
  redacted thought has no row, as a deleted one has none.
- **Forgetting exists before the log is the truth.** The log holds text today
  in every content-moving update's before/after and every tombstone (217 of
  440 live thoughts at gate 1's census) with no path to remove it; step 1
  makes that every thought. So SMD-1723's redaction lands no later than
  step 2 — SMD-2116 is blocked by it — and step 1's row in the path says the
  text is unremovable until it does.
- **Forgetting reaches the projections through the rebuild.** After the
  amendment, `rebuild_derived` (SMD-1732) walks the lineage forward and
  re-derives or deletes every descendant — chunks, entities, proposals, the
  snapshot row for that fingerprint — and reports what it could not reproduce.
- **Declined: cryptographic shredding** (a key per thought, forgetting by
  discarding the key). A single-operator brain on one Postgres with an
  amendment gate the trigger enforces does not need it, and a key store is a
  second thing to lose. Revisit if the log is ever shipped beyond the
  operator's own database.

## Consistency

**Atomic at the boundary, eventual off the row, convergent by rebuild** —
SMD-1729's rule, made concrete:

- The event and its row commit together, in the writer's transaction, under
  the writer's locks. Read-your-writes holds for every function-borne write;
  a raw write is audited in the same transaction as today.
- The off-row projections lag by seconds or hours behind their leased
  workers (015, 031) and say so where they are read; `rebuild_derived` is
  what makes the lag safe.
- **The projector is idempotent by the check, and exactly-once is not
  needed.** Replaying an event already applied recomputes the same AFTER
  image; the check verifies and nothing moves. A fold from a bound resumes
  without re-folding. This is what "The Idempotency Crisis" asks of an
  event-stream consumer, answered by the comparison the trigger already makes
  rather than by a dedupe table; SMD-2117 probes it.
- **Multi-agent conflict is preserved, not resolved, at the write path.** Two
  agents editing one thought serialise on the row lock; both events are in
  the log in `seq` order; the later one wins the row, and an edit carrying
  `if_unchanged_since` against a stamp that moved is refused as a value. What
  the row *should* show when two writes disagree is a consolidation question
  (SMD-1294, SMD-2011), answered by a supersession event that closes a
  window, not by the projector.

## The path

Three steps, each additive, each its own migration and ticket, each landing
on a brain at 053 or later without a window. "Dual-write" — the word the
ticket used — is a misnomer the record retires: from step 2 there is one
truth; the period it names is the one in which the raw in-tree writers still
write the row first and are trigger-audited, not one in which two sources
exist.

| Step | Ticket | What lands | What coexists | Rollback |
| --- | --- | --- | --- | --- |
| 1 | SMD-2115 | the capture event carries `content` and, when set by the writer, `created_at`; the update event carries the key's move; 046's diff rule, its append and 050's stamp become functions the trigger calls; a backfill fills the payload on earlier capture rows — the third named amendment, which needs a third arm in 046's immutability gate (today an UPDATE of `diff` is refused even under the setting, and test-schema asserts so; the arm fills `diff.content` and `diff.created_at` where absent and nothing else, and the assertion moves) — or the replay seeds from the row store, decided there after the pass is measured | everything: the trigger still derives the event after the write; no function changes what it returns | none needed for the shape — readers of 046's shape ignore the added keys; the text written into the log is not removable until SMD-1723's redaction exists, which is why that lands no later than step 2 |
| 2 | SMD-2116 | the three write functions append then project; the trigger checks under `ob1.projecting` and appends otherwise; the vector snapshot table (live writes only) and `ob1_refresh_thought_vector`; the five accepted deltas; blocked by SMD-1723's redaction as well as by step 1 | the raw in-tree writers (`review_supersession_proposal`, the backfills, 042's guard) and every community schema's raw write — trigger-audited, so the log stays complete | re-apply 046's bodies (`db/migrate.ts --reapply`, SMD-1193); the log written in between is complete and shaped as before |
| 3 | SMD-2117 | `db/replay.ts` — the fold in `(created_at, seq)` order, bounded, into a tier or a named schema, with a verify mode; defined over the events written since step 1 until step 1's backfill has run on the brain (a fold that meets a capture with no content stops and names it, so the backfill is the gate on rebuilding a brain older than step 1); the raw in-tree writers append their own event first; `thought_changes` reads a capture's head from the event | a community schema's raw write, still trigger-audited: the contract is unchanged | none needed — a tool and moved callers |

What does not change on any step, and is the contract this record holds:

- **For a vendored or community writer: the surface.** `thoughts` is a
  table; `upsert_thought`, `update_thought` and `delete_thought` keep their
  signatures and their returns; a raw `INSERT`, `UPDATE` or `DELETE` on the
  row is audited as it is today; `ADD COLUMN`, `CREATE INDEX`, `REFERENCES`
  and a row trigger keep working because a table is what they are run
  against. The contributor delta SMD-1999 measured — signatures, returns,
  DDL, the raw write audited — is empty and the decision keeps it so. What
  does move, for every caller, is the stamp: an identical re-capture, a no-op
  edit and a vector refresh no longer bump `updated_at` (the accepted deltas
  above), so a caller reading the stamp as "something happened" reads less
  than today, and more truly.
- **For the guard rail:** unchanged. The one sentence added to `CLAUDE.md`
  points here.
- **For the pins:** preflight's recognisers and test-schema's sentinel reads
  name the current bodies and move with them at each step, as they did at
  032, 033, 035 and 046.

After step 3 the projector is the row's only in-tree writer, the row store is
disposable, and a tier refresh (SMD-1806) can be a fold. Then the reads the
program wants become folds too: `node_state` (SMD-2074) first, the belief
state (SMD-1735) after it, and a fork of the brain at a point in time is the
bounded fold into a tier that writes on (SMD-2118, Low, blocked by step 3).

## Declined

- **A view named `thoughts` with `INSTEAD OF` triggers** (option 1) and **a
  projection table beside a compat view** (option 3): the DDL surface the
  community schemas use refuses a view, measured on every clause; three
  schema files run `ADD COLUMN`, two run `CREATE INDEX`, six `REFERENCES`
  stand in four, one row trigger. Recorded so the view is not re-proposed on
  the ground that row locks work through it — they do, and it was never the
  obstacle.
- **Pure event sourcing** — no snapshots, every projection rebuilt from the
  log from zero. Gate 1 measured the graph's rebuild at hours; a snapshot
  keyed by provenance makes every rebuild O(changed rows).
- **An external event bus or an asynchronous projector.** Postgres-only
  (SMD-1795); read-your-writes (decision 4). The event store is one table,
  the projector one function, the snapshot one table, all in-repo.
- **A second log for comprehension events.** The off-row derivations are
  projections with lineage rows (SMD-1731), not events of the thought; one
  aggregate, one log.
- **Dual-write in application code** — every server and worker appending
  its own event. Seven servers, the workers and the vendored surface all
  reach the row through three SQL functions; the functions are the one door,
  and the door is where the event is written.
- **A verb column on the event.** 046's rule: derived from the key and the
  call, never declared by the payload. The verb is a read over what the row
  already carries.
- **Making the ADR itself a checked artifact.** Its claims are the two
  README sections' measured results and the migrations' bodies, each held
  by its own suite and CI step; a second copy of those numbers here would be
  one more thing to hold stale.

## Not decided here

- **The log's partitioning.** 046 chose `RANGE` on `created_at` by month and
  did not apply it; SMD-1947 benches the census and the backfill at a million
  rows and decides.
- **The redaction amendment's exact shape** (which keys of `diff` blank, what
  the saying-so row carries) — SMD-1723, on the gate 046 built; what the
  projector does with a redacted thought is decided above.
- **The graph's fingerprint and every recipe** — SMD-1731, whose table the
  projections table above depends on.
- **Where a pre-step capture's text comes from on a replay** — the backfill
  or the row store; SMD-2115 measures the backfill on the dogfood log before
  choosing, and leans to the backfill. Until it lands the fold is defined
  over the events written since step 1 (the path, step 3).
- **The door vocabulary, and a helper that reads the verb.** `origin` holds
  whatever string each writer passes as `via` (`consolidate`, `db/reembed.ts`,
  `ingest-records`, a server's name); reading the comprehended sub-type off
  it wants a registry or a convention the writers hold, and the labelling
  pass has to pass one at all. Filed with `ob1_event_verb(row)` when a reader
  needs the verb, not before.
- **Benchmarking against Zep's DMR or a temporal-memory suite** — stays under
  the eval program (SMD-1039).

## Held by

Nothing in this page is enforced by this page. What holds the decision:

- the two gates' runners in CI — "Projection-replay rules" and
  "Writable-projection rules" in the portable-server job (the pure rules,
  self-checked), "Projection-replay fixture" and "Writable-projection
  prototype" in the data-layer job (gate 1's rules on a seeded Postgres; the
  prototype applied to a real Postgres at 053, held to a recorded matrix of
  outcomes and probe counts; drift fails) — until SMD-2116 ships the bodies
  and their criteria move into test-schema and test-update-delete;
- test-schema's sentinel reads and preflight's recognisers, which pin the
  write functions' bodies and move with them at every step;
- the SQL-safety rule (`scripts/check-fork-consistency.ts` check 21): no
  `.sql` in the tree destroys a row a brain holds, the log's own
  `BEFORE TRUNCATE` refusal included;
- the version rules: each step is a fragment with its migration, MINOR, cut
  at the next release.

## Prior art

The pattern is converging, not novel; the fork's contribution is this
pattern on one Postgres, vector-first, dogfooded against its own board.
**Zep / Graphiti** (arxiv 2501.13956) is the reference for the temporal
model: four timestamps in two pairs, a contradiction closing a window rather
than deleting, edges with validity intervals and episode provenance — the
shape SMD-2011 and SMD-1738's phase 2 take. **"The Log is the Agent"** (arxiv
2605.21997), **PROJECTMEM** (2606.12329) and **ESAA-Conversational**
(2606.23752) share the thesis — the append-only log as truth, the working
state a deterministic projection — and claim the replay, fork and lineage
payoffs this record schedules. **Tacnode, "CQRS for AI Agents"** is the
counterpoint that made decision 4 hard: an agent is its own read-side
consumer, so the projector is synchronous. **StateFuse** (2607.05844) on
conflict-preserving multi-agent writes is answered here by the log keeping
every write and consolidation deciding the row.

## Related

- `evals/README.md` § "Can the read model be rebuilt without re-embedding
  the world?" (SMD-1998) and § "Does the extension contract survive the
  move?" (SMD-1999) — the two gates, their reports verbatim
- `evals/writable-projection/` — the prototype SQL SMD-2116 ships from
- `db/migrations/046_thought_audit_event_shape.sql`,
  `050_thought_actor_on_the_row.sql`, `052_thought_changes.sql` — the log as
  it stands
- `db/README.md` — "Migration 046 makes `thought_audit` the log of record"
- `docs/safe-agent-memory-provenance.md` — the provenance vocabulary the
  event's `stance` and `trust` carry
- SMD-1729 — the claim-log program this record is the explicit form of;
  SMD-2115, SMD-2116, SMD-2117 — the path; SMD-2118 — the fork; SMD-2011,
  SMD-1725 — valid time; SMD-1723 — forgetting; SMD-1731, SMD-1732 — lineage
  and the rebuild primitive; SMD-2074 — the first fold
