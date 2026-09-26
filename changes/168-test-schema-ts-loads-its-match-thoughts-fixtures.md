# 168. test-schema.ts loads its match_thoughts fixtures without the HNSW index and builds it after — 70 s of a run down to 14 s (SMD-2097)

**What changed.** One helper, `withoutWalkIndex(body)`, reads `thoughts_embedding_idx`'s definition with `pg_get_indexdef`, drops the index, runs `body`, and rebuilds the index from that definition in a `finally`. The first definition it reads, before [8c] drops anything, is kept as the shipped one.

The fixture loads run inside it:
- [8c]: 1,201 rows;
- [8d]: 1,505 rows, 305 with a vector;
- [8e]: 1,000 rows.

Each body opens with the section's own `DELETE FROM thoughts`, and [8e]'s with the VACUUM that compacts its heap. The inserts are unchanged.

[8e] calls it a second time around its eight-page band and everything after, since from there on the section reads only the heap: the pinned probe, its buffer count and the random draws. That body ends by deleting the rows, which [9] deletes anyway, so the rebuild is over an empty table.

Two checks were folded into existing assertions, so the total doesn't move:
- [8e]'s last assertion now compares the index with the shipped definition, whole.
- Its page assertion also counts the fixture's 1,000 rows, which checks the load's DELETE.

Every row, seed and quoted count is unchanged, and the suite stays at 1625 assertions at each width.

**Why.** The ticket listed three candidates: HNSW maintenance per row, the write triggers, and one statement per row. The loads were already multi-row `INSERT … VALUES` in batches of 100. A probe loaded [8c]'s 1,200 rows at 1024 dims into a migrated PGlite:

| Load | Insert time |
| --- | --- |
| As shipped | 28.6 s |
| Triggers off (`session_replication_role = replica`) | 28.9 s |
| HNSW index dropped | 1.2 s |
| HNSW dropped, triggers off | 1.2 s |
| Index rebuilt over the 1,200 rows | 4.8 s |

Generating the vectors in JS took 0.1 s. A per-statement timer over one whole run at 1024 showed two more costs of the growing graph:
- [8d]'s three 100-row inserts took 3.9, 3.8 and 3.6 s. [8c]'s rows were deleted but never vacuumed, so the graph still held 1,201 dead nodes that every insert walked.
- [8e]'s band `VACUUM` took 6.8 s, repairing the graph around the band's 520 deleted rows. The band holds 520 rows at both widths. pgvector's `external` storage moves a vector of about 512 dims or more out of the row, so the heap is 16 pages either way.

The ticket's fourth load, "the vacuum band", is that VACUUM.

**Held.** The suite before and after this change ran side by side on an 18-core Mac, at both widths, four runs at once. The normalised logs (UUIDs, timestamps and xmin values masked) differ in the two reworded assertions, the page count's and the final restore's. Otherwise they differ only in lines that also differ between two runs of the original:
- [8e]'s random sample draws;
- ties ordered by random UUIDs;
- recency scores read off the clock;
- one audit feed that sorts a shared `created_at` by id;
- the order of three equal-weight board rows.

[8c]'s overlap reads 30/30 in both versions at both widths. Four more runs at each width, all at once, all passed 1625/1625 with overlap 30. Mutants, run against this tree at 1024:

| Mutant | Result |
| --- | --- |
| The walk drops its metadata filter | "…every one of them matching the filter" fails, and overlap drops to 24 |
| The walk returns 5 candidates in place of `v_fetch` | "the walk returns 10 rows" fails, with 15 returned |
| [8e]'s probe join is INNER, not LEFT | the pinned probe over the emptied band "draws 0 pages" (this runs after the index is dropped) |
| The probe's upper bound is `<=` | the probe "touches 16 buffers", also after the drop |
| The routing collection counts unscoreable rows | only the two source-text checks fail |
| The helper never rebuilds the index | the suite stops at [8d], where the next call finds no `thoughts_embedding_idx` to read |
| [8e]'s band never rebuilds it | before review pass 1 this passed 1625/1625, because 039's reapply in a later section builds the index silently; now "…and the walk's index are back" fails, naming "index: none" |
| Every rebuild adds `WITH (m = 4)` | passed [8e]'s read-back while that compared with the definition [8e]'s own load read, which was [8d]'s rebuild; since review pass 3 it compares with the shipped definition and fails, quoting the index |
| [8e]'s load doesn't empty the table | before review pass 1 this passed, as it does on origin/main; now the page assertion fails with 2,505 rows on 39 pages |

The routing-collection mutant behaves the same on origin/main. [8d]'s own assertion was never able to catch it, because without `ANALYZE` the planner answers the filtered walk with the GIN bitmap and a sort, so the one-tuple clamp on HNSW never applies. After `ANALYZE thoughts` the same statement plans as `Index Scan using thoughts_embedding_idx`. Dropping the index around each section's queries shows the same thing directly:
- [8d]'s check and [8e]'s two agreement checks pass with no index at all.
- [8c]'s assertions all passed too, and its overlap of 30 is an exact sort's.

