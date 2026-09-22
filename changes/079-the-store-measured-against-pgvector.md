# 79. The store measured against pgvector, and the second store not built — filtered recall is an in-engine question migration 014 already answers (SMD-1037)

The un-numbered section above, "A second vector store beside Postgres"
(SMD-1038), wrote down before any number existed the shape a second vector store
would take beside Postgres and the bar its numbers would have to clear: a recall
gap at a used filter tier, a latency gap at a reachable row count, or an index
build time that turns a re-embed into a maintenance window. SMD-1037 is that
measurement. It scores pgvector HNSW against pgvectorscale's DiskANN and
pgvector IVFFlat in the same Postgres, and against Qdrant in its own container,
on the fork's own corpus and on synthetic corpora to 10M rows — every store
against one exact-cosine ground truth over the same vectors, the comparators
wired into an eval (`evals/store-compare.ts`, `store-scale.ts`,
`store-backends.ts`) and never into the product. Like changes 31, 53, 55 and 59,
it ships no runtime change; the numbers are in evals/README.md, "Does the store
matter?".

**Unfiltered, the store does not matter.** On the real corpus pgvector HNSW
returns the exact top-10 for the unfiltered query — the case every vendor
benchmark reports — and so does every comparator. The pre-registered anti-bar
named an unfiltered-only win as no reason to move; there is not even a win to
argue.

**Filtered, a bare index loses recall — and that is the migration-014 question,
not a store question.** As the filter tightens, pgvector HNSW's default scan
returns a shrinking share of the exact top-10 (10% at a 3.5%-selective label),
because it picks its candidates before the filter and a rare label survives in
few of them — the SMD-968 hazard. Qdrant, filtering inside its graph, holds
100%; DiskANN, filtering its stream and rescoring, holds strongly and recovers
to near-exact. But the product does not run a bare index: `match_thoughts`
pushes the filter into the scan (migration 014), pgvector's own in-engine answer
to this exact loss, and DiskANN is a second in-engine rung. The recall dimension
of the bar is real and is met inside the engine; a second store matches the
in-engine rungs, it does not beat them.

**Latency and build cost at scale.** At a million synthetic rows (64-dim, where
random vectors defeat every index's recall, so these are build, size and latency
— not realistic recall): HNSW builds in 160s to a 570 MB index, IVFFlat in 12s,
and DiskANN — the best small-corpus filtered recall — in 8,165s, two hours and
sixteen minutes, with a filtered query latency of 520ms at a million rows.
Qdrant's read is its ANN search plus a Postgres resolve of the ids it returns:
9.3ms end-to-end at p95, larger than single-store pgvector HNSW's 4.1ms
unfiltered. At the product's real 1024 width the build costs are an order larger
— HNSW 35 minutes to an 8 GB index, and DiskANN's build exhausted the 14 GB test
machine outright. At ten million the pattern only sharpens: DiskANN did not
build inside a ten-minute bound (it needed 136 minutes at one million), HNSW's
own build took 139 minutes, and Qdrant's index no longer fit the test machine's
memory — in RAM it crashed search, on-disk it answered at seconds per query.

**Verdict.** None of the three triggers clears in favour of a second store
within reach. Filtered recall — the one real gap — is answered inside the engine
by migration 014 (and by DiskANN, at a build cost that rules DiskANN out at
scale); the external store matches that, it does not beat it. Latency does not
gap toward the external store — its id→row resolve makes the two-store read
slower than the single store, not faster. Build time is a real cost, but it
argues against DiskANN, not for Qdrant. The second store is not built. The
`thoughts.embedding` column stays the source of truth (SMD-1038's guardrail).
Two threads left open, each worth its own ticket if taken: a bounded evaluation
— not adoption — of DiskANN's SBQ compression, which gave the smallest index and
strong small-corpus filtered recall; and an upstream note that pgvectorscale's
parallel DiskANN build crashed the Postgres backend at a million rows (a serial
build completed).

## A second vector store beside Postgres: the shape, and the bar it would have to clear

*Written for SMD-1038 beside change 19, before change 79 measured it; moved here at the split (SMD-1917) as the shape that measurement was held to.*

Every retrieval change since the pin has been made inside Postgres — the filter
pushed into the scan (SMD-968, migration 014), the keyword arm (migration 012),
contextual chunks (migration 007), hybrid ranking (SMD-958, migration 017),
GraphRAG measured and declined (change 31). The single transactional store was
argued for and never weighed against the alternative it rules out: a dedicated
vector database — Qdrant, Weaviate, LanceDB, or pgvectorscale's DiskANN inside
this same Postgres — holding the vectors while Postgres keeps the rows. Change
11's "swappable data layer" swaps *how* the server reaches Postgres (SQL or
PostgREST); it does not swap *what* holds the vectors. This section writes that
alternative down.

