# 76. The kept bench corpus answers the exact oracle from its marker — `bench-hnsw.ts` records the exact pass's answers when it builds, and a reuse takes the first Q of them and computes only what the marker lacks (SMD-1562)

Change 72 made a `bench-hnsw.ts` pass at ten million rows reusable: 37 min 9 s
for the run that built the corpus, 7 min 24 s for the one that reused it. Most
of the seven minutes was the exact oracle — for each of the eight tiers and
once over the whole table, for each of fifty queries, an exact scan of ten
million rows with the vector index kept out of the plan: about 450 full scans.
Its answers are a pure function of the corpus (the seed and the scale), the
query count and K — the same on every reuse, and recomputed on every reuse.
Change 72's eighth and ninth review passes named it as the first thing cut for
space, and its boyscout left it out as new behaviour.

**The cache (`db/bench-hnsw.ts`).** The marker gains one field, `oracle`: a
map from the *shape* of the exact pass — a digest of the oracle's statement
in both filter forms (K inside it), the tier filter's form, a probe of how a
vector is rendered into its literal, and a probe of the server's distance
kernel — to that shape's entry: a digest of each query's literal, in
order, and for each tier key and the whole table one answer per query, the
exact top-K ids in distance order and the nearest row's cosine (the whole
table's is the confound the run prints). A build writes it with the marker,
after the exact pass — the marker was already written last, once the pass's
own confound gate had passed, so a refused build still leaves nothing. A
reuse looks up its own shape's entry, checks it whole (one well-formed answer
per query for every key: distinct ids, exactly as many as the exact answer
holds — K, or every matching row where fewer match — and a finite cosine),
and
takes answers from the front while the entry's query digests match its own:
the queries are drawn from the seeded stream after the rows' draws, so the
first Q of a longer run's queries *are* a shorter run's, and a run asking
fewer needs nothing computed. A run asking more computes the queries the
entry lacks — per key, only those — and writes its entry back whole, merged
into the map beside other shapes' entries; an entry answering for every query
is left as it is. Before anything is computed the plan the statement gets on
this server is read once, and a plan that reaches the vector index is
refused: the pass is exact because `enable_indexscan` is off and
`enable_seqscan` on, and an approximate pass written under a shape that
vouches for it would be trusted by every later reuse. The confound is the
largest nearest-cosine over this run's whole-table answers, the marker's and
the computed alike, and the gate on it stays. No new invalidation: the
answers are valid exactly while the rows are, and they ride inside the marker
whose physical fingerprint a reuse judges first — every refusal (another
scale, other parameters, a `rewritten` corpus, counts or regenerated rows
that differ, a ledger stranger, a drifted migration, a relation that moved,
a row written since the build's transaction id) exits before the oracle is
consulted. A marker without an entry for this shape — written before this
change, or by a tree whose statement differs — or whose digests stop
matching is computed for and extended, not refused: the answers are
derivable, the thirty-minute build is not, and `MARKER_FORMAT` stays at 2
because the cache names its own inputs. Answers are written back only under
`OB1_PG_KEEP` (a persistent database reached some other way is not this
bench's to mark), and the run says which: `corpus kept: marker written`,
`marker extended: … (had n, m of them this run's)`, or `not kept`. The oracle
hands its ids back in distance order (the marker's form) and the arms score
against those lists; the run line says `reused from the marker (…)`, `n of Q
queries from the marker, computing the rest` or nothing, as before; and
section L gains an `oracle` column — `computed`, `reused`, or `n of Q
reused, the rest computed` — beside `source`, since the heap is warmer after
a computed pass and latencies compare between rows with the same value. At
ten million rows and fifty queries an entry is nine keys × fifty × ten
uuids, under 200 KB of jsonb.

**Held to the computation (`db/test-bench-reuse.ts`, new).** The claim that
matters is that what a reuse takes from the marker is what it would have
computed, and two builds cannot test it — the parallel HNSW build gives two
graphs, and two recall figures — so the suite runs the bench eight times
against one database at 150,000 rows (the smallest kept scale) and compares
on one index: a build with five queries; a reuse with three (all the
marker's); the marker's answers removed, as a marker from before this change
has none, and three again (computed, the marker extended) — sections A, B, D
and E equal the previous run's, timings aside, and the confound agrees; one
whole-table answer given a duplicated id, and three again (the entry
discarded, computed, written back whole); the entry's second query digest
changed, and three again (one from the marker, two computed); six (three
from the marker, three computed, the marker extended to six); six again (all
the marker's, the tables as the run that extended it); then the corpus
marked `rewritten` as a refused reuse leaves it, and a run refused before
the oracle is consulted. It runs under `with-postgres.sh` like every
suite and tells only the bench it spawns that the database is kept — to the
bench, "kept" is the variable and the marker row, and the volume is the
wrapper's concern, held by change 72 — so the throwaway container is the kept
database for the runs and nothing outlives the suite; it drops its
marker table on the way out and takes about three minutes, which is why it
is in neither CI nor `ci-parity.sh`. A mutant that takes the *last* answers
the marker holds instead of the first fails exactly the equality.

**First review pass.** The cache named the rows it was valid for (through the
marker's fingerprint) but not the queries or the oracle's statement it was a
function of; it now carries a digest of each query vector and an
`ORACLE_SHAPE` number beside K, and a reuse takes answers from the front only
while the digests match its own queries — a changed stream, another K or
shape, or a malformed field answers for nothing and is computed for, and
each element is checked to be an answer before any is trusted (a marker
edited by hand would otherwise have been a bare `TypeError` after the
fingerprint was paid, or a silent recall of zero). The answers are one
record per (key, query), `{ids, top}`, where the confound had been a parallel
array aligned only by the loop that filled it; the three-way state — every
answer the marker's, some, none — is named once and rendered from there; the
spread over Q arguments that would have died at a million queries is a
reduce; and the marker line says what the marker had and how many of them
were this run's, where it had said `had none` for a record it was replacing.
The suite, which then drove `with-postgres.sh` itself under a kept name,
gained what that lifecycle needed: `--no-env-file` reaching a bun fronted by
the wrapper (it was loading `db/.env` for every `OB1_*` name the suite had
just stripped; reproduced with a flag in the file), removal of the container
and volume on an interrupt, the volume named up front, a thrown stop turned
into a failure with a tally rather than a stack trace, and one helper for
the two scored-table comparisons that carries the rows guard to both sites.

**Second pass.** The shape number was a hand-bumped integer standing in for
the statement's identity, which an edit to the statement would not bump; the
oracle's SQL is one function now, and `shape` is a digest of it rendered over
placeholders (both filter forms and the tier filter's), so a tie-break or
another operator recomputes on its own. `markerAnswers` hands back the
answers it validated rather than counts the caller re-derives through two
non-null assertions; the three-way state is one value the four renderings
index; the extension write is gated on `OB1_PG_KEEP` as the first write is
(a persistent database reached some other way is marked by neither). And a
second round on the suite's kept-volume lifecycle: the interrupt handler had
been fire-and-forget beside a main flow that did not know it had fired, the
runtime was a second copy of the wrapper's pick, the environment strip took
the wrapper's own knobs with it, `runScript` matched only a leading `bun`;
each was fixed (and the interrupt verified in run 1 and a later run: exit
130, nothing left), the build's workers and memory pass through the strip,
which is `shellWithoutOb1()` shared with `migratorEnv`, `scored()` gates on
the section letter by regex (the empty section had matched
`"ABDE".includes`), and the catch keeps the stack.

**Third pass — the mechanism was the finding.** Three passes in a row had
found seams in the suite's container-and-volume lifecycle (the runtime it
parsed from the wrapper's banner was a basename the wrapper itself may not
have on `PATH`, so the removal would have thrown inside `finally` on the very
macOS layout the README names), and what the bench means by "kept" is a
variable and a marker row: the suite now runs under one ordinary
`with-postgres.sh` container and tells only the bench it spawns that the
database is kept. Six kept volumes, the interrupt handler, the runtime pick
and the argv heuristic in `runScript` (back to a command that *is* bun, by
basename) went with it; the suite drops its marker table on the way out, so
it could join `ci-parity.sh` and stays out only for its three minutes. In
the bench: the marker's `oracle` is a map keyed by statement shape, each
tree writing its own entry beside the others' (`jsonb_build_object` over the
existing map) rather than over them — a kept volume outlives branches, and
two trees that disagree on the statement would otherwise have recomputed the
pass on every switch; the per-query digest covers the literal the server
parsed, not the doubles it was rendered from; an answer is at most K
distinct ids (a duplicated or overlong list had passed and skewed the
denominator); `markerAnswers` returns how many the entry held, so the
marker's line no longer reads a raw field the helper had rejected; the
three-way state is one `note` the run line, the cell and the confound's
parenthetical are read from, and the cell says `computed … not kept (no
OB1_PG_KEEP)` where the answers went nowhere, instead of `extended`; and the
arms take the answers themselves (`ids.includes` over lists of at most ten)
where a second copy as sets had stood behind eight non-null assertions.

**Fourth pass.** Two things at the root. The suite's exit dropped the marker
table unconditionally — under a kept name it would have dropped a kept
corpus's marker, the one witness `dropSchema` has, after run 1 was refused
for asking another scale; it now refuses a database that already holds a
marker and drops only the one it planted, on a normal exit and on a signal
(Bun runs no `finally` on one), through a connection it opens only after
the throwaway-database guard the other suites' resets go through. And the
oracle's exactness rested on `enable_indexscan = off` alone, unasserted:
with `enable_seqscan` also off — 019's setting on `match_thoughts`, or a
database- or role-level one — the planner reaches for the HNSW index again
(EXPLAIN on the bench's image), and this change raises the stakes, since an
approximate pass would be kept under a shape that vouches for it; the scan
now sets both, the settings are in the shape, and the plan is read once per
scale and refused, in the named form, if it touches the index (reproduced by
forcing `enable_seqscan` off: the refusal quotes the `Index Scan using
thoughts_embedding_idx` line). Then: `amendOracle` merges into
the map only where the map is an object (`||` on a hand-cleared `null` built
an array and killed the cache from then on); the shape digests a rendering
probe of `lit`, so two trees that agree on the statement and differ in the
literal — a last-ulp change in the generator, a formatter — hold two
entries instead of overwriting each other's; section L's `oracle` is its own
column, decided by provenance alone (`computed`, `reused`, `n of Q reused,
the rest computed`), and where the answers went is the marker lines' to say,
with a line for the reuse that was not kept; an entry carries only its
queries and answers, its key being the shape; the prewarm comment no longer
claims a heap warmed by a pass a reuse does not run, and says which rows'
latencies compare; the suite asserts every scored section is present rather
than a row count both reports could lack a section under; and this
section's lead now describes the shipped mechanism rather than the first
draft with the passes as errata.

**Fifth pass, on the tree merged with main** (SMD-1544 took change 73; this
section became 74 — and 76 once SMD-1480 and SMD-1259 took 74 and 75). The exact statement orders by distance *and id*: the
column is `vector(64)` and the cosine accumulates in float4, so distinct
rows can tie at rank K, and without the tie-break the id kept was whichever
worker's stream it landed in — an answer the marker keeps must not depend
on the plan that computed it. The map's key gains the server's side: a probe
of the distance kernel (the cosine between two fixed vectors, as text),
since the kernel's last bits differ between pgvector builds and CPUs, a
pinned image *tag* does not fix that and `extversion` does not show it; and
the planner settings leave the key — they decide the plan, which the plan
check holds, and a reordered `SET LOCAL` should not cost a recomputation.
An entry's whole-table answers must hold exactly K ids (a kept scale has
more than K rows; a trimmed list had passed and would have read as recall
lost). The suite: it had proved no marker existed when it started, so the
marker it finds at the end is its own and is dropped whether or not it
read run 1's line saying so (the line came after the commit; a Ctrl-C in
between would have left the marker); a signal is noted rather than acted
on, the run in flight finishes, the next run throws, and the drop happens
once in `finally` before the signal's exit — the handler had been dropping
the marker while the main flow, whose child had died of the same signal,
went on to spawn the next bench onto the dropped marker, which would have
rebuilt the corpus and written a new one. Two planted malformations join
the runs — a duplicated id in one whole-table answer, and a query digest
changed at index 1 — asserted to be computed for (`had none`) and to answer
for one query only (`1 of 3 reused`), so the guards and the prefix walk are
no longer mutant-blind; the remote-database flags pass through to the
spawned bench, which had refused a database the suite accepted; the marker
table's name is one exported constant the suite, the bench and `dropSchema`
share; and the suite reads section L's `oracle` cell rather than the run
line's prose. Declined: rewriting the statement as an `OFFSET 0` fence so
exactness holds by construction — the plan check already asserts it, and
the fence would trade a measured parallel top-N (Gather Merge over
per-worker sorts) for an unmeasured leader-side sort.

**Sixth pass — the stop signal.** Its top findings were the fifth's fixes:
the kernel probe keyed the cache on a float8's *text*, which the session's
`extra_float_digits` shortens (a role default set by some other tool would
have keyed a volume away from itself), so the probe renders under a pinned
setting; the tie-break had left the plan check's refusal blaming a database
setting its own `SET LOCAL` excludes, so the check judges by node kind (any
`Index Scan` over the one relation) and says what can still cause it; a
signal between runs still spawned the next bench, so the check comes before
the spawn too, and the header says what happens to a run in flight under a
group signal; a tier answer of any length up to K was trusted, so every key
is held to the exact answer's own size (K, or the rows that match); and a
malformed entry had read as `had none` again, so it counts what it held.
The guards themselves had been mutant-blind under two twenty-second
container runs — five of seven clauses could go and the suite would pass —
and the bench is a script that connects at import, so the pure part moved
to `db/bench-oracle.ts` and `test-schema.ts` [37] drives it in milliseconds
with the mechanism removed a clause at a time. Then: a run that exits other
than expected stops the suite with its output rather than cascading nulls
through the runs after it; the marker's DML reads the table's name from the
one constant; the remote-database flags are named once beside the guard
that honours them; and this section's lead names the kernel probe and not
the settings. Two passes had opened with the previous pass's fixes as the
top findings, which is where the loop stops.

**Seventh pass, at the user's call.** The key named the statement and the
kernel but not how `oracle()` turns the rows into what is stored (the
nearest row's `1 − d`, the ids in row order, `−1` for none), so a tree that
derived an answer differently would have read earlier entries as its own;
an ANSWER_FORM tag is one more element of the shape. The plan check's
`Index Scan` match also matched a `Bitmap Index Scan` line — the exact
bitmap over the GIN the comment beside it excludes — harmless on the
whole-table form it reads today and wrong the day the check reaches a
filtered form; a `Bitmap` prefix is excluded. The first query's digest joins
the key, so a tree whose query stream differs (an edit to the draws that
leaves the rows alone, which the regenerated rows do not catch) is another
entry beside the others rather than a write over them, and the write-back
that shortens an entry is left only for a stream that changed after its
first query. Then: the planted duplicate is the last id copied from the
first, the same length at any K, where `- 9` had spelled K = 10 and would
have let the length guard reject it before the distinctness guard was
reached; a run that exits other than expected is one tallied failure, not
two; the PGlite case is [37] (two blocks had carried [35]); the README's
expected outcome says the tally the suite prints; the lead counts eight
runs and names the two planted ones; the marker's binding comment names
`unsafe`'s parameter array, where the tagged template it described is gone;
`markerAnswers` is called as the total function [37] proves it to be, with
no ternary in front of it; and the 25-line JSDoc the extraction left behind
is the entry's, in its module.

**Boyscout, while the files were open** (what the passes cut for space, no
behaviour change): the marker-table probe is one `hasKeptCorpus` the bench,
the suite and `dropSchema` share, where three had spelled the `to_regclass`;
the digest uses `node:crypto`'s `createHash`, as `migrate.ts` and `auth.ts`
do, in place of Bun's hasher; the suite's two table readers share one cell
splitter and the section-L reader finds the data row from the separator
rather than by position; and the oracle entry is built where it is written
rather than on every path. A second look found the run line saying `done`
after a pass the marker had answered, and let it end as it stands. Left as
they were, being behaviour or outside the touched files: test-live's own
by-hand `OB1_*` strips, which
`shellWithoutOb1` could replace; a `--json` report the suite could compare
as data rather than scraped markdown; and prewarming the metadata GIN on
both paths so a reused row's first tier queries find it warm.

**Measured at ten million rows**, on the kept volume `hnsw10m`, with the
caveat that another session's ten-million-row store benchmark held two to
four of the VM's eight cores throughout, so no wall clock here is change
72's 7 min 24 s reuse's peer. The build took 56 min. A reuse that met the
marker as SMD-1493 wrote it — no answers — computed the exact pass and
extended the marker within about five minutes of connecting, then spent
52 minutes in sections A–E under that load (56 min 45 s in all). The reuse
after it took every answer from the marker (`exact oracle reused from the
marker (all 50 queries)`) and was into section A within three minutes of
connecting; its arms then took 78 minutes as the neighbour's load rose (81
min 1 s in all). Sections A, B, D and E of the two runs are identical cell
for cell, timings aside — the suite's comparison, run over the two reports.
The marker grew from 2,018 bytes to 208,858 with the one entry: ten keys ×
fifty queries × ten uuids. What the change removes is the exact pass, and
under the load it was worth about five minutes of a reuse here; alone, it
was most of change 72's seven.

Upstream status: **not applicable** — a fork-only bench harness. **Unfiled**
upstream. Reproduce: `./with-postgres.sh bun test-bench-reuse.ts`; or
`OB1_PG_KEEP=x OB1_BENCH_SCALES=150000 ./with-postgres.sh bun bench-hnsw.ts`
twice, the second run's section L reading `reused` under `source` and
`reused` under `oracle`.