That gap predates this change and is filed as SMD-2151, which covers [8c] and [8d] and asks the same question of [8e]. So the rebuilds serve no behavioural assertion. They keep the shipped state for the sections after, which [8e]'s last assertion reads back, and keep the walk's index in place for when SMD-2151 makes it reachable. CREATE INDEX also refreshes the table's `relpages` and `reltuples`, and growing the index row by row never did, so the planner sees different inputs before these calls. The outcomes don't change.

[9] inherits two differences, and neither is read before [9]'s own DELETE:
- The table is empty with `reltuples` 0, where on origin/main it held [8e]'s 480 rows with `reltuples` 480.
- Those 480 rows' delete-audit rows are written at [8e]'s end, not at [9]'s start: 7,632 `thought_audit` rows either way once [9]'s DELETE has run, at both widths.

The db typecheck passes. Nothing guards the speedup itself: a later load that grows the index row by row again would pass every assertion and cost only time.

**Measured after.** In `oven/bun:1.4.0` capped at four CPUs, one version's two widths at once, as CI's step runs them:

| Section | 1024 before | 1024 after | 768 before | 768 after |
| --- | --- | --- | --- | --- |
| [8c] | 28.7 s | 7.1 s | 21.0 s | 5.0 s |
| [8d] | 10.8 s | 1.3 s | 8.3 s | 1.0 s |
| [8e] | 30.0 s | 5.9 s | 22.9 s | 4.3 s |
| Suite | 81.1 s | 25.1 s | 62.1 s | 21.4 s |

The three sections take 69.5 → 14.3 s at 1024 and 52.2 → 10.3 s at 768, 79% and 80% less. On the 18-core Mac with four runs at once, the figures were 70.3 → 14.3 s and 53.9 → 10.6 s.

CI can't show section times. Since SMD-2092 the step prints each log only after both runs finish, so every line carries the same timestamp. CI measures the step. On this PR's run, 36129871750 on the merged tree, it took 50 s and the job 59 s, with both summary lines reading 1625/1625. After SMD-2092 the step took 117 s on PR #160's first run and 191 s on main's push run, and the job took 126 s, 146 s and 198 s over three runs. The step, which is both widths' loads and everything else, drops by 57% even against the fastest of them.

The run's wall time stayed at 218 s: "Schema against real Postgres", at 213 s, is now the whole critical path (SMD-2135).

**Review passes.**

| Pass | Finding | Caught | Fix |
| --- | --- | --- | --- |
| 1 | Nothing held [8e]'s final rebuild, since 039's later reapply builds the index silently; [8e]'s last assertion reads it back | mutant | 21176945 |
| 1 | The helper's DELETE had no teeth, nor had the three it replaced; [8e]'s page assertion counts its 1,000 rows | mutant | 21176945 |
| 2 | Pass 1's read-back was a regex without an end anchor, so an index rebuilt with other build parameters passed it; compared whole now, quoted when it differs | mutant | 9fd7c9a7 |
| 3 | Pass 2 compared with the definition [8e]'s own load read, which was [8d]'s rebuild, so a helper that rebuilt wrongly every time compared equal; the first definition read, before [8c], is the one compared | mutant | 5dcdae63 |
| 3 | Two drop-and-rebuild paths had grown (the helper, and [8e]'s own variable, null branch and return value); one helper around a body, called twice in [8e] | cold read | 5dcdae63 |

Boyscout, after pass 3:
- [8c]'s "Two that must not be found" now reads "One", since it inserts one row.
- [8e]'s band message used to say a narrower width packs more rows a page. A probe of 1,000 rows gave 143, 200, 10, 10 and 10 heap pages at 256, 384, 512, 768 and 1024 dims, so it now says the vector is out of line from about 512 dims and a narrower one, kept in the row, gives a larger heap.

**Not taken.**
- Turning the triggers off does nothing for the time, as measured above.
- Smaller fixtures: the ticket keeps the rows byte for byte, and [8e]'s band needs a heap of at least eleven pages.
- Skipping [8e]'s first rebuild, over its 1,000 rows, before the agreement checks: no behavioural assertion needs it (see above), but those checks are the ones that should catch a mis-routed call once SMD-2151 lets the walk reach the index.
- Reporting a failed rebuild instead of throwing it, as test-live's [5d] does: any throw ends this suite, and the statement being rebuilt comes from the index itself.

**Follow-ups.** SMD-2151: test-schema's filtered walk never reaches the HNSW index without `ANALYZE`, so [8c]'s recall check and [8d]'s clamp test an exact scan.
