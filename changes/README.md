# changes/ — one file per change

The record of every change from 18 on is one file in this directory, and
[the index](#index) at the end of this file lists them; changes 1–17 are
[`FORK.md`](../FORK.md)'s table, the record of the fork era. How a change is
versioned and released is [`MAINTAINING.md`](../MAINTAINING.md). A change file is
in one of two states:

- **`NNN-<slug>.md` — a numbered change.** The change number is the one code
  comments cite as "FORK.md change N" and `db/README.md`'s migration map cites as
  "NNN change M". The numbers run contiguously from 18 with no gap and no
  duplicate. Only the release step creates one of these (18–103 predate it).
- **`smd-NNNN.md` — a release fragment** (SMD-1804): what a pull request ships.
  It has no change number yet; the release step assigns one when it assembles a
  release, turning the fragment into `NNN-<slug>.md` in merge order. So a merge of
  `main` while a PR is in review renumbers nothing, and two PRs never collide on a
  number. A fragment needs no edit to the index: it lists numbered files
  alone and says, in one fixed sentence, that the `smd-*.md` files here are
  what has landed since the last release — so two PRs that each add a fragment
  never conflict on it. The index is the release step's to move (SMD-2084).

Until SMD-1917 these were `### N.` sections of one 1.2 MB, 17,700-line FORK.md
that no context window could hold whole, numbered by hand at PR time and
renumbered at every merge of `main`.

## A fragment (what a PR adds)

```markdown
---
type: added        # one of: added | changed | deprecated | removed | fixed | security  (Keep a Changelog's six)
bump: minor        # one of: major | minor | patch  (the version rules in MAINTAINING.md; a `patch` that ships a migration is refused)
tickets: [SMD-1804]        # one or more SMD-#### ids
migrations: [044]          # the migration numbers this change adds, or [] for none
---

## Changelog

One to three lines for CHANGELOG.md, no leading bullet, naming every ticket the
front matter lists and no other (the release pairing reads a version's tickets
from this line), and the migration numbers.

## FORK

The change's record, to the end of the file. Its FIRST line is the title —
"Thing — consequence (SMD-NNNN)", ending in every ticket the front matter lists,
as "(SMD-1 / 2)" — what will follow `# N. ` once numbered; then a blank line,
then the body in the shape below; `## ` sub-headings of its own are kept. Cite
tickets, migration numbers and existing change numbers; do not give the record
its own number or heading — the release step does.
```

**A removal names its side of the version contract** (SMD-2687). This applies to
a fragment that removes or renames a URL, route, port or setting in a file a
release ships, a flag or named value of a command a shipped image runs, or that
deletes vendored code. One sentence of its FORK body says
which side of the contract the change falls on (MAINTAINING.md, "Versioning"). Inside
the contract it is a `major`. Maintainer tooling and vendored code are outside
it, so there it is a `minor`, and its Changelog body carries an **Upgrading:**
line. SMD-2878's record is the example: the three-brain stack's file was
tooling.

**Name another change by its ticket, not its fragment's path** (SMD-2047). The
cut numbers every fragment and rewrites no mention of one, so a
`changes/smd-NNNN.md` path in a fragment points at nothing after it. Write
"SMD-NNNN's record" instead; a path pinned to a commit
(`<sha>:changes/smd-NNNN.md`) still resolves.

`CONTRIBUTING.md` says when a fragment is required. `check-fork-consistency`
validates every fragment (the six types, a bump the migrations allow, both bodies
present and in that order, the changelog line and the title naming the tickets,
no numbered heading in the FORK body, no path to a fragment, the line cap
below) — the same function
the release step runs before it writes.

## The shape of the record

Bold-led paragraphs, in this order, each only if it applies:

- **What changed.** The mechanism, in the file's own terms.
- **Why.** The measured defect — what was observed, on what, before.
- **Held.** The check, the test, the CI line that fails when it comes back.
- **Measured after.** The numbers on the same setup, after.
- **Review passes.** A table, one row per finding that changed the mechanism:
  pass, finding, who caught it (`cold read` / `run-it` / `mutant` / `CI`), the
  fix commit. Not a paragraph per pass: the prose is in the pass's commit body,
  where `(caught: …)` tags live and `scripts/mechanism-yield.ts` reads them.
  A finding worth more than a row is worth a follow-up ticket.
- **Not taken.** What was argued and declined, and why.
- **Follow-ups.** The tickets filed.
- **Upstream status.**

A file — fragment or numbered — is at most **150 lines**. The 47 numbered files
that were over it when the split landed (46 from FORK.md, and 103, which reached
`main` as a hand-numbered section while the split was in review) are listed in
check 15's `OVERSIZE_AT_SPLIT` with the line count they had then, rounded up to
ten, and may only shrink: a listed
file that fits under the cap fails until its entry is dropped, and a listed file
that grows past its ceiling fails.
[`102-…`](102-every-knob-the-server-reads-reaches.md) is the first record cut to
the shape (470 lines to 119);
[`108-…`](108-fork-md-is-the-front-door-and-every-change.md), SMD-1917's own
record, is the second.

## At a release

`bun scripts/assemble-release.ts` (dry run; `--write` applies) takes the
fragments in merge order — when each arrived on the branch's first-parent line,
the merge that brought it — writes each as the next `NNN-<slug>.md` with its
`# N. <title>` heading, removes the fragment, regenerates the index below with
`scripts/fork-index.ts`, writes the `CHANGELOG.md` section and appends to
`releases.json`, which freezes the shas of the migrations in the range and records
the change numbers. It runs check 16's rules first and refuses what CI would;
`--write` needs the repository (a full clone, not a shallow one), a clean tree,
committed fragments, and a tree that already says the version — `FORK_VERSION`
bumped and a `NNN_schema_version.sql` writing it as the highest migration, the
cut's first commit (SMD-1860). The PR lands both commits; the tag on the merge
commit runs `.github/workflows/release.yml`, which publishes the images and the
release, the numbered change files attached. MAINTAINING.md's "Versioning" and
"Cutting a release" have the scheme and the cut.

## History

The text of 18–102 is verbatim from FORK.md at the split, the heading level
changed, with two placements moved: the "second vector store beside Postgres"
design (SMD-1038) sat inside change 19's span and is in
[change 79](079-the-store-measured-against-pgvector.md), the measurement it
pre-registered; "The recurring defect in this fork: a value defined twice" is a
house rule and a standing section of FORK.md (MAINTAINING.md's "The recurring
defect: a value defined twice" since SMD-3765). Their history before the split
is FORK.md's: `git log -- FORK.md`, or
`git log -S '<a phrase from the file>' -- FORK.md`. Git does not follow a split
of one file into eighty-five, so `git log --follow` on a change file starts at
the split.

## Held by

`scripts/check-fork-consistency.ts` check 15: file names (numbered or fragment),
contiguous numbers, the `# N.` heading matching the name, the line cap and its
ratchet, MAINTAINING.md and FORK.md each under the byte ceiling and carrying
neither a numbered section at any heading level nor the index's markers, the
index between this file's markers equal to what `scripts/fork-index.ts` renders
from this directory's numbered files (a fragment changes nothing there), and
every "FORK.md change N" / "FORK change N" / `changes/NNN` / "NNN change M"
citation in a file git tracks or would track — and every "change N" in the
record itself — naming a number with a file (or a row of the 1–17 table). Check
16 holds the fragment shape; check 17 the changelog, the release pairing and the
frozen migrations.

## Index

Generated by `scripts/fork-index.ts` from this directory's numbered files (in
FORK.md until SMD-3765); check 15 fails the tree when the two differ.

<!-- changes-index:start — generated from changes/ by scripts/fork-index.ts; do not edit by hand -->
**344 numbered changes** since the pin: 1–17 are [FORK.md's table](../FORK.md#what-we-changed); 18–344 are one file each in this directory, newest last. A change's record is its file; the review-pass prose behind it is in the commits (`(caught: …)` tags, read by `scripts/mechanism-yield.ts`).

| # | Change | Ticket |
| --- | --- | --- |
| 18 | [Long captures stay searchable](018-long-captures-stay-searchable.md) | — |
| 19 | [Default embedding model → `qwen3-embedding:4b` at 1024 dimensions](019-default-embedding-model-to-qwen3-embedding-4b.md) | — |
| 20 | [Shared scaffolding, and pure logic lifted out of `index.ts`](020-shared-scaffolding-and-pure-logic-lifted-out.md) | — |
| 21 | [Every mutation is recorded](021-every-mutation-is-recorded.md) | — |
| 22 | [`update_thought` and `delete_thought`](022-update-thought-and-delete-thought.md) | — |
| 23 | [A stable agent identity](023-a-stable-agent-identity.md) | — |
| 24 | [A trigram index on `thoughts.content`](024-a-trigram-index-on-thoughts-content.md) | — |
| 25 | [The benchmark corpus was truncated, and nobody knew](025-the-benchmark-corpus-was-truncated-and-nobody.md) | — |
| 26 | [Keyword search](026-keyword-search.md) | — |
| 27 | [Contextual retrieval, measured](027-contextual-retrieval-measured.md) | — |
| 28 | [A filtered search reaches the index](028-a-filtered-search-reaches-the-index.md) | — |
| 29 | [A lease per thought, and the re-embed that proves it](029-a-lease-per-thought-and-the-re-embed.md) | — |
| 30 | [Entities and relationships](030-entities-and-relationships.md) | — |
| 31 | [GraphRAG, measured](031-graphrag-measured.md) | — |
| 32 | [Hybrid ranking](032-hybrid-ranking.md) | — |
| 33 | [An unchanged edit is never a duplicate](033-an-unchanged-edit-is-never-a-duplicate.md) | — |
| 34 | [The head window is recorded on the row](034-the-head-window-is-recorded-on-the-row.md) | — |
| 35 | [Preflight sees an unfinished re-embed](035-preflight-sees-an-unfinished-re-embed.md) | — |
| 36 | [`match_thoughts` reaches the index at the shipped width](036-match-thoughts-reaches-the-index-at-the-shipped.md) | — |
| 37 | [`match_thoughts` blends recency into its ranking](037-match-thoughts-blends-recency-into-its-ranking.md) | — |
| 38 | [A vector carries its model](038-a-vector-carries-its-model.md) | — |
| 39 | [The operator's way to say "I know"](039-the-operator-s-way-to-say-i-know.md) | — |
| 40 | [A re-capture's windows stay while the label vouches for them](040-a-re-capture-s-windows-stay-while-the-label.md) | — |
| 41 | [003's missing half](041-003-s-missing-half.md) | — |
| 42 | [OAuth discovery is a 404](042-oauth-discovery-is-a-404.md) | SMD-1246 |
| 43 | [pgvector off the search path](043-pgvector-off-the-search-path.md) | SMD-1247 |
| 44 | [The read tools print the thought id, so `update_thought` and `delete_thought` can reach what a search found](044-the-read-tools-print-the-thought-id-so-update.md) | SMD-1248 |
| 45 | [`thought_stats` aggregates in SQL](045-thought-stats-aggregates-in-sql.md) | SMD-1249 |
| 46 | [Derivation and supersession: what a thought was built from, and which it replaces](046-derivation-and-supersession-what-a-thought.md) | SMD-1253 |
| 47 | [`trace_provenance` bounds its work, not only its output](047-trace-provenance-bounds-its-work.md) | SMD-1288 |
| 48 | [`search_thoughts` no longer floors long captures out of the results](048-search-thoughts-no-longer-floors-long-captures.md) | SMD-1300 |
| 49 | [The caveat rule is stated at the table](049-the-caveat-rule-is-stated-at-the-table.md) | SMD-1052 |
| 50 | [The chunk limit follows the model's window, not a constant](050-the-chunk-limit-follows-the-model-s-window.md) | SMD-1305 |
| 51 | [Two vendored recipes stop handing untrusted content a shell](051-two-vendored-recipes-stop-handing-untrusted.md) | SMD-1251 |
| 52 | [The PostgREST store maps every row it returns](052-the-postgrest-store-maps-every-row-it-returns.md) | SMD-1040 |
| 53 | [The post-floor recall levers, measured](053-the-post-floor-recall-levers-measured.md) | SMD-1301, SMD-1302, SMD-1304 |
| 54 | [A pass that proposes which thoughts supersede which](054-a-pass-that-proposes-which-thoughts-supersede.md) | SMD-1294 |
| 55 | [Query decomposition, measured](055-query-decomposition-measured.md) | SMD-1318 |
| 56 | [The migrator owns the re-run](056-the-migrator-owns-the-re-run.md) | SMD-1193 |
| 57 | [A lease outlasts a missed heartbeat, not a batch](057-a-lease-outlasts-a-missed-heartbeat-not-a-batch.md) | SMD-1023 |
| 58 | [Vendored SQL stops replacing what the migrations own](058-vendored-sql-stops-replacing-what.md) | SMD-1250 |
| 59 | [Decompose-then-rerank, measured on two corpora](059-decompose-then-rerank-measured-on-two-corpora.md) | SMD-1420 |
| 60 | [`update_thought` takes provenance](060-update-thought-takes-provenance.md) | SMD-1323 |
| 61 | [021's evidence backfill runs with the operator's acceptances out of its sight](061-021-s-evidence-backfill-runs-with-the-operator.md) | SMD-1421 |
| 62 | [A capturing role's grants are documented and checked for the whole capture path, not `thoughts` alone](062-a-capturing-role-s-grants-are-documented.md) | SMD-1226 |
| 63 | [A capture takes the fingerprint lock too](063-a-capture-takes-the-fingerprint-lock-too.md) | SMD-1043 |
| 64 | [The vendored extensions authenticate the way the core server does](064-the-vendored-extensions-authenticate-the-way.md) | SMD-1252 |
| 65 | [An opt-in query log turns real use into a replayable eval, and a CI gate holds a recall floor against the searches people actually ran](065-an-opt-in-query-log-turns-real-use.md) | SMD-1295 |
| 66 | [A re-capture writes no provenance](066-a-re-capture-writes-no-provenance.md) | SMD-1453 |
| 67 | [The vendored recipes and integrations authenticate the way the extensions do](067-the-vendored-recipes-and-integrations.md) | SMD-1455 |
| 68 | [delete_thought joins the writers' lock order, closing a deadlock between an accept and a delete of the superseded thought](068-delete-thought-joins-the-writers-lock-order.md) | SMD-1462 |
| 69 | [The vendored writers of a thought's content and vector go through the functions that own them](069-the-vendored-writers-of-a-thought-s-content.md) | SMD-1228 |
| 70 | [The routing count is gated by a sample of the heap](070-the-routing-count-is-gated-by-a-sample.md) | SMD-1463 |
| 71 | [The vendored captures that inserted a thought go through the 3-argument `upsert_thought`](071-the-vendored-captures-that-inserted-a-thought.md) | SMD-1524 |
| 72 | [A loaded bench corpus outlives the run](072-a-loaded-bench-corpus-outlives-the-run.md) | SMD-1493 |
| 73 | [The SQL shim takes PostgREST's JSON-path column and hands a timestamp back as a string](073-the-sql-shim-takes-postgrest-s-json-path-column.md) | SMD-1544 |
| 74 | [The servers on the SQL shim run under Bun](074-the-servers-on-the-sql-shim-run-under-bun.md) | SMD-1480 |
| 75 | [The MCP endpoint answers GET with 405 before `authenticate()`](075-the-mcp-endpoint-answers-get-with-405-before.md) | SMD-1259 |
| 76 | [The kept bench corpus answers the exact oracle from its marker](076-the-kept-bench-corpus-answers-the-exact-oracle.md) | SMD-1562 |
| 77 | [The SQL shim reads the catalog](077-the-sql-shim-reads-the-catalog.md) | SMD-1588 |
| 78 | [Every vendored MCP server is built for the request, or the session, it answers](078-every-vendored-mcp-server-is-built.md) | SMD-1497 |
| 79 | [The store measured against pgvector, and the second store not built](079-the-store-measured-against-pgvector.md) | SMD-1037 |
| 80 | [The gate's sample is drawn by TID range](080-the-gate-s-sample-is-drawn-by-tid-range.md) | SMD-1526 |
| 81 | [Quantised vector indexes at the shipped width, measured on real vectors](081-quantised-vector-indexes-at-the-shipped-width.md) | SMD-1501 |
| 82 | [LanceDB, the embedded store, measured too](082-lancedb-the-embedded-store-measured-too.md) | SMD-1662 |
| 83 | [The `@hono/mcp` pin moves from 0.1.1 to 0.1.5](083-the-hono-mcp-pin-moves-from-0-1-1-to-0-1-5.md) | SMD-1607 |
| 84 | [The MCP stack moves together](084-the-mcp-stack-moves-together.md) | SMD-1643, SMD-1616 |
| 85 | [A live row an HNSW walk cannot reach is the geometry, not the vacuum](085-a-live-row-an-hnsw-walk-cannot-reach.md) | SMD-1632 |
| 86 | [The read model, measured](086-the-read-model-measured.md) | SMD-1696 |
| 87 | [The composed match, measured](087-the-composed-match-measured.md) | SMD-1707 |
| 88 | [The knowledge-update slice was already reported and is the best one](088-the-knowledge-update-slice-was-already-reported.md) | SMD-1720 |
| 89 | [GraphRAG as an expansion/rerank stage, measured on the *typed* graph and beyond recall](089-graphrag-as-an-expansion-rerank-stage-measured.md) | SMD-1738 |
| 90 | [A capture that cites a returned id is logged as a use of it, and `eval-utilization.ts` reads the query log for the layer every other number here skips](090-a-capture-that-cites-a-returned-id-is-logged.md) | SMD-1719 |
| 91 | [`match_thoughts` runs with `jit = off`](091-match-thoughts-runs-with-jit-off.md) | SMD-1624 |
| 92 | [A NULL `created_at` is `null`, not the fabricated epoch, and a timestamp with no ISO form renders as its own text](092-a-null-created-at-is-null-not-the-fabricated.md) | SMD-1328 |
| 93 | [The community schemas apply on plain Postgres](093-the-community-schemas-apply-on-plain-postgres.md) | SMD-1796 |
| 94 | [`match_thoughts` pins the two planner paths its statements are built around](094-match-thoughts-pins-the-two-planner-paths.md) | SMD-1677, SMD-1703 |
| 95 | [A thought cited as a source cannot be deleted from under the citation](095-a-thought-cited-as-a-source-cannot-be-deleted.md) | SMD-1712 |
| 96 | [The two `created_at` mappers change 92 scoped out take the same rule](096-the-two-created-at-mappers-change-92-scoped-out.md) | SMD-1803 |
| 97 | [The SQL store is the default](097-the-sql-store-is-the-default.md) | SMD-1797 |
| 98 | [The cite shape is stated at the table](098-the-cite-shape-is-stated-at-the-table.md) | SMD-1749 |
| 99 | [The stack publishes one port, on loopback](099-the-stack-publishes-one-port-on-loopback.md) | SMD-1844 |
| 100 | [Two counted surfaces read one typed source instead of drifting by hand](100-two-counted-surfaces-read-one-typed-source.md) | SMD-1805, SMD-1471 |
| 101 | [The chat calls can have an endpoint of their own](101-the-chat-calls-can-have-an-endpoint-of-their.md) | SMD-1902 |
| 102 | [Every knob the server reads reaches the container](102-every-knob-the-server-reads-reaches.md) | SMD-1843 |
| 103 | [Change 69's five servers name the key on 008's audit row](103-change-69-s-five-servers-name-the-key-on-008.md) | SMD-1541 |
| 104 | [A version for the fork, reported by the brain, with a changelog beside the design record](104-a-version-for-the-fork-reported-by-the-brain.md) | SMD-1804 |
| 105 | [The supersession judge has a model of its own](105-the-supersession-judge-has-a-model-of-its-own.md) | SMD-1901 |
| 106 | [Two fork conventions become checks](106-two-fork-conventions-become-checks.md) | SMD-1808 |
| 107 | [Nothing decided which content may leave the box for a model call](107-nothing-decided-which-content-may-leave-the-box.md) | SMD-1903 |
| 108 | [FORK.md is the front door, and every change is one file](108-fork-md-is-the-front-door-and-every-change.md) | SMD-1917 |
| 109 | [The stable brain is a derived view over the records, rebuilt by one tool](109-the-stable-brain-is-a-derived-view-over.md) | SMD-1806 |
| 110 | [The workers, benches, suites and evals are type-checked](110-the-workers-benches-suites-and-evals-are-type.md) | SMD-1932 |
| 111 | [The query log's column set: a filter that is finally written, the arm that served a query, and the tier that wrote it](111-the-query-log-s-column-set-a-filter.md) | SMD-1490 |
| 112 | [The connector taxonomy](112-the-connector-taxonomy.md) | SMD-1933 |
| 113 | [`thought_audit` becomes the log of record](113-thought-audit-becomes-the-log-of-record.md) | SMD-1730 |
| 114 | [The scripts are TypeScript, type-checked where they run](114-the-scripts-are-typescript-type-checked-where.md) | SMD-1870 |
| 115 | [The entity graph answers "what is central about X" from one command](115-the-entity-graph-answers-what-is-central-about-x.md) | SMD-1938 |
| 116 | [A seekable prune index on the query log, and the awaited write measured and kept](116-a-seekable-prune-index-on-the-query-log.md) | SMD-1492 |
| 117 | [Every thought in the dogfood brain labelled by kind](117-every-thought-in-the-dogfood-brain-labelled.md) | SMD-1951 |
| 118 | [`main`'s ruleset becomes a file the tree holds to the workflow](118-main-s-ruleset-becomes-a-file-the-tree-holds.md) | SMD-1856 |
| 119 | [The SQL-safety guard rail is a check](119-the-sql-safety-guard-rail-is-a-check.md) | SMD-1936 |
| 120 | [A landing that changes the fork records itself, and the merge queue is built but refused](120-a-landing-that-changes-the-fork-records-itself.md) | SMD-1857 |
| 121 | [Three shared modules for the tools beside the server](121-three-shared-modules-for-the-tools-beside.md) | SMD-1985 |
| 122 | [The board reaches the brain by a sweep that runs itself](122-the-board-reaches-the-brain-by-a-sweep-that-runs.md) | SMD-1954 |
| 123 | [A release publishes what it names](123-a-release-publishes-what-it-names.md) | SMD-1860 |
| 124 | [Was the confidence earned](124-was-the-confidence-earned.md) | SMD-1809 |
| 125 | [A key that may only add](125-a-key-that-may-only-add.md) | SMD-1298 |
| 126 | [A session leaves one thought behind](126-a-session-leaves-one-thought-behind.md) | SMD-1989, SMD-1298 |
| 127 | [check-fork compares the grants table both ways, and the commit grammar reads a thirteenth pass](127-check-fork-compares-the-grants-table-both-ways.md) | SMD-1990 |
| 128 | [A wrong `OB1_TIER` is caught at boot instead of silently emptying the query log](128-a-wrong-ob1-tier-is-caught-at-boot-instead.md) | SMD-1953 |
| 129 | [The tool-call stream is kept alive for as long as the tool runs, and a client that leaves is logged](129-the-tool-call-stream-is-kept-alive-for-as-long.md) | SMD-1864 |
| 130 | [Retrieval tells what the operator said from what an agent concluded](130-retrieval-tells-what-the-operator-said-from-what.md) | SMD-1726 |
| 131 | [enhanced-mcp's read tools address a thought by its UUID](131-enhanced-mcp-s-read-tools-address-a-thought.md) | SMD-1525 |
| 132 | [The SQL shim answers what PostgREST answers](132-the-sql-shim-answers-what-postgrest-answers.md) | SMD-1602 |
| 133 | [Shim everywhere](133-shim-everywhere.md) | SMD-1798 |
| 134 | [Entity extraction sent the whole thought in one unbounded call](134-entity-extraction-sent-the-whole-thought-in-one.md) | SMD-1879 |
| 135 | [A resuming agent asks what changed since it was last here](135-a-resuming-agent-asks-what-changed-since.md) | SMD-1296 |
| 136 | [The extractor's hedge, graded blind](136-the-extractor-s-hedge-graded-blind.md) | SMD-1982 |
| 137 | [The third layer measured](137-the-third-layer-measured.md) | SMD-1713 |
| 138 | [The session hook captures at checkpoints](138-the-session-hook-captures-at-checkpoints.md) | SMD-2012 |
| 139 | [Bun-native entrypoints](139-bun-native-entrypoints.md) | SMD-1799 |
| 140 | [Every capture source maps to the same five things, the source form is kept and the text and edges are derived from it](140-every-capture-source-maps-to-the-same-five.md) | SMD-1867 |
| 141 | [One renderer and one merge rule for a Linear ticket, whichever tool writes it](141-one-renderer-and-one-merge-rule-for-a-linear.md) | SMD-1958 |
| 142 | [A runaway extraction call ran to its answer budget before it was known to be one](142-a-runaway-extraction-call-ran-to-its-answer.md) | SMD-1960 |
| 143 | [Preflight passed a local model endpoint it never dialled](143-preflight-passed-a-local-model-endpoint-it-never.md) | SMD-1875 |
| 144 | [A ticket's dated sections are thoughts of their own](144-a-ticket-s-dated-sections-are-thoughts-of-their.md) | SMD-2059 |
| 145 | [enhanced-mcp's search tools stop sending the tier and the dates as containment keys](145-enhanced-mcp-s-search-tools-stop-sending.md) | SMD-1986 |
| 146 | [Retire the Edge Function build](146-retire-the-edge-function-build.md) | SMD-1800 |
| 147 | [The incremental replay measured](147-the-incremental-replay-measured.md) | SMD-1998 |
| 148 | [graph-centrality reads the ticket lifecycle board-sync already stamps](148-graph-centrality-reads-the-ticket-lifecycle.md) | SMD-1994 |
| 149 | [A brain says what it is at runtime](149-a-brain-says-what-it-is-at-runtime.md) | SMD-2041 |
| 150 | [FORK.md's index lists numbered changes alone](150-fork-md-s-index-lists-numbered-changes-alone.md) | SMD-2084 |
| 151 | [Three vendored MCP servers' CORS allow-lists name the two headers a browser client sends after initialize](151-three-vendored-mcp-servers-cors-allow-lists-name.md) | SMD-1668 |
| 152 | [The dashboards off Supabase](152-the-dashboards-off-supabase.md) | SMD-1801 |
| 153 | [rest-api's `POST /search` drops restricted thoughts by the column and reads its date bounds as instants, and `GET /recent` takes the tier filter its siblings had](153-rest-api-s-post-search-drops-restricted-thoughts.md) | SMD-2054 |
| 154 | [A typed-decision tier the Jev spikes share](154-a-typed-decision-tier-the-jev-spikes-share.md) | SMD-2050 |
| 155 | [The registry lookup's lock waits are capped and a timed-out lookup is retried briefly, a key it still cannot confirm is refused with a retry, and a revocation the server has read stands through any failure](155-the-registry-lookup-s-lock-waits-are-capped.md) | SMD-2072 |
| 156 | [The writable projection prototyped](156-the-writable-projection-prototyped.md) | SMD-1999 |
| 157 | [Docs and policy off Supabase](157-docs-and-policy-off-supabase.md) | SMD-1802 |
| 158 | [A session's end steps aside for the checkpoint its child is still posting, and supersedes it](158-a-session-s-end-steps-aside-for-the-checkpoint.md) | SMD-2035 |
| 159 | [The workflows name their runner image and pin every action to a commit; Dependabot moves the pins and check 23 holds them](159-the-workflows-name-their-runner-image-and-pin.md) | SMD-2093 |
| 160 | [rest-api sets the request's CORS headers once, on every response the main handler returns, and answers an unlisted origin with no allow-origin header](160-rest-api-sets-the-request-s-cors-headers-once.md) | SMD-2079 |
| 161 | [The event log is the source of truth](161-the-event-log-is-the-source-of-truth.md) | SMD-1997 |
| 162 | [resolve_agent writes a key's row only when the write says something, and a revocation that commits during its wait is answered REVOKED](162-resolve-agent-writes-a-key-s-row-only-when.md) | SMD-2090 |
| 163 | [The extension and recipe schemas apply on plain Postgres](163-the-extension-and-recipe-schemas-apply-on-plain.md) | SMD-1810 |
| 164 | ["Schema migrations" runs test-schema.ts at both embedding widths at once, not one after the other](164-schema-migrations-runs-test-schema-ts-at-both.md) | SMD-2092 |
| 165 | [One thought per episode of a session, not per session](165-one-thought-per-episode-of-a-session-not-per.md) | SMD-2013 |
| 166 | [rest-api's ingest proxy and smart-ingest's extraction trigger read their upstream from a URL variable of their own, http(s) only](166-rest-api-s-ingest-proxy-and-smart-ingest.md) | SMD-2110 |
| 167 | [`deploy/tier.sh` + `db/tier.Dockerfile` make `tier.ts --refresh` runnable; refresh marks its targets and refuses its source, a brain, or a stranger](167-deploy-tier-sh-db-tier-dockerfile-make-tier-ts.md) | SMD-2036 |
| 168 | [test-schema.ts loads its match_thoughts fixtures without the HNSW index and builds it after](168-test-schema-ts-loads-its-match-thoughts-fixtures.md) | SMD-2097 |
| 169 | [The PostgREST-speaking recipe scripts are decided](169-the-postgrest-speaking-recipe-scripts-are.md) | SMD-2126 |
| 170 | [smart-ingest's write path is the fork's](170-smart-ingest-s-write-path-is-the-fork.md) | SMD-2128 |
| 171 | [A typed-decision gate after the entity extractor, measured on the cases a regex cannot judge](171-a-typed-decision-gate-after-the-entity-extractor.md) | SMD-1937 |
| 172 | [An opt-in model-written session summary](172-an-opt-in-model-written-session-summary.md) | SMD-2014 |
| 173 | [test-live.ts stops waiting on clocks it does not test](173-test-live-ts-stops-waiting-on-clocks-it-does.md) | SMD-2135 |
| 174 | [graph-centrality reads the dependency edges 053 already stores](174-graph-centrality-reads-the-dependency-edges-053.md) | SMD-2061 |
| 175 | [The capture event carries the payload](175-the-capture-event-carries-the-payload.md) | SMD-2115 |
| 176 | [The pipeline takes ingestion-contract items from a file](176-the-pipeline-takes-ingestion-contract-items-from.md) | SMD-2136 |
| 177 | [Tool refusals carry a machine-readable code; the session hook reads the code, not the server's prose](177-tool-refusals-carry-a-machine-readable-code.md) | SMD-1978 |
| 178 | [The orchestration tool is n8n](178-the-orchestration-tool-is-n8n.md) | SMD-1863 |
| 179 | [The entity graph refuses a number or a type word the extractor names and retypes an identifier-shaped person or place, at the writer and over the rows before it; the people facet takes the same rule](179-the-entity-graph-refuses-a-number-or-a-type-word.md) | SMD-1935 |
| 180 | [graph-centrality --decay-blocked sinks a blocked open thought to a pre-registered 0.25 instead of dropping it, and names its blockers](180-graph-centrality-decay-blocked-sinks-a-blocked.md) | SMD-2181 |
| 181 | [The session-capture hook blanks a secret and sends the summary, where one key refused the whole episode](181-the-session-capture-hook-blanks-a-secret.md) | SMD-2127 |
| 182 | [`deploy/canary.sh` stands a canary beside a running stack and takes it down again; a refresh copies the source's database settings](182-deploy-canary-sh-stands-a-canary-beside.md) | SMD-2038, SMD-2037 |
| 183 | [A `source:` egress term gates a row's stored label, not who may capture](183-a-source-egress-term-gates-a-row-s-stored-label.md) | SMD-1941 |
| 184 | [The Obsidian vault import recipe retires](184-the-obsidian-vault-import-recipe-retires.md) | SMD-2137 |
| 185 | [A --grant role can run the entity writer and a structured pass](185-a-grant-role-can-run-the-entity-writer.md) | SMD-2216 |
| 186 | [The session-capture hook records how many secrets it blanked on the thought itself, in `metadata.redactions`, where before the count lived only in the log and the text's markers](186-the-session-capture-hook-records-how-many.md) | SMD-2168 |
| 187 | [graph-centrality's dependency read gates only on a system that states a lifecycle](187-graph-centrality-s-dependency-read-gates.md) | SMD-2218 |
| 188 | [The data-layer job runs test-upgrade and test-preflight side by side](188-the-data-layer-job-runs-test-upgrade-and-test.md) | SMD-2219 |
| 189 | [The local-Ollama embedding recipe retires](189-the-local-ollama-embedding-recipe-retires.md) | SMD-2138 |
| 190 | [The MCP route answers a refused notification per spec: 202/503 with no body, not a dropped 200 envelope](190-the-mcp-route-answers-a-refused-notification-per.md) | SMD-2106 |
| 191 | [`tier.ts --diff` exits 3 on a window it replayed nothing from, and says which side failed to connect](191-tier-ts-diff-exits-3-on-a-window-it-replayed.md) | SMD-2182 |
| 192 | [a cross-brain compare](192-a-cross-brain-compare.md) | SMD-2109 |
| 193 | [Preflight reads a table off the role's path in one row, not the block](193-preflight-reads-a-table-off-the-role-s-path.md) | SMD-2062 |
| 194 | [rest-api holds every paging parameter to a finite integer, and a non-object body to a 400](194-rest-api-holds-every-paging-parameter.md) | SMD-2083 |
| 195 | [test-live.ts sizes \[5d\]'s and \[5f\]'s tables to what their planner decisions need](195-test-live-ts-sizes-5d-s-and-5f-s-tables-to-what.md) | SMD-2135 |
| 196 | [node_state: a thought's lifecycle, blockers and supersession are one SQL read every ranking surface shares, and graph-centrality is its first reader](196-node-state-a-thought-s-lifecycle-blockers.md) | SMD-2074 |
| 197 | [`list_thought_ids`](197-list-thought-ids.md) | SMD-2244 |
| 198 | [A thought over the extraction bound is extracted over its prefix, not failed](198-a-thought-over-the-extraction-bound-is-extracted.md) | SMD-2240 |
| 199 | [n8n as an opt-in `orchestration` profile](199-n8n-as-an-opt-in-orchestration-profile.md) | SMD-2210 |
| 200 | [preflight's ledger row, and `migrate.ts --baseline`, no longer offer to baseline an empty database](200-preflight-s-ledger-row-and-migrate-ts-baseline.md) | SMD-2237 |
| 201 | [`list_logged_searches`](201-list-logged-searches.md) | SMD-2245 |
| 202 | [The two read-only recipe scripts move onto the SQL shim](202-the-two-read-only-recipe-scripts-move-onto.md) | SMD-2144 |
| 203 | [search_thoughts' prefer_current ranks finished and replaced work below live work, opt-in, priced before it was built](203-search-thoughts-prefer-current-ranks-finished.md) | SMD-2255 |
| 204 | [The server and the Kubernetes image stop on SIGTERM, finishing what is in flight](204-the-server-and-the-kubernetes-image-stop.md) | SMD-2250 |
| 205 | [The write functions append then project](205-the-write-functions-append-then-project.md) | SMD-2116 |
| 206 | [`worker_status`](206-worker-status.md) | SMD-2131 |
| 207 | [Preflight's `schema` row prints the exact search-path statement](207-preflight-s-schema-row-prints-the-exact-search.md) | SMD-2242 |
| 208 | [The extractor's precision on long documents is now measured against a real labelled set, not the three-document planted one](208-the-extractor-s-precision-on-long-documents.md) | SMD-1961 |
| 209 | [decider-4b behind the one typed-decision contract, and the tooling to compare Jev-class models on the same client](209-decider-4b-behind-the-one-typed-decision.md) | SMD-2052 |
| 210 | [A runaway extraction call escalates to a larger local model instead of the penalised retry](210-a-runaway-extraction-call-escalates-to-a-larger.md) | SMD-2000 |
| 211 | [A malformed window is left out of a windowed thought, not the thought](211-a-malformed-window-is-left-out-of-a-windowed.md) | SMD-2260 |
| 212 | [`retry_failed` and `release_stale_leases`](212-retry-failed-and-release-stale-leases.md) | SMD-2132 |
| 213 | [The full-stack job builds the three dashboards in the background while the stack comes up, not in series after it](213-the-full-stack-job-builds-the-three-dashboards.md) | SMD-2251 |
| 214 | [The thought-enrichment backfills move onto the SQL shim](214-the-thought-enrichment-backfills-move-onto.md) | SMD-2139 |
| 215 | [Lineage for every derived artifact, with its recipe: the `derivations` table every producer writes in its artifact's transaction](215-lineage-for-every-derived-artifact.md) | SMD-1731 |
| 216 | [Preflight's remedies for a refusal or a hidden column: the `schema` row reads the SQLSTATE, three column checks read `pg_attribute`, the `vector extension` row prints the `schema` row's statement](216-preflight-s-remedies-for-a-refusal-or-a-hidden.md) | SMD-2238 |
| 217 | [`rebuild_derived`](217-rebuild-derived.md) | SMD-1732 |
| 218 | [The first n8n templates](218-the-first-n8n-templates.md) | SMD-2212 |
| 219 | [One flag scanner for every db/ script](219-one-flag-scanner-for-every-db-script.md) | SMD-2134, SMD-2015 |
| 220 | [The page store](220-the-page-store.md) | SMD-1812 |
| 221 | [server-portable moves to the MCP TypeScript SDK v2](221-server-portable-moves-to-the-mcp-typescript-sdk.md) | SMD-2278 |
| 222 | [The entity name gate as a good-shape allowlist: a high-precision identifier shape (migration 065) overrides the model's type for any type, not just a person or place](222-the-entity-name-gate-as-a-good-shape-allowlist.md) | SMD-2300 |
| 223 | [A derivation and its inputs are never paired for judgement](223-a-derivation-and-its-inputs-are-never-paired.md) | SMD-2292 |
| 224 | [The consolidation pass settles a stale proposal it no longer finds in conflict, and a pass-settled row is the pass's to reopen](224-the-consolidation-pass-settles-a-stale-proposal.md) | SMD-2297 |
| 225 | [node_state reads two tables kept current on write, so prefer_current costs its window, not the corpus](225-node-state-reads-two-tables-kept-current.md) | SMD-2256 |
| 226 | [server-portable can return a job handle instead of blocking](226-server-portable-can-return-a-job-handle-instead.md) | SMD-2273 |
| 227 | [The propose→decide spike: a deterministic entity proposer and the three-shape comparison](227-the-propose-to-decide-spike-a-deterministic.md) | SMD-2017 |
| 228 | [the async job registry survives a restart](228-the-async-job-registry-survives-a-restart.md) | SMD-2318 |
| 229 | [Hybrid entity extraction](229-hybrid-entity-extraction.md) | SMD-2321 |
| 230 | [The grading report's proposal dates go through one day renderer, `isoDay`: `2026-09-09`, not `Wed Sep 09`](230-the-grading-report-s-proposal-dates-go-through.md) | SMD-1842 |
| 231 | [One connection module for every db/ script](231-one-connection-module-for-every-db-script.md) | SMD-2302, SMD-2134 |
| 232 | [The migrator and the tier refresh read a search_path with preflight's parser](232-the-migrator-and-the-tier-refresh-read-a-search.md) | SMD-2247 |
| 233 | [A run whose model looks at fault says so and exits 3](233-a-run-whose-model-looks-at-fault-says.md) | SMD-2266 |
| 234 | [Thought genre at capture](234-thought-genre-at-capture.md) | SMD-2323 |
| 235 | [A proposal standing on a lineage pair is visible as such](235-a-proposal-standing-on-a-lineage-pair-is-visible.md) | SMD-2313 |
| 236 | [`run_worker` dry_run](236-run-worker-dry-run.md) | SMD-2272 |
| 237 | [The import runner's hardening](237-the-import-runner-s-hardening.md) | SMD-2289 |
| 238 | [The reset guards ask the connection, not the URL, and the libpq tools never parse it](238-the-reset-guards-ask-the-connection-not-the-url.md) | SMD-2317 |
| 239 | [Reference-list windows: measure the failure shape and the two candidate fixes](239-reference-list-windows-measure-the-failure-shape.md) | SMD-2269 |
| 240 | [migrate.ts and extract-entities.ts are engines: import one and call run()](240-migrate-ts-and-extract-entities-ts-are-engines.md) | SMD-2304, SMD-2134 |
| 241 | [node_state's dependency columns read the ids asked for: the gate stored, the links probed](241-node-state-s-dependency-columns-read-the-ids.md) | SMD-2267 |
| 242 | [The authorization server's proof of concept: oidc-provider on Bun proves criteria 1–5. Its outbound fetches go through a guard of our own, because the library's SSRF protection does not load under Bun, and the library's open defaults are closed](242-the-authorization-server-s-proof-of-concept-oidc.md) | SMD-2285 |
| 243 | [consolidate.ts and reembed.ts are engines: import one and call run(); the workers' numbers held to what the database takes](243-consolidate-ts-and-reembed-ts-are-engines-import.md) | SMD-2304, SMD-2134 |
| 244 | [The weekly-digest sink becomes a `db/` verb behind the egress gate](244-the-weekly-digest-sink-becomes-a-db-verb-behind.md) | SMD-2239 |
| 245 | [The authorization server's proof of concept, second leg: the runner-up, Better Auth 1.7.6, through the same 32 checks as oidc-provider, the winner's pages made unframeable, and the winning server moved to `deploy/auth/` and deployed as the `auth` compose profile with a SQLite store, its registration capped and purged](245-the-authorization-server-s-proof-of-concept.md) | SMD-2285 |
| 246 | [brain-smoke-test retires into deploy/smoke.sh, whose first check now reads the refusal instead of trusting the 200](246-brain-smoke-test-retires-into-deploy-smoke-sh.md) | SMD-2103 |
| 247 | [The content's trust on the row, read back on every thought a tool returns](247-the-content-s-trust-on-the-row-read-back.md) | SMD-1724 |
| 248 | [Every tool runs on a transport-free core and answers a typed result beside its text](248-every-tool-runs-on-a-transport-free-core.md) | SMD-2283 |
| 249 | [The SIGTERM steps judge the stop, not the runner's `docker stop`](249-the-sigterm-steps-judge-the-stop-not-the-runner.md) | SMD-2316 |
| 250 | [One origin for the stack](250-one-origin-for-the-stack.md) | SMD-1846 |
| 251 | [A stop during a provider-error pause returns the thought to the pool, not as a failed row](251-a-stop-during-a-provider-error-pause-returns.md) | SMD-2401 |
| 252 | [Blank options and the hard-stop lapse in extract and consolidate, as reembed since SMD-2304 PR 4](252-blank-options-and-the-hard-stop-lapse-in-extract.md) | SMD-2425 |
| 253 | [The pass's report beside a review is refused](253-the-pass-s-report-beside-a-review-is-refused.md) | SMD-2405 |
| 254 | [A thought's text is fenced in the prose read tools, so it cannot forge a result block](254-a-thought-s-text-is-fenced-in-the-prose-read.md) | SMD-2483 |
| 255 | [A REST core answers every MCP operation as JSON over the same core, authorized by the key, internal unless the operator opens /api](255-a-rest-core-answers-every-mcp-operation-as-json.md) | SMD-2284 |
| 256 | [Abuse limits: the authorization server sets its own, and `/mcp` takes none by design](256-abuse-limits-the-authorization-server-sets.md) | SMD-2309 |
| 257 | [A thought's metadata prints on one line in every reply, so it cannot forge a result block](257-a-thought-s-metadata-prints-on-one-line-in-every.md) | SMD-2510 |
| 258 | [prefer_current reads the tickets a thought is about, not only its own lifecycle](258-prefer-current-reads-the-tickets-a-thought.md) | SMD-2271 |
| 259 | [The root connector URL gets a compatibility window that closes with 2.0.0](259-the-root-connector-url-gets-a-compatibility.md) | SMD-2306 |
| 260 | [A supersession proposal's judge reason and review note print on one line each, so neither can forge an `ID:` line](260-a-supersession-proposal-s-judge-reason.md) | SMD-2533 |
| 261 | [The judge's reason is stored on one line, by the rule the replies print it with](261-the-judge-s-reason-is-stored-on-one-line.md) | SMD-2536 |
| 262 | [The MCP server's half of the public origin](262-the-mcp-server-s-half-of-the-public-origin.md) | SMD-2382 |
| 263 | [Two tickets Linear links are never paired for judgement](263-two-tickets-linear-links-are-never-paired.md) | SMD-2448 |
| 264 | [A capture-only key's supersedes is no existence oracle](264-a-capture-only-key-s-supersedes-is-no-existence.md) | SMD-2473 |
| 265 | [The board-sync watermark reaches the record and the compare, and long-running workers report their liveness](265-the-board-sync-watermark-reaches-the-record.md) | SMD-2261 |
| 266 | [Ollama's repeat limit is a runaway, not a provider outage](266-ollama-s-repeat-limit-is-a-runaway.md) | SMD-2449 |
| 267 | [The tier stack on proxy paths](267-the-tier-stack-on-proxy-paths.md) | SMD-2294 |
| 268 | [A `Host` the URL parser refuses, or none](268-a-host-the-url-parser-refuses-or-none.md) | SMD-2535 |
| 269 | [A capture-only key's re-capture leaves the row it lands on](269-a-capture-only-key-s-re-capture-leaves-the-row.md) | SMD-2539 |
| 270 | [The seven vendored servers that read their URL answer a `Host` the URL parser refuses, or none, as `localhost` gets answered, not with a 500; a hang-up mid-upload no longer leaves a request pending](270-the-seven-vendored-servers-that-read-their-url.md) | SMD-2595 |
| 271 | [Preflight's pass rows read the leases and the heartbeats](271-preflight-s-pass-rows-read-the-leases.md) | SMD-2423 |
| 272 | [A capture-only key cannot state a ticket's lifecycle](272-a-capture-only-key-cannot-state-a-ticket.md) | SMD-2617 |
| 273 | [A `--follow` worker outlasts a database or provider outage](273-a-follow-worker-outlasts-a-database-or-provider.md) | SMD-2599 |
| 274 | [The authorization server answers an absolute-form request target 400 instead of stopping, and a throw in a request is that request's 500](274-the-authorization-server-answers-an-absolute.md) | SMD-2615 |
| 275 | [Extraction and consolidation run as opt-in services](275-extraction-and-consolidation-run-as-opt.md) | SMD-2424 |
| 276 | [A capture-only key's thought stops being its own once another key or board-sync takes it, a pointer it wrote onto it lapses, and its pointer is re-checked at its own write](276-a-capture-only-key-s-thought-stops-being-its-own.md) | SMD-2638 |
| 277 | [A peer's odd status can no longer stop the authorization server, and a throw in a function its own code hands on is logged, not the process's end](277-a-peer-s-odd-status-can-no-longer-stop.md) | SMD-2665 |
| 278 | [The MCP tools and the REST core's operations are two projections of one contract, held by a test that reads both surfaces as a client does, and the REST gateways and three vendored MCP servers retire against it](278-the-mcp-tools-and-the-rest-core-s-operations-are.md) | SMD-1931 |
| 279 | [A capture-only key is refused `metadata.ticket`](279-a-capture-only-key-is-refused-metadata-ticket.md) | SMD-2657 |
| 280 | [A vendored MCP server's slow tool call is answered, not reset](280-a-vendored-mcp-server-s-slow-tool-call.md) | SMD-2001 |
| 281 | [The consolidation judge stops proposing related tickets as supersessions](281-the-consolidation-judge-stops-proposing-related.md) | SMD-1873 |
| 282 | [The proxy's route tables carry no comment and are held byte for byte](282-the-proxy-s-route-tables-carry-no-comment.md) | SMD-2658 |
| 283 | [The sleep scheduler, `db/sleep.ts`: extraction and consolidation while the brain is quiet, yielding on the first live call](283-the-sleep-scheduler-db-sleep-ts-extraction.md) | SMD-1794 |
| 284 | [canary.sh reads a port's bound address from the binding's JSON, which both runtimes spell `HostIp`, so `--runtime podman` stands a path-mode canary](284-canary-sh-reads-a-port-s-bound-address-from.md) | SMD-2677 |
| 285 | [kubernetes-deployment's provider calls end at OB1_LLM_TIMEOUT, and a failed chat call costs a capture its tags, not the capture, as on the core server](285-kubernetes-deployment-s-provider-calls-end.md) | SMD-2692 |
| 286 | [canary.sh names a connector at the root of the canary's own port as on the deprecated root, not as one the canary no longer answers](286-canary-sh-names-a-connector-at-the-root.md) | SMD-2661 |
| 287 | [Each request to either server but the keyless liveness probe leaves one JSON line, from an allow-list, and a span, a metric point and a log record where a collector is named, and no container's log grows without bound](287-each-request-to-either-server-but-the-keyless.md) | SMD-1849 |
| 288 | [The session-capture hook's --check warns while its url is on the deprecated root](288-the-session-capture-hook-s-check-warns-while.md) | SMD-2686 |
| 289 | [Plugins in the REST core](289-plugins-in-the-rest-core.md) | SMD-2310 |
| 290 | [Only the proxy's backends answer it](290-only-the-proxy-s-backends-answer.md) | SMD-2685 |
| 291 | [recipes/ and integrations/ resolve extensions/' pinned install through committed node_modules links, and test-auth starts their servers under --no-install](291-recipes-and-integrations-resolve-extensions.md) | SMD-1991 |
| 292 | [bench-hnsw.ts section F: `match_thoughts` under concurrency](292-bench-hnsw-ts-section-f-match-thoughts-under.md) | SMD-1500 |
| 293 | [The session-capture hook's url: the slash on the path, a ?key= refused unechoed, query values masked when printed](293-the-session-capture-hook-s-url-the-slash.md) | SMD-2743 |
| 294 | [A capture-only key's stamp yields to the first classified key that can read to re-capture the text, at a higher trust](294-a-capture-only-key-s-stamp-yields-to-the-first.md) | SMD-2664 |
| 295 | [A plugin's webhook refuses replays: a timestamped signature, and a delivery's id run once](295-a-plugin-s-webhook-refuses-replays-a-timestamped.md) | SMD-2755 |
| 296 | [The network move](296-the-network-move.md) | SMD-2583 |
| 297 | [The compose stack comes back after a reboot: Postgres and Ollama restart unless-stopped, every policy held, podman's boot unit documented](297-the-compose-stack-comes-back-after-a-reboot.md) | SMD-2760 |
| 298 | [brain_info, keyed /health and preflight report the proposal queue and the standing judged relations, so a sleep pass's findings are seen without a query](298-brain-info-keyed-health-and-preflight-report.md) | SMD-2680 |
| 299 | [The webhook delivery-id memory is the SDK's `onceById`, its lease sized from the core's own model-call deadline](299-the-webhook-delivery-id-memory-is-the-sdk.md) | SMD-2768 |
| 300 | [The server sized for the table](300-the-server-sized-for-the-table.md) | SMD-1499 |
| 301 | [The operator resets a capture-only key's settled or moved label](301-the-operator-resets-a-capture-only-key-s-settled.md) | SMD-2744 |
| 302 | [A plugin webhook answers before its capture finishes: `ctx.defer`, owned by the runtime, and `onceById`'s `defer`](302-a-plugin-webhook-answers-before-its-capture.md) | SMD-2767 |
| 303 | [Consolidation findings between two unlinked tickets are posted as one Linear comment on the newer ticket, opt-in, capped and through the egress gate](303-consolidation-findings-between-two-unlinked.md) | SMD-2681 |
| 304 | [Preflight's resident-memory row leaves out a staging index 039 is about to adopt, and says so](304-preflight-s-resident-memory-row-leaves-out.md) | SMD-2871 |
| 305 | [The sleep scheduler runs as an opt-in compose service, beside which the workers profile may not run, with its own preflight row and an opt-in grant for the query log it wakes on](305-the-sleep-scheduler-runs-as-an-opt-in-compose.md) | SMD-2678 |
| 306 | [Preflight's walk index remedy runs 039 through the migrator, after the steps 039's own decisions call for](306-preflight-s-walk-index-remedy-runs-039-through.md) | SMD-2880 |
| 307 | [The sleep scheduler survives a database restart at any sleep, checks each pass's start once before its first quiet, says each banner once, ends on a start refusal no retry mends, and says on its row a pass waiting for the provider and the refusal that ended it](307-the-sleep-scheduler-survives-a-database-restart.md) | SMD-2752 |
| 308 | [A base URL's user and password are its endpoint's Basic credential, on every Bun](308-a-base-url-s-user-and-password-are-its-endpoint.md) | SMD-2885 |
| 309 | [Bun 1.4.3 everywhere, every pin held to one version; brain-compare and n8n provisioning send a URL's user and password as Basic on every Bun](309-bun-1-4-3-everywhere-every-pin-held-to-one.md) | SMD-2894 |
| 310 | [Every suite is run: the weekly digest's and the job registry's suites in CI, and check 34 holds every `test-*` script to a workflow step or a stated reason](310-every-suite-is-run-the-weekly-digest.md) | SMD-2895 |
| 311 | [ci-parity.sh runs what CI runs, held to the workflow both ways by check 35](311-ci-parity-sh-runs-what-ci-runs-held.md) | SMD-2903 |
| 312 | [The REST core's typed client, and a forwarded refusal that carries its own words](312-the-rest-core-s-typed-client-and-a-forwarded.md) | SMD-2287 |
| 313 | [What became of each finding posted to the board, and the acceptance rate, from the brain alone](313-what-became-of-each-finding-posted-to-the-board.md) | SMD-2682 |
| 314 | [A re-capture says what it did to a capture-only key's label](314-a-re-capture-says-what-it-did-to-a-capture.md) | SMD-2898 |
| 315 | [A board-finding comment says each relation word once, in its best finding's direction, with how many row pairs back it and how many read it the other way](315-a-board-finding-comment-says-each-relation-word.md) | SMD-2930 |
| 316 | [The MCP server as a client of the REST core, and the REST core's keyed /health](316-the-mcp-server-as-a-client-of-the-rest-core.md) | SMD-2287 |
| 317 | [One env file is one brain: the scripts take the instance's project, not `open-brain`](317-one-env-file-is-one-brain-the-scripts-take.md) | SMD-2873 |
| 318 | [The board-findings poster skips pairs of closed tickets and comments on the open side](318-the-board-findings-poster-skips-pairs-of-closed.md) | SMD-2932 |
| 319 | [A settle by the pass survives 067's reopen](319-a-settle-by-the-pass-survives-067-s-reopen.md) | SMD-2913 |
| 320 | [An `observability` compose profile](320-an-observability-compose-profile.md) | SMD-1849 |
| 321 | [A ticket a thought no longer tells right, priced, given its inputs, then labelled on both searches: the eval, its verdict, migration 095 and the label](321-a-ticket-a-thought-no-longer-tells-right-priced.md) | SMD-2540 |
| 322 | [A capture-only key's thought is taken while its supersedes chain reaches another's](322-a-capture-only-key-s-thought-is-taken-while.md) | SMD-2708 |
| 323 | [A capture survives its provider's outage](323-a-capture-survives-its-provider-s-outage.md) | SMD-2888 |
| 324 | [A long thought's answered windows survive a stop](324-a-long-thought-s-answered-windows-survive-a-stop.md) | SMD-2694 |
| 325 | [A proposal's review names who wrote each side, and flags a capture-only key's or lower-trust side proposed to stand](325-a-proposal-s-review-names-who-wrote-each-side.md) | SMD-2707, SMD-2480 |
| 326 | [db/bench-live.ts](326-db-bench-live-ts.md) | SMD-3024 |
| 327 | [Tier tools without joining another brain's networks](327-tier-tools-without-joining-another-brain.md) | SMD-2875 |
| 328 | [The canary is a brain on a port of its own with keys of its own](328-the-canary-is-a-brain-on-a-port-of-its-own.md) | SMD-2874, SMD-3032 |
| 329 | [A capture made during a sleep goes ahead of the stalled thought](329-a-capture-made-during-a-sleep-goes-ahead.md) | SMD-3008 |
| 330 | [The edge proxy, its own project in front of several brains: routed by host, reaching each brain's published port, in one shape per runtime](330-the-edge-proxy-its-own-project-in-front.md) | SMD-2876 |
| 331 | [One definition for 082's lapse: the trigger clears what `ob1_lapse_walk` returns, and the review listing's read returns it](331-one-definition-for-082-s-lapse-the-trigger.md) | SMD-3035 |
| 332 | [Fork Checks' full-stack job split three ways by what each group of steps stands up](332-fork-checks-full-stack-job-split-three-ways.md) | SMD-3051 |
| 333 | [The servers give a thought saved without a vector its vector, by themselves](333-the-servers-give-a-thought-saved-without.md) | SMD-2889 |
| 334 | [Stable's tier routes deprecated before v2.0.0 removes them](334-stable-s-tier-routes-deprecated-before-v2-0-0.md) | SMD-3057 |
| 335 | [Fork Checks' live suite in four shards, one job each: "Schema against real Postgres" was the run's critical path](335-fork-checks-live-suite-in-four-shards-one-job.md) | SMD-3048 |
| 336 | [An unlink takes the review lock: `update_thought` takes `ob1:supersession-review` whenever its envelope names `supersedes`, a clear included](336-an-unlink-takes-the-review-lock-update-thought.md) | SMD-3045 |
| 337 | [The REST core accepts the authorization server's tokens](337-the-rest-core-accepts-the-authorization-server.md) | SMD-2286 |
| 338 | [The consolidation judge keeps every pair](338-the-consolidation-judge-keeps-every-pair.md) | SMD-3058 |
| 339 | [The thoughts with no vector by an index of their own](339-the-thoughts-with-no-vector-by-an-index-of-their.md) | SMD-3056 |
| 340 | [H2O decides supersession and an LLM writes only the proposal](340-h2o-decides-supersession-and-an-llm-writes.md) | SMD-3114 |
| 341 | [The sleep scheduler's own cuts of a stalled thought are counted apart from its stops, so the held word says the wakes and orders by them](341-the-sleep-scheduler-s-own-cuts-of-a-stalled.md) | SMD-3060 |
| 342 | [Consolidation's decide mode: the typed-decision tier gives each pair's verdict and the judge's model writes only the proposals it calls outdates, adopted from SMD-3114's measurement for review on the canary](342-consolidation-s-decide-mode-the-typed-decision.md) | SMD-3115 |
| 343 | [The consolidation judge's distinct is stored: 084's relation vocabulary gains `distinct`, so a pair the judge calls unrelated is a standing relation on the newer thought](343-the-consolidation-judge-s-distinct-is-stored-084.md) | SMD-3117 |
| 344 | [\[38\]'s mid-read stop is named and checked for where its pass is: in its start, before its probe; it no longer holds each probe 4 s](344-38-s-mid-read-stop-is-named-and-checked.md) | SMD-3106 |

Changes landed since the last release, if any, are the `smd-*.md` files in this directory, numbered at the next cut (SMD-1804).
<!-- changes-index:end -->
