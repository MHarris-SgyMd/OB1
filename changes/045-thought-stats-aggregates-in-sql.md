# 45. `thought_stats` aggregates in SQL — the whole corpus in one statement, not a 100-page walk that goes wrong past 100,000 rows (SMD-1249)

`thought_stats` computed its aggregates in application code: the tool looped
`store.pageThoughtMeta(offset, 1000)` and tallied type/topic/people counts in JS,
up to a `STATS_MAX_ROWS = 100,000` ceiling, then set `truncated = true` and
returned anyway. Two things were wrong, and only one was speed. **The cap was a
correctness cliff.** Past 100,000 thoughts the breakdowns came from an arbitrary
newest-100k prefix while `Total thoughts` was the real total — a corpus-wide
number beside partial aggregates, a one-line note the only tell. That is the same
defect shape fork fix 3 (SMD-970, upstream
[#470](https://github.com/NateBJones-Projects/OB1/issues/470)) removed from
Supabase's silent 1000-row page: fix 3 made the boundary explicit and visible; it
did not delete it, it moved it to 100k. **And the reason for the walk was gone on
this path.** The old comment said the ceiling kept a very large brain from
exhausting the Edge Function's time budget — but there is no Edge Function here;
`store-sql.ts` talks to Postgres directly over `Bun.sql`, and Postgres aggregates
the whole table in one statement.

**Migration 024 adds `thought_stats_summary()`** — `STABLE`, `LANGUAGE sql`,
returning `{total, first_ts, last_ts, types{}, topics{}, people{}}` over CTEs that
`min`/`max`/`count` and unnest `jsonb_array_elements_text(metadata->'topics')` and
`->'people'`. Adapted from upstream's
`recipes/edge-function-cost-optimization` migration, which has exactly this
function — **only** that function, not its 3-arg `upsert_thought(text, jsonb,
vector)`, which overlaps 004/007/022 where 022's chunk-replacement semantics are
load-bearing and further along than theirs. Two robustness fixes over the
upstream shape, to match the tool's JS exactly: the topic/people arms unnest only
when the value is genuinely a JSON array (`jsonb_typeof = 'array'`, the SQL
equivalent of `Array.isArray`), so one malformed row — topics as a bare string —
cannot raise and fail the whole summary; and a JSON `null` inside an array is
dropped before `jsonb_object_agg`, which rejects a NULL key. `ROWS` is
deliberately **absent** (019 declared it on the set-returning search functions;
this returns a scalar jsonb), and there is no `SET search_path` clause because the
body never touches the `vector` type (SMD-1247 does not reach it).

**The interface now says the two stores differ.** `ThoughtStore` gains
`statsSummary(): Promise<ThoughtStats>`. The SQL store runs the function — whole
corpus, `aggregated === total`, no cap, so the tool never prints a truncation note
on this path. The PostgREST store (Workers, no server-side aggregation) keeps the
page walk, and the `STATS_PAGE_SIZE`/`STATS_MAX_ROWS`/truncation logic **moved out
of the tool and into that store**, the only path that still needs it; its
`aggregated` can be `< total` and the tool says so. The tool itself is now thin:
one `statsSummary()` call and the same rendering as before — `test-e2e-sql.ts` [6]
(unchanged) proves the output contract held.

**The plan, measured not assumed** (the fork's rule, SMD-925). The unnest arms
full-scan `thoughts` — a HashAggregate over a Seq Scan up to ~10,000 rows, a
parallel Finalize GroupAggregate above — and that is the right cost for a tool
called once by a human, never in a loop; the heap it scans is small, inline
jsonb, nothing like `match_thoughts`' TOASTed-vector detoast cost in 019.
`db/bench-stats.ts` measures it against the walk it replaces (median of 5,
content-only rows):

| rows | function | page walk | walk round trips |
| ---: | ---: | ---: | ---: |
| 1,000 | 1.15 ms | 1.03 ms | 2 |
| 10,000 | 7.79 ms | 9.13 ms | 11 |
| 100,000 | 91.1 ms | 286.1 ms | 101 |

Below ~10,000 rows it is a wash on wall-clock — one aggregate has a fixed cost the
walk's first small page does not — and the win there is one round trip instead of
many and no cap, not raw speed. At 100,000 it is ~3× and one round trip against
101; **past** 100,000, where the old walk capped, the walk is not merely slower
but wrong, and this path stays correct.

**Verified.** `test-live.ts` [12] seeds a known corpus and proves the function
equals the page walk on `total`/`types`/`topics`/`people`, drops a JSON-null array
element and skips a non-array `topics` without raising, handles the empty corpus
(zero, null date range, empty maps), and — the ticket's key check — shows a walk
capped below the corpus disagreeing with the whole-corpus function, so the old
truncation is proven real without seeding 100k rows; an `EXPLAIN` there asserts
the full scan. `test-store-sql` [5b] and `test-store-postgrest` [8] cover each
store's `statsSummary`; a new preflight `stats summary` check fails a database
stopped at 023 with the tool registered but no function behind it (modelled on
the `keyword search`/`hybrid search` checks, `test-preflight` covers present and
missing). All 19 ci-parity suites green; `tsc --noEmit` clean.

Upstream status: #470 is the same defect shape as SMD-970, which tracks dropping
fork fix 3 if upstream ever lands theirs; this ticket is the opposite direction —
it moves the computation somewhere upstream cannot follow, because upstream has no
direct SQL path — and does not close SMD-970. **Unfiled** upstream.
