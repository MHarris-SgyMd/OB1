# 89. GraphRAG as an expansion/rerank stage, measured on the *typed* graph and beyond recall — not a substitute and not an everyday stage over a vector already at ceiling, but a real recall complement exactly where a single vector pass runs short (SMD-1738)

Change 31 (SMD-948) declined GraphRAG on a head-to-head: vector recall@10 0.98, graph
0.51 over twenty-seven hand-labelled questions. But that raced the graph as a
**substitute** — the recall tier doing the whole match, seeding its own entities from the
question — the substitute-vs-complement error change 87 (SMD-1707) named. A graph is
rarely a good recall tier and might be a good **expansion/precision** stage: pull the
neighbours of the *vector* hits along the change-30 entity edges and rerank the union.
This measures that shape, on the same `eval-graphrag.ts` corpus and labelled gold. Like
changes 31, 53, 55, 59, 79, 82, 86, 87 and 88 it ships no runtime change; the numbers are
in evals/README.md, under "GraphRAG…".

`eval-graphrag.ts` gains a **composed arm** (vector coarse recall K′ → seed the graph from
*those* hits' entities → expand `hops` over `ob1_entity_edges` → symmetric-RRF rerank the
union) and, because a first pass flattened the graph, a **comp-typed** arm that uses the
graph's real structure: a *typed, weighted* walk (undirected traversal) weighting each hop by a
pre-registered relation prior (a `depends_on`/`uses` edge carries more relevance than a
`co_occurs_with` one), the edge's evidence support (a saturating `support/(support+5)`) and its confidence,
propagated as decaying spreading activation. A **comp-cos** control orders the union by
cosine only. The **pre-registered bar** (SMD-1038 posture, committed before the numbers):
build iff multi-hop recall lifts ≥ 0.05 over vector AND recovers more than it breaks AND
does not cut aggregate recall — checked on every cell of the K′×hop sweep, so a FAIL means
no cell cleared all three.

**Recall, against a full-budget vector: the bar FAILS, because vector is already at
ceiling.** Vector gets multi-hop recall@10 **1.00** (601 issues, 1024-dim, 27 questions);
the substitute graph reproduces change 31 at **0.43**. The best composed cell scores
**0.89** multi-hop — below vector — and **recovers 0** of vector's answers. The control
says why: **comp-cos ties vector exactly (1.00)** — pooling the graph-reached thoughts
loses nothing and adds nothing, vector already held every answer, so the rerank can only
subtract. **Using the real typed edges makes the rerank gentler** — comp-typed lifts recall
over the untyped walk (0.89 → 0.95 all, multi-hop **0.98**) and ranking (all-question nDCG 0.73 → 0.77; multi-hop 0.69 → 0.75)
by weighting the graph score down where the edge is weak, so it preserves more of vector's
order — but it still **cannot exceed** a ceiling'd vector (comp-cos = vector). So the
flattening cost some recall, and the ceiling caps even the typed version.

**But recall is one axis, and the ceiling is a property of the *question set*, not of the
graph. On the axes a graph is built for, the picture turns.**

- **Recall-complement under a starved vector budget — the finding.** Constrain the vector
  coarse budget b and the edge-aware graph becomes a real recall tier: at **b = 1** vector
  alone gets recall@10 **0.35** and the composed stage **0.83** (**+0.48**; multi-hop 0.42
  → 0.85), at b = 3 0.78 → 0.90, crossing over only at b ≈ 10 where vector reaches its
  ceiling (0.97 → 0.95). That is exactly the regime change 87 found a single ANN falls
  into *at scale* — recall degrades and the second tier recovers it. The ceiling here hides
  it; a corpus or scale where vector is not saturated does not.
- **Relational structure a vector pass cannot see.** Of 3,000 issue pairs joined by a
  strong typed edge (`depends_on`/`uses`), **95%** have the linked sibling *outside* the
  issue's vector top-10 — a large store of relational neighbours only the graph reaches
  (the raw material the scarcity probe turns into recovered recall). Descriptive: the graph
  both defines and answers the link, so it measures vector's blind spot, not a scored win.
- **Exact entity-membership** applies to only 5 of the 10 needle questions — the rest are
  literal-string aggregations (`Decision:`, `Promote`), keyword's job. On the 5 that name
  an entity the extracted graph trails (0.18 vs vector 0.97), limited by change-30's
  extraction coverage (most entities are mentioned once). The set poses few true
  entity-membership or relational queries — the same shape-of-question gap change 31 named.

**Scale (synthetic, latency only).** A synthetic typed graph times the expansion stage
alone. It is **not** K′-bounded as written: at 1M (6M mentions) a ~2.0 s floor at K′=10
rising to ~5.0 s at K′=1000/2-hop, and at 10M (30M mentions, lighter density) a ~7 s floor essentially FLAT across K′=10–1000 (11.3 s only at K′=1000/2-hop) — the df scan tracks the mention count, not K′ — dominated by the per-call `df` full scan
over every mention (the change-31 walk recomputes document frequency each call). Rows-read
bounded ≠ wall-clock bounded (change 87); a **materialized `df`** refreshed on write is the
prerequisite for the stage to scale, and the typed pass adds the `edge_w` aggregate cost on
top. So the mechanism needs a standing df table before the scarce-recall regime it wins in
is reachable in production.

**Verdict — not a substitute, not an everyday stage, a *conditional* tier.** Against a
healthy full-budget vector on ordinary questions the graph stage does not pay (bar FAILS;
ceiling). But where vector recall is *scarce* — deep scale, a tight ANN budget, relational
or entity-membership questions this corpus barely poses — the edge-aware graph is a real
recall/precision complement, the recall tier to Postgres/vector's precision tier that
change 87 framed. This sharpens change 31's "do not build" rather than overturning it: not
built, and a product path is a **scale-regime test** away (SMD-1038 posture), not a
here-and-now build.

**Forward-looking — truthiness, lineage, and edges that carry relevance.** The value seen
here comes from the edges' *type and support*; their `confidence` is nearly uniform (a weak
signal), and **lineage/supersession is absent** from the Linear corpus — that is the fork's
claim-log machinery (SMD-1729) and trust labels (SMD-1724), not this eval's data. Carrying
trust, lineage and recency *dynamically* on the edges — relevance as continuous-time
diffusion over a typed/weighted/temporal graph, a CfC/liquid-network shape — is where this
points; the static edge-aware expansion here is the discrete first step, and it would need
the claim-log lineage and trust labels the fork has scoped but not built to become the
dynamic version. (LanceDB/graph aside: the entity graph is this fork's own change 30, an
eval dependency, not the product.)

**Upstream status:** not applicable — the graph and its eval are this fork's.
