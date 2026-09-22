# 70. The routing count is gated by a sample of the heap — migration 037 reads eight random pages before 014's capped GIN collection and skips it when the sample says the filter is far too broad for the exact branch (SMD-1463)

Change 28's "At scale" section ended on two costs that grow with the table, and
this is the first of them. Every filtered `match_thoughts` call since migration
014 opened with the routing statement — `SELECT array_agg(id) FROM (SELECT id
FROM thoughts WHERE metadata @> filter AND <scoreable> LIMIT v_exact + 1)` —
to decide between the exact branch and the HNSW walk. GIN builds its whole
bitmap for the filter before the first row comes back, so the `LIMIT` caps the
heap fetches and nothing else: the statement costs the number of *matching*
rows, about 50 ns each, whatever it returns. SMD-1018 measured it through
`db/bench-hnsw.ts` section C on the 50% tier: 0.8 ms at 10,000 rows, 3.0 at
100,000, 27 at a million, 240 at ten million — nine tenths of that tier's
whole call at ten million, where the walk that follows needs some eighty
tuples. The twelfth review pass of 014 had named the mitigation — estimate the
match count first, run the collection only when the estimate is plausibly
under the threshold — and declined it for want of a number. The ticket's
brief: bias the guess towards running the collection (a wrong estimate that
runs it costs what today costs; one that skips it sends a thin filter to the
walk, which is correct but slower and, at a million rows, can return short),
keep the empty filter at one GIN probe, and hold `test-schema` [8b], [8c] and
[8d]. The last held up to about a million rows; the third finding below says
where and why not beyond.

**Migration 037.** On a heap of at least 8,192 pages (64 MB), a filtered call
first reads eight random pages of `thoughts` through `TABLESAMPLE SYSTEM` and
counts three things: the sampled rows that pass the filter and carry a vector
(`hits`), the distinct pages those rows sit on (`hit_pages`), and the distinct
pages the sample reached (`pages_seen`). The collection is skipped — the call
goes straight to the walk — only when all three hold:

1. `hits × pages ≥ 10 × v_exact × pages_seen` — the sample, scaled to the
   table, puts the filter at ten times the exact threshold or more. Ten is the
   bias.
2. `hits ≥ 8` — a floor on the evidence. At ten million rows the first
   condition is met by a single sampled row (eight pages of some 526,000 are
   one sixty-five-thousandth of the table; one hit scales to 65,000), and one
   row is luck. Eight from a filter matching exactly `v_exact` thoughts there
   has probability about 1e-19; from one matching 1% of the table, about two
   in a thousand measured (the table below: 2 of 1,000 draws) — the Poisson
   figure is two in ten thousand, and `SYSTEM`'s page-level variance is the
   difference.
3. `hit_pages ≥ 3` — `SYSTEM` sampling is by page, so a filter whose matches
   sit together on disk (one import, one day's captures, one tag written in
   one session) shows the sample a page full of hits or nothing, and one full
   page passes the first two conditions by itself. Three different pages means
   three separate draws landed on the filter; for a contiguous run of
   `v_exact` rows that is C(8,3) × (run pages / heap pages)³ — about 1e-5 at
   the floor, 6e-8 at a million rows, 6e-11 at ten million. The layout the
   rule is weakest against sits between those two: a few matches a page over
   hundreds of pages — a tag on four captures a day for most of a year —
   where three sampled pages already hold eight hits. For `v_exact` rows four
   to a page that is C(8,3) × (250 / heap pages)³: about 2e-3 at the floor,
   7e-6 at a million rows, 7e-9 at ten million. The first review pass found
   the layout; measured on a 6,826-page heap, where the formula says 2.8e-3,
   995 such rows were skipped 13 times in 20,000 draws — 6.5e-4, under the
   bound because condition 1 is marginal with exactly three hit pages
   (twelve hits scale to barely ten times the threshold and fail it whenever
   the draw reached nine pages). The second pass corrected the figures here,
   which had quoted that measurement as the formula's output. `hit_pages ≥ 4`
   would make the bound C(8,4) × f⁴, about 6e-5 at the floor (1.3e-4 on the
   6,826-page heap, where 4 of 20,000 draws — 2e-4 — were measured), at two to
   three points of the broad filters' skip rate — the knob if that band
   matters; the rule ships as measured.

