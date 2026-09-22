# 82. LanceDB, the embedded store, measured too — the one part of the two-store cost it removes is the network hop, and the hop was never the cost (SMD-1662)

Change 79 (SMD-1037) bracketed the second-store question with a separate server
(Qdrant) and an in-engine index (DiskANN), and left one shape untested that the
ticket itself named: an *embedded* store, run in-process against local files with
no second server and no network round trip — though still a second store to keep
consistent with Postgres. LanceDB is that store. It is wired as a fourth store
into the same harness (`evals/store-backends.ts`, a `LanceEngine` behind the same
`ExternalEngine` interface as Qdrant), scored against the same exact-cosine
oracle over the same points, so the measurement isolates which part of the
two-store cost is the network hop and which is architectural. Like changes 31,
53, 55, 59 and 79 it ships no runtime change; the numbers are in evals/README.md,
under "Does the store matter?".

**Filtered recall holds — because LanceDB prefilters, which is the migration-014
shape, not a store advantage.** LanceDB has no unquantized HNSW; its unquantized
index is IVF_FLAT (the fair recall row) and its graph is HNSW_SQ (scalar-
quantized). Both apply the filter *before* the vector search, so on the real
corpus they hold recall at the selective tiers where a *bare* pgvector HNSW
collapses (portal 3.5%: bare HNSW 10%, LanceDB IVF_FLAT in the high 80s at
default — build-variable, exact once probed — and HNSW_SQ 99–100%). That is
exactly what Qdrant did in change 79, and
exactly what `match_thoughts` already does in-engine via migration 014's in-scan
filter. LanceDB *matches* the in-engine ladder; it does not beat it.

**The network hop, isolated — and it is a fraction of a millisecond.** The clean
measure is the bare per-query vector round trip at default effort: Qdrant's whole
call — a round trip to its localhost server plus an HNSW search — ran at 0.77 ms
median, LanceDB's in-process IVF_FLAT call at 0.57 ms. The ~0.2 ms difference
(0.1–0.2 ms across runs) is an upper bound on the network hop: it also folds in
whatever separates an HNSW search from an IVF_FLAT one, so the loopback trip
itself is smaller. Either way it is sub-millisecond, growing only with real
network distance — the whole of what "embedded" buys. (The two-store hybrid arm runs its vector and
keyword legs in parallel, so its means measure the round-trip *shape* — two trips
versus one statement — not the hop, which is why the hop is read from the bare
search latency instead.) What "embedded" does **not** remove is the rest of the
two-store cost — every read is still an ANN search plus a Postgres resolve of the
ids it returns, and two stores must still be kept consistent (SMD-1038's
consistency section). Those are the costs change 79's verdict rested on, and they
are unchanged.

**At scale, the leanest external store is still a second store.** LanceDB is
embedded and on-disk (memory-mapped Lance files), so at a million 64-dim rows it
loaded in 5 s and built its index in 2 s to a 541 MB dataset, against Qdrant's
28 s load, 92 s index and 994 MB — the leanest, fastest-built external measured.
At ten million — where change 79 recorded Qdrant's *in-RAM* index OOM-crashing
the 14 GB VM — LanceDB built its IVF_FLAT in 28 s to a 5.6 GB dataset where
Qdrant's on-disk index needed 26 minutes and 7.4 GB; being on-disk from the
start, it never needed the on-disk workaround at all. But its end-to-end read
(~7.7 ms at 10M, within noise of Qdrant's on-disk 7.3 ms) still carries the
Postgres id→row resolve, so it does not gap toward a latency win over the single
store any more than Qdrant did; it removes the hop that was already cheap and
keeps the resolve that was the point.

**Verdict — change 79's holds, now for a reason it named.** The one part of the
two-store cost LanceDB removes is the network hop; the hop is a fraction of a
millisecond (~0.1–0.2 ms) on loopback, not the cost the verdict rested on. What remains is what it rested on:
a second store's id→row resolve and the consistency tax of two stores. LanceDB is
the best-behaved external store measured — prefilter recall, the leanest
footprint, no server — and a best-behaved second store is still a second store
that does not beat what migration 014 gives Postgres in-engine. Not built; the
`thoughts.embedding` column stays the source of truth. (LanceDB is Apache-2.0 and
the fork is FSL-1.1-MIT — SMD-1038's guardrail — so it is a dependency of an
eval, not the product.)

**What this does not answer.** This measured a second store as a *subordinate ANN
index* — Postgres the source of truth, every read resolving ids back to it — and
on *retrieval quality* it found parity, with filter strategy (in-engine via
migration 014) the only real variable. It did **not** measure the two shapes
where a second store would actually earn its place, and the resolve/consistency
costs the verdict leans on are partly artifacts of that chosen topology: a
**read-model** shape where the store holds the payload and serves the read with no
Postgres resolve at all (SMD-1696), and the **scale/operational failure envelope**
— the corpus size and width at which single-store pgvector stops fitting or
building, plus the re-embed maintenance window and read/write contention it
imposes (SMD-1697). The 10M arm above already hints at the latter: pgvector could
not build there while LanceDB built in 28 s. So "not built" is scoped to
retrieval quality on a corpus the single store handles; the read-model topology
and the scale case are open.

**Upstream status:** not applicable — the store comparison is this fork's eval.