It is written **before** SMD-1037's numbers exist, on purpose. SMD-1037 measures
pgvector against a dedicated store and a different in-engine index on this
corpus; SMD-1038 (this section) fixes, in advance, the shape a second store would
take here and the bar its numbers would have to clear — so the decision is made
against a design and a pre-registered threshold rather than under the pull of one
benchmark. It is not "not built" — that verdict is SMD-1037's to reach; it is the
contract SMD-1037's result is read against.

**The seam is `ThoughtStore` (`server-portable/store.ts`), and only some of it
moves.** A second store would own the vector-search reads and the vector writes,
nothing else:

- **Moves:** `matchThoughts` (the top-k vector scan, including the metadata
  filter migration 014 pushed *into* the scan), the vector arm of
  `hybridThoughts` (migration 017), and the vector writes inside
  `captureThought`, `updateThought` and `deleteThought` — the `embedding` on
  the row and the per-window vectors in `thought_chunks` (migration 007).
  Moving the vector arm out also moves 017's fusion out of SQL: what is one
  statement over one snapshot today becomes an external vector query merged
  with the Postgres keyword arm in application code.
- **Stays in Postgres:** `keywordThoughts` (a match over `thoughts.content`,
  migration 012), `getThought` / `listThoughts` / `countThoughts` /
  `statsSummary` / `pageThoughtMeta`, `resolveAgent` and the work-claim tables
  (SMD-946), `traceProvenance` / `findDerivatives` / `supersededAmong` /
  `listSupersessionProposals` (migrations 025/029), `logSearch` / `logActions`
  (the query log, SMD-1295, migration 034; the one writer of action rows since
  change 90), and every non-vector table:
  `thought_audit`, `thought_work_claims`, the entity tables, `ob1_config`.

The split is the point: the store holds one column of one table plus the
vectors of one child table, and everything that makes a thought *usable* — its
text, its history, its provenance, its ACL, its filters — stays in the engine
that already serves them in one snapshot.

**Consistency — every case, with a handling or an owned gap.** Today a capture is
one transaction: `upsert_thought` writes the row and replaces its chunks
together (SMD-1175, migration 022), so a reader never sees a thought
without its vector or a vector without its thought. Split across two stores,
one write lands first.

- *Capture atomicity.* Postgres is the source of truth and commits first; the
  vector write follows and is retried to completion (an outbox row in the same
  Postgres transaction, drained by a worker in per-thought order — or carrying
  the row's version so a stale write loses to a newer one — is the standard
  shape). Between the two, a reader can fetch the thought by id and
  keyword-match it, but the vector search cannot yet return it. Accepted gap:
  vector visibility lags row visibility by the drain interval; the row is
  never orphaned because the outbox row shares its transaction. The reverse
  orphan — a vector for a row that rolled back — cannot occur, because the
  vector write is keyed off a committed outbox row.
- *`updateThought` / `deleteThought`.* A content edit re-embeds and must
  overwrite the external vector; a delete must remove it. In Postgres today
  the chunk vectors are `ON DELETE CASCADE` (migration 007) — a foreign key
  does this for free. A second store has no such key: the delete becomes a
  second, non-transactional call, and a crash between them leaves a vector
  whose row is gone (a search hit that resolves to nothing). Handling: the
  same outbox drains deletes and re-embeds; and because content is always read
  from Postgres — in the two-store shape the vector store returns ids and
  Postgres resolves the rows — a stale vector id resolves to no row and drops
  the hit rather than returning wrong content. The one way a vector outlives
  its row for good is a delete overtaken by a lagging re-embed of the same id
  — which is exactly what the per-thought ordering above rules out; without it
  the orphan can hold a top-k slot that resolves to nothing, so the query
  returns short (the bounded shape change 28 already accepts), never wrong.
  The reader is never lied to, only under-served until the drain catches up.
- *Bulk re-embed (SMD-946).* A model change rebuilds every vector. Against an
  external index this is an index rebuild in the second store, not just an
  `UPDATE` — and `preflight` (SMD-1024), which reads claim counts to know a
  re-embed is unfinished, would have to check the *two* stores agree: same vector
  count, same `embedding_model`. A store whose index build time is a large
  multiple of the `UPDATE` makes a model change a maintenance window rather than
  a background pass — which is itself one of the adoption-bar failure modes below.
