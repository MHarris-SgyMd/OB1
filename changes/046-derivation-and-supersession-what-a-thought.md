# 46. Derivation and supersession: what a thought was built from, and which it replaces (SMD-1253)

A row in `thoughts` could say **who** wrote it (008/010) and **what it mentions**
(016's entity edges, entity-to-entity), but nothing said what it was **derived
from** or that one thought **replaces** another. Fine while every row is an atomic
capture; wrong the moment a derived artifact — a digest, a consolidation, a
synthesis — is captured back, because the derived row is then indistinguishable
from a first-hand one and `match_thoughts` ranks last month's superseded digest
beside today's. This was the last of upstream's sixteen schemas the fork had not
absorbed — "the one real capability gap" (the upstream survey).

**Designed as one mechanism per fact, which was the whole instruction.** Upstream
ships two overlapping schemas: `schemas/provenance-chains` (columns on `thoughts`)
and `schemas/typed-reasoning-edges` (a `thought_edges` table whose six relation
types include `supersedes`). Both claim supersession — a column and an edge row —
and absorbing both would rebuild the two-mechanisms-for-one-fact defect 021/022
spent two tickets removing. So supersession is ONE thing: **the `supersedes`
column.** `thought_edges` is **not** built — there is no reasoning-edge classifier
here to write supports/contradicts/depends_on rows, and a table with no producer
is the speculative graph the SMD-948 GraphRAG spike measured and declined; it
stays the later ticket change 30 already named it.

**Migration 025** adds two nullable columns to `thoughts`: `derived_from jsonb`
(an array of source thought ids) with a `jsonb_typeof = 'array'` CHECK, and
`supersedes uuid REFERENCES thoughts(id) ON DELETE SET NULL`. **SET NULL** is the
one delete action that fits the fork's hard-delete-plus-audit design (008/009): a
superseded thought stays deletable, its content preserved in the append-only audit
delete row, and clearing the successor's pointer is itself audited — RESTRICT would
break delete, CASCADE would delete the *successor*. A GIN index on `derived_from`
(reverse lookup) and a partial index on `supersedes`.

**Deliberate departures from upstream's shape, take-the-shape-not-the-files.**
No `SECURITY DEFINER`, no `service_role` grant, no RLS, no `NOTIFY pgrst` — the
functions are plain, as everything off Supabase is (`db/README.md`). The
`sensitivity_tier` redaction branch is **dropped**: this fork has no tier, no RLS,
and an owner connection with BYPASSRLS, so a tier with nothing enforcing it is the
same theater as the RLS policy the README says not to port; if a tier ever
arrives it is SMD-950's. `derivation_method` stays in `metadata` (no FK/index/query
need; upstream itself reads `type`/`source_type` from metadata), so only the two
load-bearing facts are columns.

**Validation is the write path's job, or it is an untrusted-input hole** (the
ticket's words). A per-element UUID check cannot be a table CHECK (no subqueries),
so `upsert_thought` — redefined here, carrying 022's whole body forward verbatim
(005's guard, 008's actor, 021's label, 022's `FOR NO KEY UPDATE` read and chunk
sentinel) — reads `derived_from`/`supersedes` from the payload envelope and
**refuses** a `derived_from` that is not an array of *existing* thought ids.
`supersedes`' existence is the self-FK's. Both ride the envelope like the actor
(008) and the model (021), so capture sets them and both stores stay in sync; a
bare re-capture adds provenance but never clears it (that is `update_thought`'s, a
follow-up — landed as change 60, migration 032; and since change 66, migration
035, a re-capture adds none either: provenance lands on a first capture only,
and the return says `existed`). Capture is the only write path this change gives provenance —
`capture_thought` grows optional `derived_from`/`supersedes` inputs.

**Read-back both ways.** `trace_provenance(id)` walks UP the `derived_from` chain
(ancestors, cycle-guarded, depth/node-capped); `find_derivatives(id)` looks DOWN
it. Both back new `ThoughtStore` methods on both stores (plain functions, so
PostgREST calls them too). No MCP tool exposes them yet — 016's entity graph
exposed none either — that is a follow-up.

**What retrieval does with it: measured, then LABEL only.** A `supersedes` column
no search reads buys nothing, and the choice — exclude, down-weight, or label —
"needs an eval the way 020's recency blend did." `evals/eval-supersession.ts` seeds
a corpus through the real write path with superseded twins, then compares
label-only against excluding the twin (a TypeScript oracle, so no shipped search
signature changed to ask the question), under two definitions of relevance:

| relevance | label-only | exclude | Δ MRR |
| --- | ---: | ---: | ---: |
| TOPICAL (any version of the topic — the fork's title→body task) | 1.000 | 1.000 | +0.000 |
| CURRENT (only the non-superseded version) | 0.667 | 1.000 | +0.333 |

On the topical task the fork measures against, the numbers **do not move** — a
superseded thought is still about its subject, so removing it can only cost, never
help, the same reason 020's recency blend was measured to hurt and left at zero.
So, exactly as the ticket says to when the numbers do not move, **the ranking
change does not ship**: supersession is **labelled**, not excluded. `search_thoughts`
and `list_thoughts` mark a returned hit a newer thought supersedes and name the
replacement (a store-side lookup over the `supersedes` column, no search-function
surgery — mirroring the `ID:` line of SMD-1248). The label serves the
current-version reader — who the eval shows exclusion would help — without a
ranking change the topical task cannot justify. An exclude/down-weight is a
follow-up; the eval is the instrument to justify it.

**Verified.** `test-live.ts` [13] round-trips a three-thought chain through
`upsert_thought`, traces it both directions, forces a cycle by a raw UPDATE and
shows the guard terminates it, and proves a deleted parent behaves as 008/009 say:
the child survives, its `supersedes` is SET NULL, the delete is audited with the
prior content and provenance in full, and the SET NULL is itself audited on the
child — an update the pre-025 diff could not see. A malformed or non-existent
`derived_from` is refused at the write, leaving no row. `test-schema.ts` [25]
asserts the columns (ten now), the FK's SET NULL, the CHECK, and both functions;
`test-store-sql`/`test-store-postgrest` [9] cover the capture, read-back and label
lookup on each backend; `test-preflight` covers a new `provenance` check that fails
a database stopped at 024 (the old `upsert_thought` would drop the envelope keys
silently). All 19 ci-parity suites green; `eval-supersession.ts` green; `tsc
--noEmit` clean.

Upstream status: absorbs the *shape* of `schemas/provenance-chains`; declines
`schemas/typed-reasoning-edges` (deferred) and the `sensitivity_tier` branch.
Downstream follow-ups the ticket names: `smart-ingest`'s reconcile vocabulary
(`append_evidence`/`create_revision`), an MCP read API for the chain, post-hoc
provenance edits, and the evidence-versus-instruction trust model (SMD-950).
**Unfiled** upstream.
