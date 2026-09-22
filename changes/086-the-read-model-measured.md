# 86. The read model, measured — the store holds the payload and serves the read with zero Postgres calls, and removing the resolve does not change the latency verdict; it relocates the cost to write time and storage (SMD-1696)

Change 82 (SMD-1662) closed by naming what it had not measured: it, like change
79, benchmarked a second store as a *subordinate ANN index* — Postgres the source
of truth, every read resolving the store's ids back to Postgres rows — so the
id→row resolve the "not built" verdict leaned on was partly an artifact of that
chosen topology, not of a two-store design. The shape it defined away is the one
where a second store is actually compelling: a **read model** (CQRS), where the
store holds the vector *and the full payload* and serves the retrieval read
completely, Postgres kept only as the transactional write log — a read path that
makes **zero Postgres calls**. This measures that shape, on the same harness and
the same exact-cosine oracle. Like changes 31, 53, 55, 59, 79 and 82 it ships no
runtime change; the numbers are in evals/README.md, under "Does the store matter?".

A `LanceReadModel` is added beside `LanceEngine` in `evals/store-backends.ts`: the
same in-process ANN, but every row carries `content` and `metadata` alongside the
vector, so it exposes two reads over one index — `search` (ids only, feeding the
change-82 resolve) and `searchRows` (full rows, the read-model read). The driver
`evals/store-readmodel.ts` measures three read paths on identical vectors against
one oracle: **(1)** single-store Postgres — one statement, ANN over the points
joined to the payload, a `match_thoughts`-equivalent read; **(2)** the change-82
two-store resolve — LanceDB ids, then Postgres pulls the payload back; **(3)** the
read model — LanceDB returns the full rows, no Postgres. Paths 2 and 3 use the
same LanceDB index and differ only in where the payload comes from, so `(path2 −
path3)` is the net topology delta and `(path1 − path3)` is the read model against
the incumbent.

**The zero-Postgres read path is real, and demonstrated.** The read model holds no
Postgres handle, so its read path is zero-Postgres by construction; a query counter
on the shared handle reads **0** across the whole path-3 loop (a runtime regression
guard), and — the demonstration — Postgres is *stopped* mid-run and the read model
still answers, byte-identical rows, with the OLTP database down. Content
correctness is checked too: every returned row carries the exact payload, not just
a matching id.

**Removing the resolve does not change change 79's latency conclusion.** On the
real corpus (601 issues, 963 points, 1024-dim, 150 queries) all three paths land
within a few tenths of a millisecond of each other — no clear winner: the read
model *edged* single-store Postgres by 0.09 ms in one run (1.21 vs 1.30 ms p50) and
trailed it on a quieter run, and the read-model-vs-resolve delta was 0.0–0.5 ms.
The resolve is essentially free at this size, so removing it buys nothing. At **1M
rows (64-dim)** the tie breaks toward the single store: single-store pgvector's own
HNSW read (~2.5 ms) was the fastest of the three in every run, and the
read-model-vs-resolve delta sat within run-to-run noise of zero (−0.7 to +0.5 ms) —
fetching the payload from LanceDB costs about the same as a Postgres primary-key
resolve of ten ids. So from 1M up the read model does not overtake the single
store: pgvector serving the read in one statement is the floor, and the resolve was
never the deciding cost.

