# 47. `trace_provenance` bounds its work, not only its output — a dense derivation DAG no longer expands multiplicatively (SMD-1288)

025's `trace_provenance` walked UP the `derived_from` chain with a `WITH RECURSIVE
… UNION ALL` and an outer `ORDER BY depth, thought_id LIMIT node_cap`. Its guards
were real but partial: the per-path `visited` array bounded **cycles**, and the
outer `LIMIT` bounded **output** — neither bounded the **work** in between. The
reason is structural: a recursive CTE's `visited` is *per-path*, so two branches
that reach the same node both keep going. On a cycle-free but **dense** DAG — a
thought whose `derived_from` fans out to several sources, each fanning out again,
sources reused across branches — that expands to `~fanout^depth` **paths** (a
5-way derivation ten deep is ~10M), all materialised by the `UNION ALL` before the
outer `LIMIT` could trim a single row. No shipped writer produces such a row
(`upsert_thought` validates `derived_from`, real syntheses have small fan-out;
`update_thought` does not touch the column) — it takes a hand-written DAG — so
025's review found it MEDIUM-adversarial and its header named SMD-1288 as the fix.

**The fix changes the shape.** No clamp bolted onto a recursive CTE can fix this,
because the CTE cannot share a visited set across sibling branches. So
**migration 026** redefines `trace_provenance` as an iterative, level-by-level
breadth-first walk in plpgsql carrying a **walk-global `seen` set**: a node enters
`seen` — and so the frontier — at most once, so its `derived_from` is scanned at
most once: the **multiplicative `fanout^depth` blow-up is gone**. The residual
work is the reachable edges, each paying a membership test against the `seen` set
(`= ANY`), whose size the node cap bounds — linear in the graph, not exponential
in its depth. (Not the strict `O(V+E)` a hashed visited set would give — an array
membership check is `O(|seen|)` per edge — but `|seen|` is cap-bounded and it
measures fine: a 2,000-way fan-out traces in ~8 ms.) The loop also stops the
moment the node cap is reached, so a graph larger than the cap costs the cap, not
the graph. (The ticket's option 1 — a walk-global visited via a different shape —
plus option 2, terminate past `node_cap`. Option 3, a `statement_timeout`
backstop, is declined: once the blow-up is structurally gone and the loop is
cap-terminated, a timeout would mask a regression, not add a guarantee.)

**Measured**, one shared Postgres, via `db/measure-1288.ts` (each layer derives
from every node of the next, so root→leaf paths = `fanout^depth`, distinct nodes =
`fanout*depth+1`):

| dense DAG | OLD (025 per-path CTE) | NEW (026 walk-global BFS) |
|---|---|---|
| fan-out 4, 8 layers — 33 nodes, ~65,536 paths | ~202 ms, cap spent on duplicate *shallow* paths (deep layers never reached) | ~3.4 ms, 117 edge-rows covering **all 33** distinct nodes |
| fan-out 6, 10 layers — 61 nodes, ~60M paths | did not finish — killed by a 20 s guard timeout | ~3.8 ms |

Two things there: the speed (`fanout^depth` paths → linear in the reachable
graph), and a **completeness** fix — the old outer `LIMIT` counted duplicate
paths, so on a dense graph it capped out among
shallow repeats and never surfaced the deep distinct ancestors; the new walk emits
each derivation edge once, so under one row budget it reaches every distinct node
when the edges fit the cap (fan-out 4: 117 edge-rows for 33 nodes, under 250) and
otherwise reaches far deeper than the old shallow duplicates did (fan-out 6 has
~330 edges, so the 250-row cap stops it partway — many layers below where the old
walk's third-layer duplicates ran out). The cap bounds returned rows (one per
edge), not distinct nodes.

**The output contract holds** (Verify): same signature, same `RETURNS TABLE`, same
clamps. The linear chain still returns child@0 / parent@1 / grandparent@2, all
`cycle=false`; a forced cycle still yields a `cycle=true` row and a bounded count
(`test-live` [13], kept verbatim). One deliberate ordering change: rows stay
depth-ascending, but within a depth 026 emits tree edges before repeat markers
(then by id) rather than 025's pure id order, so a truncating node cap keeps real
ancestors over repeat markers; no caller depends on within-depth order (no MCP
tool exposes the walk yet). The `cycle` flag is refined to fit a
global-visited walk and is *more* correct on a DAG: a **diamond** (two direct
sources sharing a grandparent — the common dense shape) reaches the shared ancestor
twice within one level, and because `seen` is a start-of-level snapshot both edges
read `cycle=false` from their two distinct parents (025's per-path output) while
the node is expanded once. A true back-edge to an earlier level is `cycle=true` and
not re-expanded. The one honest imprecision: a DAG re-convergence at a *greater*
depth is also flagged `cycle=true` — a global-visited walk cannot tell it from a
real cycle without the per-path ancestry that is exactly the blow-up being removed;
it only ever over-flags a repeat, never loops, never drops a distinct ancestor.

Only `trace_provenance` changes. `find_derivatives` (a single-level `@>` lookup),
`upsert_thought`, the audit trigger, and the two columns are untouched, and the
store interface is unchanged (the fix is entirely below it). New coverage:
`test-live` [14] (a dense DAG through the real write path — every distinct ancestor
reached, no path explosion, a diamond's every edge kept, no false cycle),
`test-schema` [25] (026 is the last definer, the body carries the
`ob1:provenance-walk-bounded` sentinel and no longer uses a recursive CTE). All 19
`ci-parity` suites green; `db/measure-1288.ts` is the standalone measurement tool,
outside `ci-parity` like `bench-plan.ts` (it needs a real Postgres and provokes a
timeout).

Upstream status: **not applicable** — upstream's `provenance-chains` is a schema
sketch, not this iterative walk; this is a fork-internal bound on the fork's own
025. Downstream follow-up unchanged (an MCP read API for the chain, still
SMD-1253's deferred item). **Unfiled** upstream.