- *Metadata filters.* This is the migration-014 hazard restated. Filters live in
  Postgres columns; a second store must either mirror them as payload (and now
  two systems must agree on every metadata write) or apply them after its vector
  LIMIT — which is *exactly* the post-LIMIT filter that silently lost recall and
  cost this fork migration 014. Any second store that filters after the fact
  reintroduces the bug migration 014 fixed; only a store that filters *inside* its
  scan, with the payload kept in sync on every write, is admissible.
- *Cloudflare Workers.* They reach Postgres through PostgREST today
  (`store-postgrest.ts`). A second store means a second client and a second set
  of credentials in the Worker, and the atomicity story above has to hold across
  a network the Worker does not control. Accepted cost: the Worker path carries
  two backends or does not get the second store at all.

**The bar, in SMD-1037's own terms.** A second store is added only if SMD-1037
reports at least one of:

1. a **recall gap against exact** at a filter tier the product actually uses
   (SMD-1037's filter tiers span 36% down to 0.7% selectivity) — pgvector
   materially below the comparator where a real deployment filters, not in the
   abstract;
2. a **latency gap** (p95) at a row count **within a stated multiple of the
   largest real deployment** — a crossover a real corpus reaches, not a
   synthetic-bench extreme (SMD-1018 seeds to 10M) no deployment approaches —
   and measured end to end: in the two-store shape every vector read is an
   external ANN query *plus* a Postgres resolve of the returned ids to rows, so
   the store's own scan time is not the number that decides it;
3. an **index build time** for a re-embed so much worse in pgvector that a model
   change is impractical — the SMD-946 rebuild turning from a background pass
   into a window.

What is pre-registered here is the three dimensions and their direction, not a
mood. The magnitudes — how many recall points count as "material", the latency
multiple, the build-time ceiling — are pinned to SMD-1037's *baseline* (pgvector's
own recall and latency at each tier and size) and fixed before its comparator
numbers are read, so "material" is a delta against a number set in advance, never
a judgment reached once the comparator's result is in view. That is the whole
point of writing this before the measurement.

And, written down before the numbers so it cannot be argued away after: what does
**not** justify a second store —

- an **unfiltered-only** win. Almost every vendor benchmark is unfiltered top-k;
  this product filters. A win that appears only without a filter is measuring a
  query the product rarely runs.
- a win at a **row count no deployment approaches**. If the crossover is past the
  largest corpus in sight, it is a future ticket, not a present one.
- a win that **disappears once the hybrid round trip is counted**. In Postgres a
  hybrid query is one statement over one snapshot; across two stores it is two
  round trips and a merge (SMD-1037 counts these). A vector-only win that a
  two-store hybrid gives back at the merge is not a win.

**The Postgres-internal ladder comes first.** Before a second engine, the same
question is asked of a different index in the *same* engine, where none of the
consistency cost above applies: pgvectorscale's StreamingDiskANN in place of
HNSW; partitioning `thoughts` / `thought_chunks` by agent or by month so a
scan touches less; a covering index over the filter columns so the filtered
path (SMD-968) reads fewer heap pages. The fork is already on this ladder:
SMD-1463 (in flight) gates 014's GIN routing count behind a match estimate,
cutting the filtered path's per-call cost at ten million rows before any
second engine is weighed. SMD-1037 measures one in-engine comparator alongside
the external one precisely to place the crossover on this ladder — a second
store wins only where the in-engine rungs have run out, not merely where
HNSW-in-Postgres loses to DiskANN-anywhere.

**Guardrails in view.** A second store must not drop the `thoughts.embedding`
column: the SQL/PostgREST fallback and every migration that reads it depend on it
staying, and it remains the source of truth a rebuild re-derives the external
index from. Candidate stores carry different licences (Qdrant Apache-2.0,
Weaviate BSD-3, LanceDB Apache-2.0, pgvectorscale PostgreSQL-licensed); the
fork's FSL-1.1-MIT terms stay in view when one is named, and an in-engine index
avoids the question entirely.

SMD-1037 measures. This section decides what the measurement is allowed to
change: nothing, unless a bar above is cleared, and then only as a scoped
implementation issue with its own tests and rollback — never by dropping the
column the rest of the fork stands on.