At **10M rows** the same holds and the write side sharpens. (pgvector HNSW did not
build in a practical window here — still constructing its graph after 40 minutes,
so it was abandoned; the single-store anchor uses IVFFlat, which built in 2.4 min,
as change 82's 10M table did.) Single-store pgvector IVFFlat was again the fastest
read at 5.9 ms p50, the read model 7.4 ms, and the resolve delta a negligible
0.18 ms — removing it still does not overtake the single store. What grows sharply
is the mutable-edit tax: propagating one content edit cost **84.8 ms at 10M**
(3.3 → 11.7 → 84.8 ms/ref from 601 rows to 1M to 10M) as each edit rewrites an
ever-larger Lance fragment, while batched appends stayed cheap (drain 103k
rows/s). The read model added 6.3 GB on top of Postgres's 8.9 GB (+71% system), and
filtered reads on it reached ~244 ms — LanceDB scanning an unindexed list-column
prefilter over 10M rows, a scale wart a scalar index would address but the
index-only shape carries too.

**The cost the read model removes from read time reappears at write time — and it
is dominated by mutable edits.** A *synchronous* dual-write (each durable Postgres
write plus a per-row LanceDB append) cost **~2.3–3.0 ms/write** on top of the
Postgres write, because LanceDB writes a data fragment per `add`. Batched
propagation is the cure: an outbox/CDC drain sustained **21,000–103,000 rows/s**
across the scales (~0.01–0.05 ms/row), a few milliseconds per batch of freshness
lag — a batched append is one Lance fragment write amortised over the batch, so it
is cheap and does not grow with corpus size. That is the pattern OB1 already runs —
embeddings are *already* eventually consistent with content, the re-embed worker
lagging writes — so a read model is that same consistency model relocated, not a
new one. The genuinely expensive part is payload *edits*: propagating one
`update_thought`-style content change (a LanceDB `update`, which rewrites the
fragment holding the ref) cost **3.3 ms/ref on the real corpus and 11.7 ms/ref at
1M** (84.8 ms/ref at 10M) — it grows with fragment size, unlike a batched append.
Vectors are append-mostly; the consistency tax is the mutable payload, and unlike
the vectors it does not stay cheap as the store grows.

**Storage: the payload is held twice.** The payload lives in both stores.
On the real corpus the read-model dataset was 9 MB against an index-only LanceDB's
5 MB (a 4 MB payload duplication on disk; 2 MB logical), lifting the whole-system
total from 15 MB single-store to 24 MB. At 1M the read model held 656 MB against
599 MB index-only, whole-system 1.95 GB vs 1.30 GB single-store — about +50% (+71%
at 10M). (On-disk duplication tracks compressibility: the synthetic filler
compresses hard — 57 MB on disk vs 268 MB logical at 1M — so there it understates
what real content would cost; real content does not compress and carries Lance's
per-fragment overhead, landing near or above the logical figure — 4 MB on disk vs
2 MB logical on the real corpus.)

**Verdict — change 79's holds, and now the resolve it leaned on is shown not to be
the bottleneck.** The read-model topology *works*: its read path is provably
zero-Postgres — it serves reads with Postgres stopped — and feeding it is cheap for
appends when batched, on the eventual-consistency model the fork already uses. But
removing the resolve buys no read-latency win: the resolve is a fraction of a
millisecond, the three paths are within noise on the real corpus, single-store
pgvector has the fastest *p50* from 1M up, and the read-model-vs-resolve difference
is within noise throughout. (One tail-latency caveat already points at the scale
case: at 10M the single store could only run IVFFlat — pg HNSW would not build —
whose p95, 17.8 ms, is worse than the external HNSW_SQ index's 8.5 ms; at scale the
off-DB store builds a better-tail index than pgvector can, which is SMD-1697's
territory.) Meanwhile the read model holds the payload a second time (+50–71%
whole-system) and adds a write-time propagation path whose mutable-edit cost *grows*
with scale. So the read model does not earn its place on *retrieval latency*; where
it plausibly would is
the scale/operational envelope — offloading the vector working set off the OLTP
database and being buildable where single-store pgvector is not (the 10M arm of
change 82 already showed pgvector failing to build where LanceDB built in 28 s).
That is SMD-1697, still open. **Not built**; `thoughts.embedding` stays the source
of truth, now because the resolve the second-store case turned on was measured and
found not to be the cost — not merely assumed. (LanceDB is Apache-2.0 and the fork
is FSL-1.1-MIT — SMD-1038's guardrail — a dependency of an eval, not the product.)

**What this still measures as a race, not a composition.** Change 79, change 82 and
this one all measured stores as *substitutes* — each doing the whole match and
returning the rows, the cross-store hop treated as cost to minimise (change 82) or
eliminate (this change). None measured stores as *complements*: a **composed** match
where a scalable ANN engine does cheap coarse recall and Postgres does the exact
rerank/fusion — metadata, recency, keyword, freshness — over the small candidate
set. In that shape the id→row hop is the *precision stage*, not a tax, and it is
also the scale answer (coarse recall shards; the rerank set stays small and fits
RAM). That is the axis on which a second store plausibly earns its place, and all
three evals defined it away by racing single stores at the whole job. Measured
in change 87 (SMD-1707).

**Upstream status:** not applicable — the store comparison is this fork's eval.
