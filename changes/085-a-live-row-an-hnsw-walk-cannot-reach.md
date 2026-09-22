# 85. A live row an HNSW walk cannot reach is the geometry, not the vacuum — `db/hnsw-graph.ts` reads the disconnected graph the suite's tied vectors build, and [4]/[11]/[15] join [7] on `match_thoughts`' exact branch (SMD-1632)

**The finding.** SMD-1574 moved `test-live.ts` [7]'s found-by reads off the HNSW
walk after they flaked in CI, and filed this to explain the walk returning none
of three live rows — reading it, from an instrumented dump, as a vacuum leaving
the entry point on a deleted element. The dump was right that the entry point's
reachable component held one row while two live rows sat outside it; the cause
it inferred was not. Over the suite's vectors — orthogonal unit axes, every pair
at cosine distance 1.0 — pgvector's neighbour-selection heuristic (`SelectNeighbors`,
`CheckElementCloser` in `hnswutils.c`) keeps an edge only where a candidate is
strictly closer to the element than to any neighbour already chosen, so with
every distance equal it keeps few, and the graph is not connected. A search
walking from the entry point cannot reach a row in another component, and even a
reachable one is missed by the bounded `ef` beam. This reproduces with **no
vacuum, no deletes**: a single insert of one orthogonal unit vector per axis
leaves live rows unreachable outright. The autovacuum the ticket named is a
contributory trigger — it re-picks the tiny graph's entry point and repairs
neighbourhoods, shifting which rows fall outside the reachable component at the
moment [7] reads — not the root.

**What `db/hnsw-graph.ts` shows.** A reader that decodes the index pages
(pgvector 0.8.6's `HnswMetaPageData`, `HnswElementTupleData`, `HnswNeighborTupleData`
through `pageinspect`'s `get_raw_page`, the magic number and the meta page version
checked), walks the graph from the entry point following neighbour lists at every
level, and joins
to the table by ctid, so it reports the live rows the entry point cannot reach.
On a quiescent index it is a **sound** detector: every row it calls unreachable
is one an unbounded relaxed walk of that row's own vector does not return
(measured against the walk; the reverse does not hold — the bounded beam misses
reachable rows too, so the walk misses more than the decoder reports). It reads
the pages one at a time, not in one snapshot, so under a concurrent insert or
vacuum the picture is inconsistent — fine for the diagnostic it is, not a check
against a brain taking writes. The all-levels walk is the
correction that makes it sound: a search does not walk level 0 from the meta
entry point but descends the upper lists to a query-dependent level-0 start, so
a level-0-only reachability under-counts and would call a reachable row
unreachable — a synthetic-graph assertion in [17] holds the walk to every level
(a review pass found the database soundness sample let a level-0-only walk pass,
so that assertion carries the guarantee). Measured on pgvector 0.8.6-pg16, 1024-dim: 1,024 orthogonal unit
vectors leave 0 to ~860 rows unreachable build to build (one connected build in
twenty), and a search of a row's own axis misses well over 100 of 120 sampled
whatever the hole; a 2,000-row **random** corpus is fully reachable and every
row is found by its own vector. So the pathology needs a corpus **dominated** by
near-equidistant vectors — the suite's, quantised or binary vectors, not real
embeddings.

**The test reads that flaked, and the ones that could.** [7]'s reads took
`match_thoughts`' exact branch in SMD-1574 (a metadata key only that thought
carries → 014/037 score the matching thoughts and their chunks by id, no walk).
This adds the same key to [4], [11] and [15] — the sections whose reads still
walked the same shape of corpus — and filters their reads on it, so the vector
arm (`search_thoughts_hybrid` passes the filter to `match_thoughts` for [11] and
[15]) takes the exact branch too. The ticket doubted [11] could be filtered
without changing what it tests; it can — the keyword arm is filtered by the same
key, which every row carries, so the keyword-hit-outside-the-window and
window-of-one probe are unchanged — and the suite proves it. [5b] is left on the
walk on purpose: its 2,000 vectors are random, which the finding shows are
reachable, and it exists to hold the walk's recall. `test-live.ts` [17] is the
new coverage: the walk misses most axes of an orthogonal corpus and none of a
random one, the decoder is sound, and `REINDEX` does not lift the miss rate.

**The decision.** No production reachability check and no capture-path
verification: a real corpus is reachable, so either would never fire and both
would cost every capture a walk. `REINDEX` is **not** the remedy the ticket
assumed — a rebuild of an all-equidistant graph is no more connected (measured:
the miss rate does not move) — so it is not offered as one. The mitigation is
the diagnostic (`db/hnsw-graph.ts`, superuser-only, for a database you
administer) and the test hardening. Not filed upstream as a bug: HNSW over
near-equidistant data being poorly connected is a known property of the
algorithm, reproduced here with no vacuum in play, not a pgvector defect — the
`hnswvacuum.c` path the ticket read (`RepairGraphEntryPoint`, whose own comment
says the entry point "will be empty until an element is repaired") is real but
is not what the reproduction needs.

**Verified.** `bun test-live.ts` 508/508 against pgvector 0.8.6-pg16, [17]
included, stable across repeated local runs; `db/hnsw-graph.ts` reads both
shipped indexes and its CLI exits non-zero on a holed index. The decoder's
soundness and the random-corpus reachability are the two facts the section rests
on, both robust to the build's randomness; the hole's size is reported, not
gated on.

**Not done here.** No standalone script produces the three-row miss on demand —
the tiny-graph miss needs the suite's accumulated index history and an
autovacuum at the read, and 282 standalone iterations at SMD-1574 plus the
replays here never caught it; the deterministic reproduction is the many-vector
disconnected graph, which is the same mechanism at a scale where it is certain.
The quantised and binary indexes (SMD-1501) share the near-equidistant risk at
low bit depth and are not measured for it. And [17] guards the decoder's
reachability logic and its gross layout (magic and version), not the individual
page-field offsets — a byte-level decode fixture is SMD-1673.