Anything less runs the collection exactly as before — the same statement,
token for token, indented two spaces further inside an `IF` (test-schema [20]
compares it with 014's, whitespace collapsed) — and the same routing after it. Under the floor nothing
runs but that collection: a brain of a few thousand thoughts never reads the
sample, and its empty-filter probe stays the one GIN probe 014 made it. The
page count and the floor are `config.mjs` constants (`ROUTE_SAMPLE_PAGES`,
`ROUTE_ESTIMATE_MIN_PAGES`) templated into the file, so the header, the bench
and the tests read one value; they are not operator knobs, and a suite lowers
the floor only to reach the gate on a small table (`SchemaOptions.routeEstimateMinPages`).
The threshold, the three branches, the walk's bounds and the plan mode are
untouched — SMD-1464's questions. 037 is now the last definer of
`match_thoughts`, which is what preflight's remedy and the suites'
`restoreShipped` apply *alone*, so it carries 020's `DROP` of the 4-argument
form and 020's replay of that form's privileges onto the new one: a hand
re-apply of 014 or 019 puts the 4-argument form back beside the 6-argument one
and every 4-argument call is "function is not unique"; the first draft of this
file left that to 020 and test-schema [8c] found the two forms at once. On a
database in order the `DROP` finds nothing, the capture reads an empty ACL, and
`CREATE OR REPLACE` over the same signature keeps the function's privileges
(test-upgrade [14] holds both directions). The same review found the mirror
image in preflight's signature remedy: "apply 020" re-installs 020's
`search_thoughts_hybrid` too, without change 48's relative floor — test-live
[5d]'s first run did exactly that and [15] failed behind it — so the remedy
now names 020, then 027 and 037, the last definers of the two functions.

**Why a sample, and why this one — measured on a 500,000-row scratch corpus of
the bench's shape before the file was written.**

- *Not the planner's estimate*, which the ticket offered first. An `EXPLAIN`
  of the predicate costs 0.7 ms and said 297,980 for a filter matching 249,623
  rows, 50,505 for 49,994, 10,101 for 5,007 — and 50 for every filter under
  that: 479 rows, 52, 895, a 1,000-row cluster and one matching nothing, all
  50. jsonb has no per-key statistics; `@>` is priced from the column's
  most-common *whole* values, which on the bench's few metadata shapes covers
  the broad filters and on a real brain, where every row's metadata differs by
  a timestamp or a title, covers none — every filter gets the default, one per
  cent of the table, which at ten million rows is 100,000 for a filter
  matching five and would send every thin filter to the walk: the opposite of
  the bias asked for.
- *`TABLESAMPLE SYSTEM`, not `BERNOULLI`*: `BERNOULLI` decides per row and reads
  every page; `SYSTEM` decides per page and reads eight — 0.10 / 0.14 / 0.24 /
  0.39 ms of execution for 4 / 8 / 16 / 32 pages, the same for the 50% filter
  and the empty one, because the cost is the rows read, not the rows that
  pass. Eight pages: a 10% filter puts sixteen expected hits in 160 sampled
  rows and was skipped in 908 of 1,000 draws, a 50% filter in 984 (the misses
  are mostly draws with fewer than eight hits — `SYSTEM` picks a binomial
  number of pages, and two hits a page compound that variance; on a
  6,826-page heap the first review pass counted 1,109 such, 345 that failed
  condition 1 at that small heap, and 45 that reached fewer than three pages,
  of 1,499 misses in 20,000 draws); sixteen pages bought 998 and 1,000 for
  0.1 ms more on every
  filtered call, and the empty filter's own probe is 0.012 ms, so the sample
  is already the larger part of that call. No `REPEATABLE` seed: a fixed seed
  reads the same pages every call, which is a warm cache and a systematically
  wrong sample of a clustered filter.
- *The hit is `metadata @> filter AND embedding IS NOT NULL`*, not the
  collection's `OR EXISTS (chunk)`: inside a SELECT-list expression the
  `EXISTS` became a hashed subplan — the planner built a hash of the whole
  chunk table before the sample scan started, 18 ms — where the collection's
  WHERE-clause `EXISTS` is an index probe per row that lacks a vector. Not
  counting a chunk-only row lowers the estimate, which biases towards running
  the collection, which counts it; [8d]'s answer is unchanged.
- *`pg_relation_size`, not `relpages`*: `relpages` is a statistic, 0 on a table
  never analysed — a bulk import queried before autovacuum reaches it — which
  would put the share at 100% and sample the whole heap (the prototype did
  exactly that, once). `to_regclass('thoughts')` rather than a `regclass`
  literal, which binds the OID at plan time and would size a table a suite
  has since dropped and recreated.
- *The floor* is where the bitmap can cost more than the sample: at 50 ns a
  matching row, 8,192 pages — some 160,000 rows at the bench's width, fewer
  with long content, more at the shipped width with short content (the
  vectors are TOASTed, so the heap holds ~65–80 rows a page there) — puts the
  collection at 4 ms for a 50% filter against a sample of 0.15 ms on every
  filtered call.

**The rule, tried a thousand times per filter on that corpus** (24,999 pages,
`v_exact` 1,000; `skip` is how many of 1,000 draws met all three conditions):

| filter | matching rows | placement | skipped, 8 pages | skipped, 16 pages |
| --- | ---: | --- | ---: | ---: |
| 50% | 249,623 | uniform | 984 | 1,000 |
| 10% | 49,994 | uniform | 908 | 998 |
| 10,000 rows | 10,000 | one contiguous run | 1 | 3 |
| 1% | 5,007 | uniform | 2 | 19 |
| 2,000 rows | 2,012 | uniform | 0 | 0 |
| 1,000 rows | 1,000 | one contiguous run | 0 | 0 |
| 900 rows | 895 | uniform | 0 | 0 |
| 0.1% | 479 | uniform | 0 | 0 |
| 0.01% | 52 | uniform | 0 | 0 |
| nothing | 0 | — | 0 | 0 |

Every filter at or under the threshold — the five bottom rows, the contiguous
1,000 among them — ran the collection every time on that corpus; the
thin-spread layout, measured separately on a 6,826-page heap, is the exception
condition 3 describes above. The two filters between one
and ten times the threshold (5,007 and the contiguous 10,000) were skipped
once or twice in a thousand, and a skip there is not a wrong answer: both are
above the threshold, so the collection would have routed them to the walk
anyway. The broad filters, where the collection costs, were skipped nine
times in ten or better.

**Through the function, before and after, on the machine change 28 describes**
(Apple M5 Pro, podman VM, 8 vCPUs, 14.8 GB, pgvector 0.8.6 at its image
defaults; `db/bench-hnsw.ts`, the before pass from the tree without 037 and
the after pass with it — reproducible from one tree as `OB1_BENCH_UPTO=035`
against the default, which the bench gained for this). Section B, ten asked,
median over 50 random queries:

| rows | filter | matching rows | before: in exact top-10 | median ms | after: in exact top-10 | median ms |
| ---: | --- | ---: | ---: | ---: | ---: | ---: |
| 100,000 | 50% | 49,991 | 6.6 | 6.85 | 6.4 | 5.54 |
| 100,000 | 10% | 10,116 | 8.6 | 12.45 | 8.8 | 10.10 |
| 100,000 | 1% | 998 | 10.0 | 3.17 | 10.0 | 2.66 |
| 100,000 | 0.1% | 90 | 10.0 | 0.55 | 10.0 | 0.57 |
| 100,000 | 900 rows | 910 | 10.0 | 3.03 | 10.0 | 2.44 |
| 100,000 | 0.01% | 6 | 6.0 | 0.23 | 6.0 | 0.25 |
| 100,000 | nothing | 0 | 0.0 | 0.19 | 0.0 | 0.21 |
| 1,000,000 | 50% | 499,443 | 2.8 | 36.54 | 2.8 | 10.38 |
| 1,000,000 | 10% | 99,748 | 5.2 | 47.06 | 5.4 | 37.26 |
| 1,000,000 | 1% | 9,951 | 10.0 | 31.06 | 8.8 | 242.44 |
| 1,000,000 | 0.1% | 1,034 | 10.0 | 8.17 | 10.0 | 6.31 |
| 1,000,000 | 900 rows | 934 | 10.0 | 6.42 | 10.0 | 4.34 |
| 1,000,000 | 0.01% | 99 | 10.0 | 0.95 | 10.0 | 1.16 |
| 1,000,000 | nothing | 0 | 0.0 | 0.21 | 0.0 | 0.43 |
| 10,000,000 | 50% | 4,998,406 | 0.9 | 240.87 | 0.8 | 13.22 |
| 10,000,000 | 10% | 999,827 | 2.1 | 138.07 | 2.1 | 45.18 |
| 10,000,000 | 1% | 99,633 | 5.8 | 545.81 | 10.0 | 726.15 |
| 10,000,000 | 0.1% | 10,231 | 10.0 | 97.11 | 10.0 | 92.60 |
| 10,000,000 | 900 rows | 886 | 10.0 | 9.83 | 10.0 | 10.93 |
| 10,000,000 | 0.01% | 959 | 10.0 | 9.26 | 10.0 | 11.50 |
| 10,000,000 | nothing | 0 | 0.0 | 0.27 | 0.0 | 1.31 |

Section C, the two statements themselves, extracted from the deployed body and
explained (execution time): the collection under a forced custom plan; the
sample from the first after pass's JIT-off arm, because its other two arms
were mispriced by the extraction the third finding describes — the corrected
bench prices all three within 0.05 ms of each other (1.11 / 1.09 / 1.07 at
ten million), so the column is the sample's cost, not a plan mode's:

| rows | filter | matching rows | route (the collection): before ms | after ms | estimate (the sample): after ms |
| ---: | --- | ---: | ---: | ---: | ---: |
| 100,000 | 50% | 49,991 | 2.70 | 2.54 | 0.11 |
| 100,000 | 0.01% | 6 | 0.04 | 0.04 | 0.09 |
| 100,000 | nothing | 0 | 0.01 | 0.02 | 0.14 |
| 1,000,000 | 50% | 499,443 | 25.40 | 24.05 | 0.22 |
| 1,000,000 | 0.01% | 99 | 0.65 | 0.60 | 0.19 |
| 1,000,000 | nothing | 0 | 0.02 | 0.01 | 0.21 |
| 10,000,000 | 50% | 4,998,406 | 250.45 | 217.14 | 0.94 |
| 10,000,000 | 900 rows | 886 | 5.55 | 5.72 | 1.04 |
| 10,000,000 | nothing | 0 | 0.02 | 0.03 | 0.99 |

Read down the tables and four things fall out.

- **The broad tiers lose the collection, and at ten million rows that is
  most of the call.** 50% at ten million: 241 ms → 13, the 250 ms bitmap
  gone; at a million 36.5 → 10.4. 10%: 138 → 45 and 47 → 37 — the gate
  skips a 10% filter nine times in ten (the misses are mostly draws with
  fewer than eight hits; the page count is binomial and two hits a page
  compound its variance), and the walk that follows costs what it always
  cost. The recall columns are the index's and did not move (0.8
  and 2.1 at ten million, 2.8 and 5.4 at a million — change 28's floor).
- **The thin tiers and the exact branch are unchanged, plus the sample.**
  900 rows: 9.8 → 10.9 ms at ten million, 6.4 → 4.3 at a million (cache
  warmth; the same tier ran 5.7–9.3 across change 28's passes); every one
  returned 10 of 10 in the exact top-10 before and after, as [8b]–[8e] and
  [5d] hold them to.
- **The empty filter pays the sample, and the sample's cost grows with the
  heap — about 2 ns a page — not with what the buffer pool holds.** 0.21 →
  0.43 ms at a million rows (50,000 pages), 0.27 → 1.31 at ten million
  (526,000). This section's first draft blamed uncached page reads against
  the image's 128 MB `shared_buffers`; the first review pass read the
  bench's own section C the other way (0.11 / 0.21 / 0.99 ms at 5,000 /
  50,000 / 500,000 heap pages is a line — a tenth of a millisecond for the
  eight pages' rows plus ~2 ns a page — not a cache effect) and the
  measurement agreed: one row a page, every page warm in
  the OS page cache (the larger two heaps exceed the image's 128 MB
  `shared_buffers`; change 80's fourth review pass), the statement costs 0.038 ms at 2,000 pages, 0.094 at
  20,000, 0.459 at 200,000. `TABLESAMPLE SYSTEM` decides per page by hashing
  every block number against its cutoff, so the eight page reads are the
  small part. So the ticket's "the estimate must not cost more than the
  0.01–0.2 ms the empty filter does today" holds up to about a million rows
  and not beyond: on this VM at ten million the shape enhanced-mcp sends on
  every call costs a millisecond more, against 228 ms less on the 50% tier
  and 93 less on the 10%, and by the slope a hundred million rows would pay
  10 ms on every filtered call. Sizing `shared_buffers` does not change it;
  a different sampling statement does — eight TID range probes, eight page
  reads whatever the heap, which also counts sampled pages exactly where
  `pages_seen` today misses an empty one — and that is SMD-1526 (done:
  migration 038, change 80). The bench's own
  `estimate` row at ten million read 60 ms under both plan modes and 0.94
  with JIT off, which is why the table's last column is the JIT-off figure:
  the extraction had substituted the sample share as its declaring
  expression (`pg_relation_size` is volatile), the planner could not size
  the sample scan and priced a scan of the whole heap, and that estimate
  crossed `jit_above_cost` — the function's own custom plan knows the
  parameter's value and pays none of it, which the 1.31 ms call is the proof
  of. The bench now substitutes the evaluated share (`routingAt` returns it),
  and a second ten-million-row after pass with that fix priced the row at
  1.11 / 1.09 / 1.07 ms across the three arms on the 50% filter and
  0.99 / 1.03 / 1.07 on the empty one, with section B reproducing within the
  spread (50% 13.3 ms, 10% 42.6, the empty filter 1.33).
- **The 1% tier is the planner's coin, as before.** At a million rows it was
  served from GIN under the walk branch in the before pass (31 ms, 10 of 10)
  and walked HNSW in the after pass (242 ms, 8.8 of 10); at ten million GIN
  served it both times (546 and 726 ms). Change 28 found the same flip
  between its own passes on the same rows under a fresh `ANALYZE`; the gate
  is not in it — a filter at 1% of a million rows (9,951) is skipped twice
  in a thousand draws, and either way the collection routed it to the walk
  branch, whose plan the coin decides. That band is SMD-1464's.

**What it costs where it does nothing.** Under the floor — 10,000 and 100,000
rows in the bench, every real brain today — the body computes two locals at
entry (the heap's page count and the sample share, ~5 µs) and nothing else
changes; the 100,000-row rows above differ by the pass-to-pass spread. Above
it, every filtered call pays the sample: 0.2 ms at a million rows and about a
millisecond at ten million, growing with the heap (the third finding above),
and the thin tiers move by less than the spread.

**Not done here.** A recency-weighted call at the ceiling count flips the
WALK statement (014's, not this change's) onto plpgsql's generic plan after
five costly custom plans, and the flipped plan — a GIN bitmap with a top-N
sort — answers a broad filter with the exact top-n where the custom plan's
HNSW walk answered approximately: identical calls from two sessions differ in
their rows, not only their cost. The fourth review pass met it in a
concurrency run (218 differing answers across 800 calls, 0 under
`plan_cache_mode = force_custom_plan`) and traced every difference to that
flip; the sample statement stayed on custom plans throughout. It is
SMD-1464's plan-mode question, with one more fact for it. Preflight has no
recogniser for 037's body (a 020 paste
under a 037 ledger passes; the operator's path above), as it has none for
027's: a `TABLESAMPLE SYSTEM (v_pct)` regex or a sentinel of 037's own would
give the `filtered search` check a "037's body" detail, the way `atomic
capture` names 035's — a line for the next preflight change, not this one.
The sample's per-page cost and its `pages_seen` denominator
are SMD-1526 (TID range probes in place of `TABLESAMPLE SYSTEM`: eight page
reads whatever the heap, sampled pages counted exactly — done: migration 038,
change 80). The threshold, the
plan mode and which of the two seeded bounds bites are SMD-1464; `ef_search`
on real vectors is SMD-1465. One thing
the prototype saw in passing belongs with SMD-1464: with `enable_seqscan` on,
the planner ran the 50% collection as a sequential scan with a `LIMIT` — 1.3 ms
against 12.6 for the GIN bitmap it takes under 019's `enable_seqscan = off` —
so 019's setting, right for the vector CTEs it was measured on, is what makes
the collection's cost the bitmap's on a broad filter; a `LIMIT`-shaped
alternative for that one statement is a plan question, not this change's, and
its estimate would rest on the same `@>` selectivity this change found
uninformative on real metadata. A hundred million rows was not run, for the
reasons change 28 gives.

**Verified:** `db/test-schema.ts` 868/868 under PGlite on the merged tree, [8e] new (the
shape, the floor, exactness with the gate reached at floor 0) and [20]'s
definer pin moved to 037; `db/test-live.ts` 500/500 on real Postgres, [5d]
new (25,000 rows at the configured width, the gate reached, the broad filter
makes one GIN scan fewer per call than under 020's body and the thin filter
the same, both exact); `db/test-upgrade.ts` 173/173, [14] new (037 onto a
populated 035: no column, signature, row or privilege moves; 014 re-applied by
hand, then 037 alone, leaves one form); `server-portable` `tsc --noEmit` clean;
`bun scripts/check-fork-consistency.mjs` PASS (check 7 reads 037 as
`match_thoughts`' owner from the files); `bench-hnsw.ts` before and after at
100,000, 1,000,000 and 10,000,000 rows, above. Three review passes, two
reviewers each. Pass 1 (SQL and TypeScript): the sample's cost model (~2 ns a
heap page, not eight uncached reads), the thin-spread layout's skip bound,
and the bloat bullet's direction (an empty sampled page inflates the estimate
rather than deflating it) — all stated above, SMD-1526 filed; on the
TypeScript side nothing above LOW — an [8e] assertion that passed by the
punctuation of a comment, a catch-all in the bench that would have read a
rewrite failure as "before 037", cleanup-on-failure in [5d] and [8e], a stale
change number on the README line this change extended (034 is change 65), the
older missing-hybrid remedy still stopping at 020, `OB1_BENCH_UPTO` accepting
a prefix before 014. Pass 2 (docs and run-it): pass 1's thin-spread figures
had quoted the measurement as the formula's output (corrected above), the 10%
misses' cause named, `config.mjs` and the body comment repriced; every claim
tried on a real Postgres — custom plans on every call (the generic plan is
priced 200× the custom one and never adopted), NULL and array metadata, empty
and floor-sized tables, a SELECT-only role in a READ ONLY transaction, the
hybrid, `migrate.ts` apply / re-run / `--reapply` — no defect; the
bloated-heap measurement and the generic-plan sentence added; [8e] judges
five draws by the rule. Pass 3 (operator walkthrough and a coherence read of
the documents): the `hit_pages ≥ 4` bound had repeated pass 1's error
(6e-5 at the floor, not the measured 2e-4), the 1% filter's "two in ten
thousand" was the Poisson figure where the table shows two in a thousand,
this paragraph described one pass, the header narrated its own review
history — all rewritten; the operator's path is the next paragraph. Pass 4
(adversarial run-it and a fresh-eyes read of the TypeScript): 800 concurrent
filtered calls on sixteen connections with no error, deadlock or answer the
collection's route would not have given (0 differences under pinned plans);
exact-branch recall 1.000 across match_count 10 / 100 / 500 with and without
a recency weight; every odd filter shape and a table moved to another schema
behave as 020; [5d] costs 11 s of the 94 s suite. Two header sentences added
— the bounds are the default count's (at the ceiling, condition 1 keeps the
10% filter's collection near the floor), and a temp table shadowing the name
is sized while the cached plans read the real one, the safe side under the
floor — and [5d]'s cleanup no longer masks the section's own error.

**The operator's path, walked in pass 3.** A brain at 035 with rows, upgraded
by `bun db/migrate.ts`: "037 applied, 1 applied, 35 skipped", one
`match_thoughts` carrying the sample, the two SET clauses and `ROWS 10`;
preflight run as the compose stack runs it reports `search signatures`,
`filtered search`, `candidate scan`, `hybrid search`, `atomic capture` and
`migration ledger` all ok, nothing attributable to 037. The same brain with
020's file pasted over 037 by hand: preflight still reports ok — it has no
recogniser for 037's body (nor for 027's), the ledger records both, and both
020 bodies answer every call correctly, so what is lost is 037's cost bound
and 027's ranking floor, a degradation preflight's stated scope does not
cover; the ledgered remedy it prints for every stale-body state,
`migrate.ts --reapply`, restores both. A brain built by hand from the guide
and adopted with `--baseline`: preflight fails loudly on `filtered search`
and `hybrid search`, and following the printed remedies ends at 037 and 027
with every check ok. The PostgREST contract — six argument names, the
`RETURNS TABLE` shape — is byte-identical to 020's. The README's two bench
commands run and label their arms `after (014–035)` (no estimate row, the
"declares no sample share" note) and `after (014 on)` (three estimate rows).

**Upstream status:** not applicable — 014's routing statement is this fork's.
