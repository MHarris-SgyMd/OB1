# 28. A filtered search reaches the index — and the overfetch that never did

Migration 014 (Linear SMD-968; upstream
[#417](https://github.com/NateBJones-Projects/OB1/issues/417)). The issue
reports that `match_thoughts` loses recall under a metadata filter: pgvector's
HNSW scan hands over its first `hnsw.ef_search` candidates — 40 by default — and
a filter applied after that sees only those 40. Upstream's fix is one line,
`SET LOCAL hnsw.ef_search = 200`.

**That line could not have fixed this fork.** 007's function took each
candidate CTE's top `v_fetch` rows by distance — `LIMIT GREATEST(match_count *
4, 20)` — and applied `t.metadata @> filter` to the merged result afterwards. The
explicit LIMIT capped the candidate set before the filter ran, whatever
`ef_search` said. A filter matching 1% of the corpus saw 1% of 40 candidates.

**Who it reached, stated plainly because the first two drafts of this section
overstated it.** The server's own `search_thoughts` has no filter input and
passes `{}` on every call, in both `server/index.ts` and `server-portable/`.
So the filtered-recall defect never touched first-party search; it reached
direct SQL callers, PostgREST RPC callers, and community code that sends its own
filter — the enhanced-mcp integration's `metadata_filter`, the local-brain
recipe's search function. The overfetch defect below did reach first-party
callers, above ten results. The third review pass caught the framing; the
Linear ticket carries the same correction.

**Measured first, on random vectors.** `db/bench-hnsw.ts`, 64-dimensional unit
vectors, planted filter tiers, 10 rows asked, against an exact scan of the same
rows with index scans disabled:

| rows | filter matches | before: returned | in exact top-10 | empty | after: returned | in exact top-10 | empty |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 10,000 | 50% | 10.0 | 7.9 | 0/50 | 10.0 | 9.3 | 0/50 |
| 10,000 | 10% | 5.4 | 4.9 | 1/50 | 10.0 | 10.0 | 0/50 |
| 10,000 | 1% | 0.8 | 0.8 | 23/50 | 10.0 | 10.0 | 0/50 |
| 10,000 | 0.1% (9 rows) | 0.1 | 0.1 | 46/50 | 9.0 | 9.0 | 0/50 |
| 100,000 | 50% | 10.0 | 4.5 | 0/50 | 10.0 | 6.3 | 0/50 |
| 100,000 | 10% | 6.0 | 3.9 | 0/50 | 10.0 | 8.9 | 0/50 |
| 100,000 | 1% | 0.5 | 0.5 | 28/50 | 10.0 | 10.0 | 0/50 |
| 100,000 | 0.1% | 0.1 | 0.1 | 47/50 | 10.0 | 10.0 | 0/50 |
| 100,000 | 0.01% (6 rows) | 0.0 | 0.0 | 50/50 | 6.0 | 6.0 | 0/50 |

Two things in the after column are not the fix. The 6.3 and 8.9 at 100,000
rows for the broad filters are the HNSW approximation — random uniform vectors
are the index's hardest case, and 007 scored 4.5 and 3.9 on the same rows; the
iterative scan improves it because it keeps going, but `ef_search` is unchanged
and so is the index. And the two thinnest rows return fewer than ten because
fewer than ten exist; they are there to show the scan reaching past its
candidate budget for every matching row and finding them all.

**These tables were measured seven times.** The first bench's random generator was an
LCG multiplied in doubles; past 2^53 its low bits are rounding noise and the
stream repeats every 10,466 draws, so at 100,000 rows the corpus held ~10,000
distinct vectors stored up to ten times each and every "random" query was
bit-identical to a stored row — the query-is-its-own-nearest-neighbour confound
this bench's header says its design avoids. The second review pass found it.
The generator is now mulberry32 in 32-bit arithmetic, the bench refuses to run
if any query lies within cosine 0.99 of a stored row (it prints the nearest,
0.56–0.59 here), and every number in this section is from the re-measurement.
The shape of the finding did not change; the broad-filter approximation, the
default path's cost and the scan bound's behaviour did, and are reported as
re-measured. The third measurement came after the sixth review pass found that
the bench's session predated the migration that seeds the walk bounds at
database level, and `RESET ALL` does not fetch those — so the bounds section D
claimed to exercise were not in force. The bench now reconnects and asserts the
session sees them before measuring. The fourth came after the ninth pass
replaced the body's OR with two branches; the fifth after the tenth added the
exact branch and raised the ceiling (below); the sixth after the eleventh
folded the routing count into that branch; the seventh after the twelfth made
that count ignore rows nothing can score. The recall columns have moved by at
most 0.2 since the second; the latencies have moved a great deal, and the
tables are from the seventh run.

**Then on the real corpus.** `evals/eval-filtered.ts`, the 441 issues with their
real labels, stored the way the server stores them (whole-content vector plus
bare windows), searched through the deployed function in a real Postgres. The
query is a document's title; the filter is a label that document does **not**
carry; the right answer is the exact top-10 within the label:

| filter | share of corpus | before: returned | in exact top-10 | empty | after: returned | in exact top-10 | empty |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `api` | 36% | 9.9 | 8.5 | 0/60 | 10.0 | 10.0 | 0/60 |
| `web` | 14% | 6.4 | 5.8 | 0/60 | 10.0 | 10.0 | 0/60 |
| `portal` | 4.5% | 1.6 | 1.6 | 31/60 | 10.0 | 10.0 | 0/60 |
| `design` | 2.7% | 2.0 | 1.9 | 0/60 | 10.0 | 10.0 | 0/60 |
| seeded 10% | 8.4% | 4.3 | 3.7 | 0/60 | 10.0 | 10.0 | 0/60 |
| seeded 2% | 0.7% | 0.2 | 0.2 | 48/60 | 3.0 | 3.0 | 0/60 |

Paired: 306 of 360 filtered queries improved, none worsened. (The seeded 2% tier
landed on three documents, so three is the whole answer; 007 found none of them
on 48 of 60 queries.) Filtered to a label the document
**does** carry, the target's rank is unchanged on all 316 queries — MRR 0.938
both ways — and the other nine rows go from 7.9 to 9.9 in the exact top-10.
Unfiltered, all 441 queries return identical rows before and after; the run
exits non-zero if they do not.

**Why the query design matters, and the draft that got it wrong.** A query
formed by perturbing the target's own vector makes the target the global nearest
neighbour, which no post-filter can lose. The first draft of the bench did that
and reported 50/50 recall for a function that returns nothing at 1%. Title
queries have the same property on this corpus: the target is the global nearest
neighbour of its title (MRR 0.90), so "does the title still find its document
under a filter" would have called the defect harmless. The task a filter exists
for is "things about X among my `portal` issues", where the best `portal` match
is not the global best match — so the eval filters to a label the query's
document lacks and scores against the exact answer within it.

**What changed.**

- The filter moves inside both CTEs. For `thoughts` it is a plain Filter on the
  index scan. For `thought_chunks` it is a **join** to the parent row, not an
  EXISTS: inside an OR the planner cannot turn EXISTS into a semi-join and ran it
  as a hashed subplan — one full pass over `thoughts` per query, whatever the
  filter. Measured, that alone made the new function 3x the old one's latency at
  10,000 rows. The join is one primary-key lookup per candidate, and it exists
  only in the walk branch; the unfiltered branch has no predicate and no join.
- **A thin filter is answered exactly, with no index walk.** The function
  collects the matching thoughts' ids through the GIN index, at most the
  threshold plus one of them, and when at most `GREATEST(v_fetch * 4, 1000)`
  match it scores those rows and their chunks directly by id — primary-key
  probes and chunk-index probes with that array, one pass over the filter (the
  tenth-pass draft counted first and re-evaluated the predicate to build the
  matched set; the eleventh folded the two into one). Only rows a branch can
  score count towards the threshold: a thought captured through the 2-arg
  fallback has no vector and no chunks, and the twelfth pass found that
  counting those could send a filter with 1,200 matches and 30 scoreable rows
  to the walk, which needs 40 passing rows that do not exist and returns short
  at the bound; `test-schema.ts` [8d] pins the exclusion with a walk clamped to
  one tuple. The tenth review pass forced the branch: the
  enhanced-mcp integration sends `exclude_restricted: true` on every semantic
  call and nothing writes that key, so every one of its calls matched nothing,
  and the walk-only body ran each CTE to the scan bound to return the same
  empty answer 007 gave in 40 candidates — 60+ ms and up to 32 MB per scan,
  per call. It now costs one GIN probe. The same branch takes the planner's
  knife-edge away for every thin filter on a large table (the 2 ms / 190 ms
  variance below was that edge). Above the threshold the walk has at least
  that many rows to find its candidates among, so it visits about `N / 25`
  tuples at the default count and the seeded bounds are its ceiling on tables
  past ~2.5 million rows; bench section D runs the walk's own statement on the
  thin filters to show the bounds working when it is reached. (Measured at a
  million and ten million rows by SMD-1018, below: the planner serves those
  filters from the GIN index and the bounds are never what binds through the
  function.)
- **A `RETURN QUERY` branch per path, not an OR.** Drafts three through eight kept
  a single query text with `v_unfiltered OR metadata @> filter` and paid for it
  in layers: the OR against a parameter hid the GIN index from the generic plan,
  so the function had to force custom plans (`plan_cache_mode`), so the chunk
  join had to be LEFT for join removal to fire when the OR folded, so the next
  author needed a paragraph about why a boolean local was load-bearing — and
  the "forcing the custom plan is free" number was never re-measured with its
  neighbours. The ninth review pass named the OR as the root. With the
  predicate a plain `metadata @> filter` in its own branch, the planner has
  the GIN index whichever plan mode plpgsql picks, picking is a latency choice
  rather than a recall one (the plans are below), and the only function-level
  SET is the scan mode. The two texts differ in the predicate and the
  chunk-side join and nothing else; `test-schema.ts` holds them to the same
  answer on the same rows. The earlier objection — a query
  defined twice — is real and was judged smaller than what the single text
  cost.
- `hnsw.max_scan_tuples = 100000` **and** `hnsw.scan_mem_multiplier = 8`. The
  first pass of this change set only the tuple cap and reported that raising it
  from 20,000 to 400,000 changed nothing; the second review pass found why:
  pgvector also stops the iterative scan when its memory passes
  `work_mem * scan_mem_multiplier`, 4 MB by default, about 19,000 visited
  tuples — so the tuple cap was never the operative bound. Re-measured with
  valid data (below), the memory bound left a 15-row filter at 6.3 of 10 and a
  110-row filter at 42 of 50 under the generic plan; with the multiplier at 8
  both complete. Arithmetic for the cap: `v_fetch / selectivity`; pgvector's
  default covers a 0.1% filter to `match_count` 5 on a million rows, 100,000
  covers 25 — arithmetic that SMD-1018 measured at a million and ten million
  rows and retired; the "At scale" section at the end of this change has what
  the bounds actually buy. They are seeded ONCE at **database** level by a DO block in the
  migration, and only where nothing has set them — not declared on the function.
  The third and fourth drafts put them on the function and then built a
  compensating layer: a function-level SET overrides any database or role value
  and is rewritten by every `CREATE OR REPLACE`, so an operator's tuning had
  nowhere durable to live except a template variable threaded through config,
  compose, tests and preflight, each of which then needed its own validation.
  The fifth review pass named that for what it was. One `ALTER DATABASE … SET`
  by the owner is now the whole tuning surface: every session honours it, no
  redefinition of the function touches it, and re-running 014 leaves it alone —
  `test-schema.ts` asserts both the seeding and the leaving-alone. Where the
  migrating role does not own the database the DO block warns with the two
  statements and the migration still applies; the fix does not depend on the
  bounds, only the depth of a rare walk does.
- `match_count` is clamped inside the function, as 012 clamps its `p_limit` —
  to 500, the largest count any caller in the repo sends (enhanced-mcp asks for
  up to 500 under a date filter, rest-api and agent-memory-api up to 200), and
  `search_thoughts` bounds its own `limit` to 1–100 in both servers, as the
  keyword tool already did. 007 capped each CTE near 40 candidates whatever
  was asked; this function honours `v_fetch`, so an unbounded count became
  unbounded scan work — `limit: 5000` would walk each CTE to 20,000 passing
  candidates — and the callers who send a filter are outside the servers'
  bound. What the clamp changes, named: 0 and negative counts return one row,
  NULL returns ten, a count above 500 returns 500 and raises a NOTICE saying
  so. The fourth pass asked for the tool bound, the sixth for the clamp, the
  seventh for the edges to be stated and tested, and the tenth found the
  ceiling — 100, borrowed from 012 without 012's `total_count` — unmeasured and
  cutting two integrations' post-filter headroom with no signal; it is now the
  callers' maximum, timed in bench section A, and one definition in
  `config.mjs` templated into the body.
- The function body carries a contract sentinel, `-- ob1:filter-inside-scan`,
  and preflight decides whether the deployed body has 014's semantics by that
  sentinel plus a behavioural probe (a NULL filter returns a row under 014 and
  nothing under any earlier body) rather than by grepping for a local
  variable's name. The seventh pass moved the marker off the local's name and
  into `COMMENT ON FUNCTION`; the eighth caught that a replace preserves the
  OID `pg_description` is keyed on, so a successor that forgot its own COMMENT
  inherited the claim — hence the body, which every replace rewrites, and the
  probe. A successor that keeps the in-scan filter carries the sentinel; one
  that reintroduces a post-LIMIT filter must not — and a successor that keeps
  the sentinel but changes how a NULL filter is treated gets its own verdict
  from the probe rather than the pre-014 remedy, which would have re-run 014
  over it (ninth pass). Preflight also warns whenever the walk bounds are set
  nowhere — judged by `pg_settings.source`, so a value from `ALTER SYSTEM`, a
  parameter group or `ALTER ROLE` counts as set, and an operator who lowered one
  on purpose is tuning, not failing — however 014 was recorded: `--baseline`
  never runs the DO block and a non-owner cannot. The seed guard in 014 and the
  migrator's check ask a narrower question — set where EVERY role sees it,
  meaning server configuration or the database — because precedence is role >
  database > server: a database-level seed would silently undo an operator's
  `ALTER SYSTEM` (verified; the eighth-pass guard, which looked only for a
  database-level row, would have), but it cannot touch a role-level value, and
  a role-level value reaches one role. The ninth-pass guard counted any
  non-default source, so an `ALTER ROLE` on the migrating role suppressed the
  seed for everyone else, silently (tenth pass); `test-schema.ts` now sets the
  value in the session and asserts the seed still lands. Preflight keeps the
  wider question, since for the server's own connection a role-level value is
  in force. One limit, named in the header and `.env.example`: the migrating
  session sees server configuration as of its connect, so an `ALTER SYSTEM`
  that has not been reloaded looks unset and is seeded over; reload before
  migrating (eleventh pass). And the migrator's own check did not run at all
  for one commit — it bound two JS arrays into `= ANY(...)` bare, which Bun
  sends as comma-joined text, so every run fell into the catch that turns an
  error into a soft warning and the remedy it exists to print was unreachable;
  the live test asserted only the exit code and "applied N". It now binds
  through `sql.array`, reads the seeded names from the migration's own text,
  and the live test asserts neither warning appears.
- The function-level SET is NOT a problem at call time, though the eighth pass
  documented it as one and prescribed casting the argument. CREATE FUNCTION
  and ALTER DATABASE validate a SET clause up front and refuse an unknown
  `hnsw.*` placeholder to a non-superuser; function entry applies `proconfig`
  through the ordinary set_config path, where the placeholder is user-settable
  and pgvector converts it when the body's `<=>` loads the library. The tenth
  pass reproduced it: a non-superuser owner and a plain reader, each in a
  fresh session whose first statement fed an existing `embedding` value into
  match_thoughts uncast, got their rows with `relaxed_order` in force, while
  CREATE with the same clause in the same cold session was refused. The header
  now says so; nothing in the repo had tested the earlier claim.
- `hnsw.iterative_scan = relaxed_order`, declared as a **function-level SET**.
  This is what makes an in-scan filter correct: without it the scan stops at its
  first `ef_search` candidates, filter or no filter. A function-level SET is
  scoped to the call and restored on exit — nothing leaks into the caller's
  transaction as `SET LOCAL` would, and nothing depends on a pool preserving
  session state. It is also validated at CREATE: on pgvector before 0.8.0 the
  migration fails with `invalid configuration parameter name
  "hnsw.iterative_scan"` — pgvector reserves the prefix — which is the intended
  failure, reproduced on 0.7.4. That validation needs pgvector's library loaded
  in the session, and the migration now loads it explicitly with a
  `SELECT '[1]'::vector` on its first line. Earlier drafts credited the
  `vector(N)` typmod in the signature with forcing the load; that was true only
  for a superuser. Postgres checks a function's SET clauses before it resolves
  its parameter types, and a non-superuser owner — Supabase's `postgres` role,
  Neon, an RDS master user — in a session that had not yet touched pgvector was
  refused with `permission denied to set parameter "hnsw.iterative_scan"` on
  the upgrade path. Fresh installs passed because 001 had loaded the library in
  the same session; every verification here ran as a superuser and never saw
  it. The seventh review pass reproduced it. Every printed `ALTER DATABASE`
  remedy now carries the same load. A version of this function that silently
  ran without the setting would have exactly the recall 014 exists to fix.
- `relaxed_order`, not `strict_order`: the final `ORDER BY b.sim DESC` re-sorts
  the merged candidates anyway.
- `hnsw.ef_search` is left alone. At the default `match_count`, `v_fetch` is 40
  and the first batch satisfies the LIMIT, so the default unfiltered path returns
  the same rows — asserted row for row on 441 real queries by the eval's
  unfiltered control, which exits non-zero on any difference, and by row count
  in the bench.
- A NULL filter is unfiltered. 007 evaluated `NULL = '{}' OR metadata @> NULL`,
  which excluded every row.
- The plans, read from the deployed body (bench section C). The exact branch
  has one shape under either plan mode: a GIN bitmap on `thoughts` for the
  matched set, then index probes into `thought_chunks` with the matched ids as
  an array — the array form is what keeps the planner off a scan of the whole
  chunk table; written as a join, or as a LATERAL that Postgres pulls back up
  into one, its fixed 1% estimate for `@>` chose a sequential scan plus hash,
  6–11 ms at 100,000 rows and growing with the table rather than the match
  (two intermediate runs of this bench measured exactly that). The walk branch
  under the custom plan walks the HNSW index on both sides; under the generic
  plan, where the filter is a parameter, the `thoughts` side takes the GIN
  index and the chunk side walks its own HNSW index and looks each candidate's
  parent up. Both are exact for the filter, because the walk is iterative and
  bounded.

**The second defect the mechanism predicted.** `ORDER BY embedding <=> q LIMIT
200` returns 40 rows on a 10,000-row table, because the scan returns at most
`ef_search` and stops. So `v_fetch` above 40 was never honoured: with no chunk
rows `match_count = 50` returned 40, and with chunks the two CTEs together capped
near 80 — asked 100, got 68 to 79. 007's header calling the factor "a recall
budget, not a guess" was true only at `match_count <= 10`. The iterative scan
fixes this too: asked 100, got 100; asked 500 — the ceiling — got 500, in
6.8 ms at 10,000 rows and 28 ms at 100,000. (007 returned 69–77 for that ask
at 100,000 rows, and 500 at 10,000 only because the planner abandoned the
index for a sequential scan.)

**Cost, and the plan it no longer depends on.** The default path — unfiltered,
ten rows, what every first-party caller sends — costs what it did within the
run-to-run noise of this machine: median 0.62 → 0.67 ms at 10,000 rows and
1.26 → 1.37 ms at 100,000 in the seventh run, 0.61 → 0.61 and 1.32 → 1.28 in
the fifth; its branch has no predicate and no join. A thin filter — at most
1,000 matching thoughts, the exact branch — costs less than an unfiltered call:
at 100,000 rows 0.18 ms for a filter matching nothing, 0.24 ms for one matching
6 rows, 0.51 for 90, 2.6 for 998; at 10,000 rows 0.17–0.41 ms. The walk-only
body had paid 60+ ms for the never-matching case, and between 0.7 and 190 ms
for the thin tiers depending on which plan the planner's statistics sample
happened to favour that run (the ninth pass documented the variance; one run
took the 1% and 0.1% tiers to the GIN index at 2.2 and 0.7 ms, the next walked
both sides at 44 and 190 ms, same seeded data). There is no plan to favour now:
section C shows the exact branch as a GIN bitmap on `thoughts` and index probes
into `thought_chunks` under both plan modes. The statement every filtered call
runs first — the capped collection of matching ids that routes between the
branches — is explained on its own: 0.01 ms for the empty filter, and for the
50% filter at 100,000 rows 2.5 ms under either plan mode as a GIN bitmap over
50,000 matches, because GIN builds the whole bitmap before the LIMIT can stop
anything; that cost grows with the matches, and SMD-1018 measures it from a
million rows up (the previous run had seen the custom plan take a sequential
scan with a LIMIT at 0.4 ms for the same tier; the twelfth pass's scoreability
predicate tipped the estimate to the bitmap — the planner's choice, complete
either way). Broad filters take the walk: 1.6 ms at 10,000 rows for the 50%
and 10% tiers, 5.0 ms (50%) and 9.0 ms (10%) at 100,000, where section C shows
the custom plan walking both sides (7.9 ms) and the generic plan taking GIN for
`thoughts` and walking the chunk index (7.8 ms) — the same rows either
way, since the walk is iterative and bounded, and the function declares no plan
mode. Section D runs the walk's own statement on the thin and empty filters at
100,000 rows: about 63 ms each, every matching row returned, because both scan
bounds are in force (seeded at database level, the session reconnected to read
them). That is what the function no longer pays for those filters, and what
the bounds buy when a table large enough to walk for them arrives — past ~2.5
million rows at the default count, ~400,000 at the ceiling of 500, said the
arithmetic; the "At scale" section below has the measurement, which is not
that.

**Around it.** `deploy/compose.yaml`, `db/with-postgres.sh` and the CI service
containers now pin `pgvector/pgvector:0.8.6-pg16` instead of the floating `pg16`
tag, since 014 has a version floor. `preflight.ts` decides on the function's
BODY first — by the `ob1:filter-inside-scan` sentinel in the function source,
confirmed by a NULL-filter probe when there is a row to probe with — because no
setting can repair 007's LIMIT-before-filter, and only then on whether an
iterative scan is
in force, from the function's own SET clause or inherited from the database or
role. The version is consulted last, to explain an absence or to advise
`ALTER EXTENSION vector UPDATE` where the catalog record lags a working library
(the `hnsw.*` settings come from the loaded library, not from
`pg_extension.extversion`; a new binary over an old volume runs 014 correctly
while the catalog says 0.7.x, reproduced by the second review pass). The lookup
matches its siblings (name, namespace, argument count) rather than casting a
signature through `search_path`, the remedy is worded by the ledger since
"apply 014" is a no-op when 014 is recorded and a redefinition dropped the
clauses, the effective walk bounds are printed, and the whole check has its own
error boundary so a hardened server that hides `pg_available_extensions` costs
one warning rather than every check after it. On the PostgREST store, where the
catalog cannot be read, it probes: one RPC with a NULL filter returns a row
under 014's body and nothing under any earlier one — after confirming some row
has an embedding at all, and treating a failed probe as a skip rather than
evidence. (The first version was an unconditional warning that could never be
cleared; passes three, four and five each caught a case.) The migrator judges
the pgvector library version up front and refuses 014 itself, in `--dry-run`
too, while still applying earlier pending migrations and still seeding the
ledger under `--baseline`, and after 014 it reads `pg_db_role_setting` and
prints the two `ALTER DATABASE` statements when a non-owner role could not seed
the bounds — the DO block's WARNING is real but this client surfaces none. The
destructive guard the evals carried — refuse to drop a schema on a host that is
not this machine — lives in `dropSchema` now, and the one eval that drops
tables itself calls it. "This machine" means loopback, and nothing wider: the
fifth pass suggested sharing preflight's local-endpoint
predicate, which accepts RFC1918 and compose service names, and the sixth
caught that a LAN-hosted stack holding a real database is the documented
topology — so that widening is reverted. An EMPTY host is refused, because the
client resolves it through `PGHOST`. It honours the old
`OB1_EVAL_ALLOW_REMOTE_DB=1` alongside `OB1_ALLOW_REMOTE_DB=1`.
`test-schema.ts` [8b]
arranges sixty nearer rows in front of the filtered ones and asserts both come
back, including one reachable only through its chunk; `test-live.ts` [5b] asserts
a 1% filter over 1,000 random rows agrees with an exact scan on a real server.

**At scale — a million and ten million rows (SMD-1018).** Everything above
this line was measured at 10,000 and 100,000 rows, and the header's claims
past that — the seeded cap "covers tables to ~2.5 million rows at the default
count", the walk "visits about `v_fetch × N / v_exact` tuples", the routing
count's cost "grows with the matches" — were arithmetic. The bench now loads a
million and ten million rows (`OB1_BENCH_SCALES`), and the arithmetic did not
survive contact with the planner. Machine, for every number below: Apple M5
Pro host, podman libkrun VM with 8 vCPUs and 14.8 GB, `pgvector/pgvector:0.8.6-pg16`
(PostgreSQL 16.15) at its image defaults — `shared_buffers` 128 MB,
`work_mem` 4 MB — so the ten-million-row index lives in the VM's page cache,
not in Postgres's buffers. The 64-dimensional random corpus is the one above —
the vectors, the queries and the share tiers' membership at the two published
scales are exactly the published run's (nearest query-to-row cosine 0.560 and
0.588, as before), though each row's metadata now also carries the fixed-count
tiers it fell into, so the heap and the GIN index are a little wider — streamed
from the same generator in two passes so nothing holds a million vectors in
memory. The before arm runs at the published scales only; above them the
question is about the shipped function.

**Three full passes were run, and the tables are the third's — except the
two published scales, re-measured twice more after the third review pass
found the after arm's index full of dead twins (below); their rows are the
last pass's.** Latencies on this VM run two to two and a half times the
lines published above for the same tiers and vary by about 30% from pass to
pass (the before arm's default path at 100,000 rows: 2.4 ms in one pass, 3.3
in the next, against the published 1.26); the after arm's default path
matches the before arm's within that spread, as it did in the published run,
and the recall columns reproduce within 0.5. Between passes the recall
figures agreed within 0.3 — with one exception that turned out to be the
finding: for filters matching roughly half a percent to one percent of
the table, the planner's choice between the GIN index and the HNSW walk
flipped from pass to pass, at a million rows and at ten million, on the same
rows under a fresh `ANALYZE` each time. Where a cell below has two values,
that is why.

*The load.* Bun's SQL driver has no COPY protocol (a `COPY … FROM STDIN` hangs),
so rows go in as multi-row INSERTs into a table whose secondary indexes have
all been dropped and whose user triggers are disabled — 008's audit trigger
would otherwise write a row per row at every scale (it is in 001–013, so the
published run's `thought_audit` held a row per thought where this run's is
empty; nothing after 014 reads it), and 016's extraction trigger only above
100,000 rows, since the before arm loads under 001–013 and the whole schema
is applied above; what remains per row during the INSERTs is the heap and the
primary key, the same under either schema — the set of indexes rebuilt
afterwards is not, 023's and 025's three existing only under the whole one,
which is what the "other indexes" column counts — and only the INSERT
round-trips are timed. One
more thing the arms did differently, found by the third review pass and
fixed before the published-scale tables below were re-measured: at the two
published scales the after arm applies 023 onto the loaded rows, and 023's
apply-time fingerprint backfill rewrites every one of them (none carries a
fingerprint, and the column is indexed, so the update is not HOT) — a second,
identical HNSW entry per row beside a dead twin, which no VACUUM removed, so
the earlier passes measured the 10,000- and 100,000-row tables on a graph
half full of dead tuples that the large scales, whose schema is applied to an
empty table, never had. The after arm now VACUUMs after its migrations, and
the two scales were re-measured, twice — once after a plain VACUUM, once
after the VACUUM FULL the code now runs, which rewrites the heap and rebuilds
every index from scratch, the state the load produced, with the dead-tuple
count asserted at zero. The recall floor did not move (8.2 and 5.0 of 10
against 8.3 and 5.0: dead entries are skipped, not scored). What moved, in
both re-measurements, were the calls that read the GIN bitmap over the table
— the 50% tier 8.3 ms against 16.2 at 100,000 rows, its routing count 3.0
against 11 — while the default path and the ceiling moved by less than the
pass-to-pass spread. The published lines above predate 023, so they never had
the twins; what separates this VM from them is the machine and the day. The indexes are built afterwards with
`maintenance_work_mem` sized for the graph. The parallel build keeps the graph
in dynamic shared memory, which a container gets 64 MB of by default — the
first attempt failed at a million rows with "could not resize shared memory
segment … No space left on device" — so `with-postgres.sh` now takes
`OB1_PG_SHM_SIZE`. At ten million rows the graph fit in 9 GB (the container
peaked at 10.0 GB; pgvector's "graph no longer fits" NOTICE never fired) and
built in nineteen minutes. The bench's section L, as printed (the two large
runs with `OB1_PG_SHM_SIZE=4g` and `OB1_PG_SHM_SIZE=11g
OB1_BENCH_MAINTENANCE_MEM=9GB`, as the README's commands say; the count in
the "other indexes" column is the schema's — four under 001–013, seven under
the whole set — and was added to the printout after the two large runs):

| rows | source | oracle | schema | insert s | rows/s | chunk rows | chunk s | thoughts MiB | thoughts HNSW MiB | build s | chunks MiB | chunks HNSW MiB | build s | other indexes s (count) | maintenance_work_mem | workers |
| ---: | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: |
| 10,000 | loaded | computed | 001–013 | 0 | 47,123 | 4,000 | 0 | 4 | 5 | 2 | 1 | 1 | 0 | 0 (4) | 256MB | 4 |
| 100,000 | loaded | computed | 001–013 | 2 | 46,782 | 40,000 | 0 | 38 | 54 | 8 | 13 | 11 | 2 | 0 (4) | 256MB | 4 |
| 1,000,000 | loaded | computed | whole | 21 | 47,624 | 400,000 | 4 | 391 | 544 | 111 | 125 | 109 | 28 | 6 (7) | 977MB | 4 |
| 10,000,000 | loaded | computed | whole | 207 | 48,412 | 4,000,000 | 30 | 3907 | 5437 | 1134 | 1250 | 1099 | 327 | 63 (7) | 9GB | 4 |

The index is 1.4× its heap at this width and about 570 bytes a row (the
sizes are MiB; the heap is 410 bytes a row); the build
runs at ~9,000 rows a second in memory. A hundred million rows was not run:
by these slopes it is a 39 GB heap, a 54 GB index, 23 GB of chunks and their
index, a graph that wants ~90 GB of `maintenance_work_mem` to build in memory
(or pgvector's far slower on-disk phase), and about three hours of build — a
machine with 128 GB and 200 GB of fast disk. Nothing below is stated past ten
million except as that extrapolation.

*The unfiltered default path, and the floor under everything.* Ten rows asked,
no filter, median over 50 random queries, and — new in this run — the rows
scored against an exact scan of the whole table, at pgvector's default
`ef_search` of 40 and again at 400:

| rows | median ms, asked 10 | median ms, asked 500 | in exact top-10 (ef_search 40) | at ef_search 400 | median ms at 400 |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 10,000 | 1.82 | 15.3 | 8.2 | 10.0 | 4.7 |
| 100,000 | 3.25 | 54.8 | 5.0 | 9.5 | 13.4 |
| 1,000,000 | 6.95 | 181 | 2.2 | 6.8 | 41.7 |
| 10,000,000 | 17.7 | 224 | 0.5 | 2.9 | 49.0 |

The default path costs about 2× per decade of rows and is 18 ms at
ten million; the ceiling of 500 rows is a quarter of a second (0.7 s and 1.2 s in the two earlier passes — the widest spread in these runs) there. But the
recall column is the finding: at the default `ef_search` the index returns
**two of the true ten** at a million random rows and one in twenty at ten
million, and every filtered figure below sits under that floor — a 50% filter
cannot beat the index with no filter in the way. Raising `ef_search` tenfold
recovers most of it for 6× the latency. This is the "recall at these scales
is a floor" caveat the ticket carried, now with a number on it: random
uniform vectors in 64 dimensions are HNSW's worst case (every distance is
nearly the same distance), a real embedding corpus is clustered and will do
better, and how much better is a measurement on real vectors this run cannot
make (SMD-1039's corpus is the place; SMD-1465 is the question). What it can
say is that nothing in `match_thoughts` sets `ef_search`, so at whatever
scale a real brain's recall turns, the knob is a session or database setting
away and costs what the last column says.

*Filtered, through the function.* Ten asked, 50 queries, the tiers above
plus three fixed at 900, 2,000 and 5,000 matching rows wherever that is under
half the table (so not 5,000 at 10,000 rows), so the same filter can be
followed as the table grows. The `matches` column is
what was actually planted (a row count is a coin per row). At a million rows,
with the plan the function got this pass, and in brackets what the same tier
did in the two passes where the planner walked HNSW for it:

| filter | matches | returned | in exact top-10 | median ms | how the function answered |
| --- | ---: | ---: | ---: | ---: | --- |
| 50% | 499,443 | 10.0 | 3.0 | 38.6 | route ~27 ms, then the HNSW walk |
| 10% | 99,748 | 10.0 | 5.9 | 48.1 | route ~5 ms, then the HNSW walk |
| 1% | 9,951 | 10.0 | 10.0 (9.0–9.2) | 32.8 (279–287) | the "walk" branch served by GIN — exact (passes 1–2: the HNSW walk) |
| 5,000 rows | 4,916 | 10.0 | 10.0 (8.8) | 20.3 (352–368) | the same (passes 1–2: the HNSW walk) |
| 2,000 rows | 1,963 | 10.0 | 10.0 | 12.1 | the "walk" branch served by GIN — exact, all three passes |
| 0.1% | 1,034 | 10.0 | 10.0 | 9.0 | the same |
| 900 rows | 934 | 10.0 | 10.0 | 8.7 | the exact branch |
| 0.01% | 99 | 10.0 | 10.0 | 1.2 | the exact branch |
| nothing | 0 | 0.0 | — | 0.3 | one GIN probe |

And at ten million:

| filter | matches | returned | in exact top-10 | median ms | how the function answered |
| --- | ---: | ---: | ---: | ---: | --- |
| 50% | 4,998,406 | 10.0 | 0.8 | 268 | route ~240 ms of it, then the HNSW walk |
| 10% | 999,827 | 10.0 | 1.9 | 151 | route ~50 ms, then the HNSW walk |
| 1% | 99,633 | 10.0 | 10.0 (6.0) | 753 (1,450) | the "walk" branch served by GIN — exact, and slow (pass 2: the HNSW walk) |
| 0.1% | 10,231 | 10.0 | 10.0 | 97 | the same, all three passes |
| 5,000 rows | 5,088 | 10.0 | 10.0 | 52 | the same |
| 2,000 rows | 1,978 | 10.0 | 10.0 | 30 | the same |
| 0.01% | 959 | 10.0 | 10.0 | 10.6 | the exact branch |
| 900 rows | 886 | 10.0 | 10.0 | 9.4 | the exact branch |
| nothing | 0 | 0.0 | — | 0.2 | one GIN probe |

**What the arithmetic got wrong.** The header modelled the walk branch as an
HNSW walk that visits `v_fetch × N / matches` tuples and is cut by the seeded
bounds when that exceeds 100,000 — so at ten million rows a filter matching
2,000 thoughts (200,000 tuples by the formula) should have returned short
under the seed and complete only under a larger one. It returned 10 of 10 in
about 30 ms under the seed, under pgvector's defaults, and under any bound at
all, in every pass, because the planner never walked HNSW for it: with the
filter's selectivity in view (custom plan) it took the GIN index for the
`thoughts` side and the parent's GIN index for the chunk side, sorted the
matches by distance, and answered exactly. Section C reads that off the
deployed body at every scale, and section E runs every walk tier through the
function under the seeded bounds, under pgvector's defaults (`20000 / 1`) and
under the seed with `ef_search` raised — the ticket's own verification,
"returns exact under the seeded bounds and short under the defaults", asked
of the function rather than of a statement extracted from it — beside the
exact branch's own statement with its floor lifted to cover the same tier.
The third pass's section E, with the earlier passes' HNSW-walk cells in
brackets where the plan differed. The seeded column is section B's call for
the same tier made again later in the same session, as the paired control for
the other settings; where it reads under B's median, the difference is cache
warmth:

| rows | filter | matches | "walk visits" by the formula | seeded: in exact top-10 / ms | defaults: in exact top-10 / ms | ef_search 400: in exact top-10 / ms | exact branch, floor lifted: in exact top-10 / ms |
| ---: | --- | ---: | ---: | --- | --- | --- | --- |
| 1,000,000 | 0.1% | 1,034 | 38,685 | 10.0 / 8.5 | 10.0 / 9.6 | 10.0 / 9.8 | 10.0 / 9.3 |
| 1,000,000 | 2,000 rows | 1,963 | 20,377 | 10.0 / 15.2 | 10.0 / 13.7 | 10.0 / 12.5 | 10.0 / 15.6 |
| 1,000,000 | 5,000 rows | 4,916 | 8,137 | 10.0 / 22.6 (8.8 / 332) | 10.0 / 20.7 (**4.9** / 116) | 10.0 / 21.7 (8.9 / 364) | 10.0 / 28.4 |
| 1,000,000 | 1% | 9,951 | 4,020 | 10.0 / 37.9 (9.2 / 283) | 10.0 / 41.2 (**5.5** / 119) | 10.0 / 41.8 (9.2 / 322) | 10.0 / 70.9 |
| 1,000,000 | 10% | 99,748 | 401 | 5.9 / 67.0 | 5.9 / 65.7 | 6.6 / 91.9 | 10.0 / 784 |
| 1,000,000 | 50% | 499,443 | 80 | 3.0 / 40.9 | 3.0 / 38.1 | 6.4 / 66.0 | — |
| 10,000,000 | 2,000 rows | 1,978 | 202,224 | 10.0 / 30.1 | 10.0 / 31.7 | 10.0 / 31.0 | 10.0 / 18.6 |
| 10,000,000 | 5,000 rows | 5,088 | 78,616 | 10.0 / 51.7 | 10.0 / 52.3 | 10.0 / 51.4 | 10.0 / 42.0 |
| 10,000,000 | 0.1% | 10,231 | 39,097 | 10.0 / 93.5 | 10.0 / 92.5 | 10.0 / 92.4 | 10.0 / 119 |
| 10,000,000 | 1% | 99,633 | 4,015 | 10.0 / 708 (6.0 / 1,463) | 10.0 / 713 (**2.7** / 368) | 10.0 / 719 (6.2 / 1,572) | 10.0 / 944 |
| 10,000,000 | 10% | 999,827 | 400 | 1.9 / 125 | 1.9 / 124 | 2.5 / 158 | — |
| 10,000,000 | 50% | 4,998,406 | 80 | 0.8 / 230 | 0.8 / 233 | 2.9 / 268 | — |

Read across a row and four things fall out.

- **Between about half a percent and one percent of the table, the walk
  branch is on the planner's edge, and which side it lands on is decided by
  the statistics sample.** At a million rows the 5,000-match and 10,000-match
  tiers walked HNSW in two passes (332 ms and 283 ms for 8.8 and 9.2 of 10)
  and were served from the GIN index in the third (23 and 38 ms for 10 of
  10); at ten million the 1% tier was served from GIN in two passes (753 and 794 ms for 10 of 10) and walked HNSW in one (1,450 ms for 6.0). Same rows, same statistics
  target, a fresh `ANALYZE` each time. The GIN side of the coin is exact and
  an order of magnitude cheaper; the HNSW side is approximate, slower, and the
  only place the seeded bounds do anything.
- **The seeded bounds matter on that HNSW side, and nowhere else.** In the
  passes that walked, the same tiers lost three to four points of recall
  under pgvector's defaults (8.8 → 4.9, 9.2 → 5.5, and 6.0 → 2.7 at ten
  million) and kept them under the seed. Which of the two bounds bit is
  inferred, not measured: section E moves both together (`20000 / 1` against
  `100000 / 8`), and the formula that says 4,000–8,000 tuples sit well under
  the default cap of 20,000 is the formula this section retires — pgvector
  counts every tuple the scan emits, filter-rejected ones included, so the
  cap may be what bit. The second review pass of 014 measured the memory
  bound binding first at 100,000 rows (`work_mem × 1` is 4 MB; the visited
  set is graph nodes, not emitted tuples), which is the reading here too, and
  two arms that move one bound each (SMD-1464) would settle it. Either way
  the header's "pgvector's default covers 500,000 rows at the default count"
  is wrong in the direction that matters, and the seed covers the case.
  Everywhere else nothing binds:
  every thinner tier is served by GIN whatever the bounds say, and the broad
  tiers (10%, 50%) need a few hundred tuples and are bound by nothing but
  `ef_search`. **Neither seed should scale with the table**; what they buy is
  the HNSW side of that band, and they buy it.
- **The exact branch with its floor lifted is exact, and its cost is the
  match count: 6–8 µs a matching row at a million rows** (28 ms for 4,916,
  71 ms for 9,951 — primary-key probes into a heap that fits in the page
  cache), and 9–17 µs at ten million across the passes (42 ms for 5,088 and
  944 ms for 99,633 in the third; 165 ms for 10,231 in the second), where the
  heap no longer sits in Postgres's buffers. That puts it well under the HNSW walk in the
  band (28 against 332, 71 against 283) and a little over the GIN-served walk
  (28 against 23, 71 against 38), and far over either at 100,000 matches
  (784 ms against 67 for the 10% tier at a million rows). So raising the
  threshold from 1,000 to about 10,000 is not a universal win but a hedge: it
  takes the band off the planner's coin at the cost of a few tens of
  milliseconds on the GIN side, and it should not scale with the table. That
  is a decision with a migration behind it, not a bench's to make; the
  numbers are in SMD-1464, and the header's arithmetic is retired here either
  way.
- **The recall the walk loses on broad filters is the index's, not the
  filter's.** 10% and 50% at a million rows score 5.9 and 3.0; the unfiltered
  default path scores 2.2 on the same corpus. The iterative scan keeps going
  for a filter and finds a little more than the plain scan does — which is the
  fix working — and `ef_search` at 400 lifts both tiers to 6.4–6.6. A brain
  that large wants a larger `ef_search`, whatever it does about filters, and
  the measurement to size it is on real vectors (above).

*Two costs that do grow with the table, measured.* The routing statement —
the capped GIN collection every filtered call runs first — builds its whole
bitmap before the `LIMIT v_exact + 1` can stop anything, and at 50% that is
0.8 ms at 10,000 rows, 3.0 at 100,000, 27 at a million and 240 at ten
million: about 50 ns a matching row, linear, paid by every broad filtered call
before the walk starts, and at ten million it is nine tenths of the 50%
tier's whole latency. The mitigation the twelfth review pass declined for want
of a number — estimate the match count from `pg_class.reltuples` and the
planner's `@>` selectivity, or a `TABLESAMPLE`, and run the capped collection
only when the estimate is plausibly under the threshold — now has its number
and is SMD-1463 (done: migration 037, change 70). And the plan mode: plpgsql runs a statement's first five
executions on custom plans and may switch to a generic one after; for the walk
branch the generic plan has the filter as a parameter and a flat estimate, and
section C shows what that costs at a million rows — the 50% tier 292 ms
generic against 15 custom (a GIN bitmap over 499,443 rows sorted by distance,
where the custom plan walked HNSW for 80 tuples), the 0.1% tier 360 ms
against 6 (the chunk side walking its HNSW index through some twenty thousand
parent lookups where the custom plan took the parent's GIN bitmap).
At ten million the generic plan for the 50% walk takes **11.6 seconds** (a
GIN bitmap over 4,998,406 rows — hundreds of thousands of its heap blocks
lossy under 4 MB of `work_mem`, every one rechecked — sorted by distance, on
both sides) where the custom plan walks HNSW in 15 ms, and `jit = off`
changes nothing there (11.7 s): that cost is the bitmap. Every other generic
plan at ten million carries 30–110 ms its custom twin does not — the routing
count on the EMPTY filter 31 ms against 0.03, the exact branch 108 against
24, the 2,000-row walk 136 against 20 — and with `jit = off` those become
0.03, 11 and 23: **it is JIT.** The generic plan's flat estimate carries these
statements' costs past `jit_above_cost` (100,000) somewhere between a million
rows (where the same generic route on the empty filter costs 0.02 ms) and ten
million, and every call then compiles its expressions, the way 017 found
`search_thoughts_hybrid` doing (15 ms where its arms cost 1.3). The second
pass of this bench could only infer that, because its EXPLAIN ran with
`COSTS OFF`, which also suppresses the JIT summary; the explainers now print
costs and section C carries the `jit = off` arm. One more thing the harness
change moved: the shared rewrite now splices the routing collection into the
exact branch as one materialized CTE where it had spliced a scalar subquery
per `v_ids` reference — two GIN collections per call where the function runs
one — so `bench-plan.ts`'s filtered `exact` rows and section C's exact rows
read one collection fewer than 019's header publishes for the same tier
("5.4–6.5 ms for 936 matching rows at 100,000"); the function did not change,
the harness did, and 019 is checksummed, so the note lives here and in
bench-plan's header. Every session of this bench stayed on custom plans throughout
— the medians above are the custom plans' — but the choice is the planner's
estimate against its own average, made per session after five calls, and a
session that lands on the generic plan pays these numbers on every filtered
call. 014 removed the function-level `plan_cache_mode` on purpose (the ninth
review pass, above); whether it comes back is part of SMD-1464.

*Section D at scale.* The walk's own statement forced onto every tier under
the threshold and the empty filter, where it has next to nothing to find:
29 ms for ~1,000 matches and 145–147 ms for 90 or fewer at 100,000 rows,
395 ms (900 matches), 1,193 ms (99) and 1,065 ms (none) at a million, and
85–99 ms at ten million — the bounds hold it to about a second whatever the
table, which is what they are for, and the function never sends those filters
there.

*What was not corrected, and where the correction lives.* The ticket asked
for 014's header to be corrected where its arithmetic does not hold. It does
not hold, and the header is not edited: migrations are append-only and
checksummed — the migrator prints `ALREADY APPLIED BUT FILE CHANGED` and exits
non-zero on any edited migration (change 56 made `--reapply` refuse the same
way), so a comment fix in 014 would cost every deployment a hand edit of
`schema_migrations`. The correction is this section, the bench's own header,
and a line in the header of the next migration that redefines
`match_thoughts`; 019 and 020 carry 014's body comment ("the seeded bounds
are its ceiling on tables past ~2.5 million rows") verbatim, as snapshots do,
and the redefinition retires it there.

**Not done here.** A hundred million rows (above: the machine it needs). The
recall floor on real embeddings rather than random vectors, and the
`ef_search` that follows from it (SMD-1465). SMD-969 asked whether the
*unfiltered* candidate scan reaches the HNSW index at scale: at 64 dimensions
it does at every scale here (section A's row counts and the default path's
slope, 1.8 → 3.3 → 7.0 → 17.7 ms), and at the shipped width change 36
measured it to 100,000 rows, where the answer was no until 019; the shipped
width at a million rows is 4 GB of vectors a run this bench has not made.
SMD-958 (change 32) built beside this body and SMD-945 (change 37) redefined
it on this body; neither reintroduced the post-filter.
