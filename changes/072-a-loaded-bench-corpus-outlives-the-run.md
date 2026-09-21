# 72. A loaded bench corpus outlives the run — `OB1_PG_KEEP` keeps the container and a named volume, and `bench-hnsw.ts` reuses the corpus it finds there, checked and re-migrated, instead of rebuilding it (SMD-1493)

A `bench-hnsw.ts` pass at ten million rows is about forty minutes, and thirty of
them are the load and the index builds (change 28, "At scale": 207 s of
INSERTs, 1,134 s for the thoughts HNSW index, 327 s for the chunk index, 63 s
for the rest). The corpus is deterministic — the same scale is the same rows —
and SMD-1018's three passes rebuilt an identical table three times before
measuring anything: an hour and a half spent on what the first pass had built.
`with-postgres.sh` starts a throwaway container and removes it, with its
anonymous volume, on exit; nothing survives a run by design (776 leftover
volumes, 79 GB, once filled a podman VM — change 20's review pass).

**The container (`db/with-postgres.sh`).** `OB1_PG_KEEP=<name>` mounts a
*named* volume, `ob1-pg-keep-<name>`, at the data directory and otherwise runs
as every run does — a fresh container, `stop`ped on exit with two minutes for
Postgres to checkpoint a large database cleanly (the runtimes' default ten
seconds would SIGKILL it into crash recovery on the next start) and then removed
with `rm -v`, which removes *anonymous* volumes only on both runtimes, so the
named one survives and the exit line prints the one command that removes it.
The next run under the same name mounts it again; the image, shared memory and
port given then apply, as on any run (the first draft `start`ed the kept
container instead, which froze all three at creation and put the random port
back in the way of "address already in use" — the review pass had the simpler
shape). The container carries the name too, so a second invocation while the
first is running is refused before anything starts — sharing would let
whichever exited first stop the database under the other — and a stopped shell
an interrupted run left behind is removed (its data is in the volume). Under
the variable the readiness wait is thirty minutes rather than one: a kept
ten-million-row data directory may start into crash recovery and replay WAL
for minutes, and giving up would stop it mid-replay and start the next run
over. Cleanup touches only a container this invocation started. Without the
variable the script does what it did: a fresh container, removed on exit, no
volume behind it.

**The corpus (`db/bench-hnsw.ts`).** A scale above the before arm's (100,000
rows — below it the before arm needs 001–013 under the rows and a build is
seconds) is applied through **`migrate.ts`** now, not `applyMigrations`' bare
apply, so the migrator's ledger records what the schema is; and once the load
and every build have finished the bench writes one marker row
(`bench_hnsw_corpus`: the scale, the parameters that shape the rows — width,
tiers and their shares, the chunked share — the tier match counts it counted as
it generated, and section L's numbers). An interrupted load leaves no marker and
nothing reads as a corpus (the oracle's premise — every chunk carries its
parent's vector — is checked on the build, before the marker, and on a reuse
only when the ledger differs from the one the marker says it last passed under,
since that join over every chunk row costs a minute at ten million rows and a
migration applied onto the table is the one way a kept chunk vector can
change). The next run at
that scale finds the marker and, in this order, (1) counts both tables against
the marker and regenerates the corpus's first and last rows from the seed,
comparing the tiers exactly and the vectors to float32 — a generator change or
a foreign table cannot pass as the corpus, and is refused before the migrator
walks it; (2) reads the ledger against the tree and refuses a name the ledger
records that no file carries — a corpus migrated from another branch, which the
runner would not notice; (3) runs `migrate.ts --dry-run` and refuses on its
`DRIFTED` before anything runs — a plain run reports a recorded file edited
since, but only after applying every pending file around it, which on a kept
corpus would land a migration and then say "nothing was measured" — then
`migrate.ts` itself, so a migration added since the build is **applied onto
the corpus** (as onto a real brain that size, which is the measurement wanted),
the files it recorded read back from the ledger rather than scraped from its
output — and refuses the corpus if those files *rewrote rows* (the update and
delete counters moved), since a heap at twice its pages and HNSW graphs of
repaired twins are not the bulk-built state the marker's sizes describe, and
the `VACUUM FULL` that would restore it is the rebuild the reuse exists to
avoid; (4) reads both HNSW relations into the page cache (`pg_prewarm`, best
effort), so the walks time the same cache a fresh build leaves; (5) takes this
run's queries' confound from the exact whole-table pass section A already runs
(the build's client-side check covered the build's queries; an index probe
would see only its first `ef_search` candidates) and re-checks the oracle's
premise whenever the ledger differs from the one the marker says it last passed
under; then goes on to the oracle. Section L
gains a `source` column — `loaded`, or `reused (built <when>)` (change 76 adds where the exact oracle's answers came from) with the build's
own numbers — and the run says which it did, what it counted and which files it
applied, so a report never silently mixes a fresh build's load line with a
reused corpus. A kept database holds **one** corpus: a run asking for another
scale than the one an *earlier* run kept is refused before anything is dropped,
naming the three ways past (reuse it, run the other scale without `OB1_PG_KEEP`
or under another name, or remove the volume) — a corpus this run built itself
is this run's to replace, so the header's two-scale command keeps the last (the
first draft refused its own second scale, after building and measuring the
first: review pass); a corpus of the right scale built from other parameters is
rebuilt, said aloud. The loopback guard every destructive statement used to
inherit from `resetSchema` is asked once, up front, since the kept paths drop a
marker table and run the migrator without it. `test-support.ts` gained
`migratorEnv()` (test-upgrade's local copy, shared), `runMigrator()` (the spawn
three files spelled for themselves) and `ledgerStrangers()`; `test-upgrade.ts`
[15] holds the last one's contract — a bare apply has no ledger, the migrator's
names only the tree's files, a stranger is reported by name where a plain
`migrate.ts` run skips everything and exits 0. That the migrator itself never
looks for a recorded name it has no file for — so `--reapply`'s "every recorded
migration" is silently short on such a brain — is SMD-1504's, not this
change's: a bench ticket does not change what the migrator refuses.

**Measured.** At ten million rows (the README's command: `OB1_PG_SHM_SIZE=11g
OB1_BENCH_MAINTENANCE_MEM=9GB`, 50 queries, the same VM as change 28's
"At scale"): the run that built the corpus took **37 min 9 s** end to end —
206 s of inserts, 1,059 s and 267 s for the two HNSW indexes, 60 s for the
rest, the numbers change 28's third pass records — and the run that reused it
**7 min 24 s**, against the ticket's fifteen: `10,000,000 thoughts and
4,000,000 chunk rows counted, rows 0 and 9,999,999 regenerated from the seed
and matched`, `schema already at the tree's; nothing applied`, the confound
0.656 from the exact pass, section L reading `reused (built …)` with the
first run's numbers. The two runs' recall columns are identical (0.6 / 3.4 of
ten unfiltered at `ef_search` 40 / 400; 0.7 at 50%, 5.1 at 1%) and their
latencies sit inside the ~30% pass-to-pass spread change 28 reports (the
default path 7.8 against 10.1 ms), so the fresh container's cold index, once
warmed by the untimed pass, does not show in the tables. Of the seven
minutes, the exact oracle — 500 exact scans of ten million rows — is most,
which is why caching its answers in the marker is the first cut-for-space
item below. At a million rows: the fresh kept run 6 min 49 s, the reuse 3 min
45 s. At 150,000 rows (the
smallest kept scale; 3 queries): a fresh kept run 27 s, the reuse 5 s, with
`150,000 thoughts and 60,000 chunk rows counted, rows 0 and 149,999 regenerated
from the seed and matched` and `schema already at the tree's; nothing applied`.
With a pending probe file in the tree (numbered after its last) the reuse
printed `migrations applied onto it this run: …` and went on; with that file
edited after being recorded and a second probe pending beside it, the run was
refused on the dry run's `DRIFTED 1` and the second probe was never applied;
with the file removed from the tree, the bench refused on the ledger's stranger
by name. A run asking for 10,000 rows against a kept 150,000 was refused before
anything was dropped (exit 2); a run over 150,000 and 200,000 rows in one
throwaway container built both, the second replacing the first. A second
invocation under a name in use was refused with the owner named. The default
command left `podman volume ls` at the same count before and after. The first
two reuse runs each failed on a driver fact: a JSON **string** bound to a
`$n::jsonb` parameter is JSON-encoded once more by Bun's driver and lands as a
jsonb string, which `@>` never matches — the double-encoding the README's
live-suite section already names, met from the other side (bind objects); and
jsonb hands an object back with its keys in its own order, so a round trip's
text is not the text that went in (compare a key-sorted serialisation).

**Second review pass, on the seams the first pass's fixes made.** The
container is now stopped and removed by the ID `run` returned, not by name —
under a shared name a removal by name after our own `stop` could take a
container another invocation created meanwhile — and a namesake in any state
but exited is refused, since podman reports `stopping` (another invocation's
exit checkpointing the database, up to two minutes) as not running; the
cleanup flag is raised *before* `run`, because a `run` that creates the
container but fails to bind its port leaves the container and, without
`OB1_PG_KEEP`, the anonymous volume the `-v` exists for (reproduced by the
reviewer: one volume per failed run, the 79 GB leak in miniature); the
readiness wait breaks out at once when the container has exited, so a kept
data directory the image cannot open prints its logs in a second rather than
after thirty minutes of dots; the removal hint prints the runtime as found,
since `/opt/podman/bin/podman` is chosen exactly when `podman` is not on
`PATH`; and an interrupt exits through the EXIT trap once. In the bench the
one-corpus rule is judged against the *whole* run before the loop — the
per-scale refusal, added by the first pass, would have measured a kept scale
in full and then refused the run's second scale with every section unprinted —
and a run under `OB1_PG_KEEP` that puts a small scale after a large one is
refused up front, since the small scale would drop the corpus and keep nothing;
the regenerated rows and counts run *before* the migrator on a reuse, so a
table that is not the generator's is refused before a pending backfill walks
ten million rows; the chunk-vector check runs on a reuse that applied a
migration (the one way a kept chunk vector can change); the marker carries a
format number beside the parameters, so a marker an earlier bench wrote
rebuilds aloud instead of passing every check and failing in the report; the
marker table joined `dropSchema`'s list, so a suite run in a kept database
cannot leave a marker over rows that are gone; and both paths run the queries
once untimed before section A, since a kept index in a new container is cold
where a freshly built one is warm. Two ledger reads became one
(`ledgerNames`), the row recipe one function shared by the load and the
regenerated rows, and the reviewer's altitude finding — that `migrate.ts`
itself should check drift and strangers before applying anything, which would
retire both the bench's dry run and `ledgerStrangers` — is SMD-1504's. Cut
for space: caching the exact oracle's answers in the marker (the bulk of a
reuse's remaining minutes at ten million rows), not measured.

**Third pass.** The stop signal — the previous pass's additions as the top
findings — fired at the second pass and again here, and the shape of the
findings said why: three rules for which scale a kept database holds, keyed
three ways (the marker, the environment, the per-scale marker), and an
ownership rule in the script keyed by a flag and a name. Both became one
invariant. In the script the container is *created* and *started* as two
steps and cleanup touches only the ID `create` returned, never the name — the
flag went, and with it the case where an invocation that lost a name race
stopped the other's container through the name fallback; a namesake in any
state but exited is refused with the removal named, since `created` is either
another invocation between its two steps or a shell whose start failed, and
the two cannot be told apart from outside; the data-directory mount is read
from the image's `PGDATA` (`/var/lib/postgresql/<major>/docker` from the pg18
images, where a mount at the old path would keep an empty volume); the
interrupt trap is disarmed before the stop so a Ctrl-C during the checkpoint
cannot skip the removal and the hint, which now prints before the stop. In
the bench, under `OB1_PG_KEEP` a run is exactly one scale above the before
arm's, judged where the list is parsed — a descending list had built the
large corpus and then replaced it "by design", a small-scale-only run had
kept a volume nothing would reuse, a duplicated scale had reused a marker
written seconds earlier; the marker is written in one transaction (a table
with no row read as "no corpus" and would have let a small-scale run drop what
it stood over); the marker records the ledger the oracle's premise last passed
under, so a check that threw after a file was recorded is not skipped by the
re-run; a reuse that applied files `VACUUM ANALYZE`s both tables, since a
migration of 023's kind leaves a dead index entry per row and the build's
statistics; and this run's queries are confound-checked through the index,
since a build with three queries said nothing about a reuse with fifty. The
header's count and the check order in two paragraphs were brought up to the
code. Cut for space: caching the exact oracle in the marker; `migrationFiles()`
shared across the seven directory listings; the marker's `scale`/`builtAt`
held twice.

**Fourth pass, at the author's call.** The exited-namesake removal went by the
ID the status was read from, not the name — a forced removal by name would
have taken whatever held the name at that instant, another invocation's
freshly created container included, the race the ID rule exists to close; the
interrupt disposition inside cleanup is *ignore*, not default (reset, a second
Ctrl-C during the two-minute stop killed the client and the shell before the
removal — reproduced on bash 3.2); without `OB1_PG_KEEP` a container whose ID
never reached the shell is removed by the per-process name, so an interrupt
that cuts the `create` short leaves no anonymous volume; the `PGDATA` read
fails loudly rather than defaulting under `set -e`; `--stop-timeout 120` rides
on the container so an operator's own `stop` checkpoints too. In the bench
the vacuum and the oracle-premise re-check share one key, the ledger against
the one the marker was last verified under (a run interrupted between the
migrator's commits and the vacuum would otherwise leave the next run timing
dead index entries with "nothing applied" printed); a reuse's confound comes
from the exact whole-table pass section A already runs, not an index probe
that sees its first forty candidates; a kept corpus of the right scale built
from other parameters is *refused* with the remedies, as a scale mismatch is,
rather than rebuilt behind one log line; the kept-table checks refuse in the
named-remedy form rather than throwing; the fresh path skips the dry run and
words its refusal for an empty database; and "before a container is asked for"
became "before anything is connected to or dropped", which is what is true
under `with-postgres.sh`.

**Fifth pass, on the tree merged with main** (PR #47's fourth and fifth
passes, changes 66 and 67). The stale namesake's status and ID now come from
one inspect and the removal goes by that ID (two reads by name were a second
snapshot, and a name gone between them aborted under `set -e`); the data path
is pinned with `-e PGDATA` rather than discovered from the image, which
retires the pre-pull, the environment parse and the silent default the
discovery needed; `--stop-timeout 120` rides only on a kept container, since
podman's `rm -f` honours it and a throwaway container should go at once; the
readiness wait ends only on an explicit `Running=false`, not on a failed
inspect, so one transient runtime error cannot stop a thirty-minute recovery.
In the bench the marker format is 2 (main's `otherIndexes` in section L) and a
format mismatch is documented as the refusal it is; a reuse whose migrations
rewrote rows is refused rather than plain-vacuumed and measured — main's
fourth pass found plain `VACUUM` leaves the heap doubled and the graphs as
repaired twins, and its `VACUUM FULL` at ten million rows is the rebuild the
reuse exists to avoid; both HNSW relations are prewarmed on a reuse, since the
untimed pass over the default call had warmed only the query vectors'
neighbourhoods; the confound comes from one exact pass on both paths through
one `oracle()` (the duplicate whole-table scan went); and the two paragraphs
above say the ledger-keyed re-check and the exact-pass confound the code does.

**Sixth pass.** Three defects the reviewers reproduced. Readiness is now TCP
readiness (`pg_isready -h 127.0.0.1`): over the unix socket the entrypoint's
initdb-time temporary server answers for about 200 ms before the real one is
up, a client that connected then failed, and under `OB1_PG_KEEP` the exit that
followed stopped the container mid-initialisation and left a volume the
entrypoint thereafter treated as initialised. The container's state is asked
on every readiness miss, not only after a runtime exec error: docker's `exec`
on a non-running container exits 1, the code `pg_isready` gives for
"starting", so under docker the fast fail on an unreadable kept volume had
been dead and the wait ran the full thirty minutes. The row-rewrite refusal is
recorded in the marker (`rewritten`) before it exits, since the ledger has
already advanced and the next run would otherwise find nothing pending and
measure the repaired graph; the counts and the two regenerated rows are
checked again after the migrator. Then the smaller items: the exact oracle
selects the distance under an alias the `ORDER BY` names — `1 - (…)` beside
the bare distance was two expressions to the planner and it evaluated the
distance twice per row, 12–15% of every exact scan; `pg_prewarm` runs after the
oracle (which streams the heap and would evict what was read before it) and
just before section A; a marker of a shape this bench cannot read is a
refusal with the remedy, not a stack trace; `migratorEnv` is an allowlist —
every `OB1_*` variable dropped, the fixture's three set — where the denylist
had one dead name and let a chunk-context choice through; the marker's scale
and build time live once, in `stats`, and comparisons use `Bun.deepEquals`;
the marker is written only under `OB1_PG_KEEP`, so a throwaway multi-scale run
no longer says "replacing"; test-upgrade's four remaining hand-spelled
migrator spawns use `runMigrator`; and the bench's dry run and
`ledgerStrangers` are labelled the stand-ins for SMD-1504 they are.

**Seventh pass.** The rewrite check had compared the row counters against
this run's own first read, which three findings got past: a migrator that
committed a rewriting file and failed on the next exited through the refusal
before the comparison, a statistics flush that landed after the read left the
delta at zero, and a rewrite without DML — a column type change, a re-created
index — moved no counter at all. One durable fingerprint replaces it: at the
build the marker records, for the two heaps and the two HNSW indexes, the
cumulative insert-update-delete counters and the file each relation lives in
(`relfilenode`, which DML never changes and a rewrite always does); a reuse
compares the current state against the build's, refuses on any movement and
records the refusal, so the run after an interrupted migrator catches what
the interrupted one could not; a counter that went *down* is a statistics
reset after a crash recovery, said and not refused, since the files still
vouch. That subsumed the second count-and-rows check. The marker is read once,
before the loop, and every rule about it is judged there — the in-loop read,
its second refusal family and six non-null assertions went; a duplicated
scale is folded at parse. The exact oracle runs under the build's worker
count (`max_parallel_workers_per_gather`, the image's cap is two) — a setting,
not a measured saving. The skip self-check exercises the shared row recipe
rather than a hand-spelled copy of it; a marker's `stats` are checked for
every field section L reads by name (a compiler-held list), not by the format
number, whose comment now says what it is for; `substitute` pins the
chunk-context default as it pins the trigram one, so a fixture applied bare
and through the migrator agree on what 013 records; test-upgrade's [7] no
longer describes a refusal the migrator does not make.

**Eighth pass.** The fingerprint compared against the build alone had one
blind spot the reviewer built: after a crash recovery resets the statistics
(the ten-million-row counters read zero), a full-table rewrite lands them back
on the build's figure and the files are unchanged, so nothing moved. The
comparison is now made twice — against the build, for what earlier runs did,
and against this run's own read before the migrator, for what this run's
files did — and the refusal records the evidence (what moved, since when)
rather than this run's file list, which had blamed whichever file happened to
run last for a rewrite an earlier, interrupted migrator committed. The
prewarm runs on both paths: the oracle streams the heap some five hundred
times, so at ten million rows a freshly built index is no warmer than a
reused one by section A, and the per-query warm pass — which had made
section A a repeat-query figure — went. In the script, an interrupt is noted
and the command's own exit status stands (the trap had replaced a clean exit
with 130 whenever a signal reached the wrapper, a psql cancel included); a
container created and never started — an interrupt inside the tens of
milliseconds between `create` and the ID reaching the shell, reproduced — is
removed by its inspected ID instead of refusing that name for ever; a new
kept volume gets the ordinary one-minute wait, the thirty minutes being for a
data directory with WAL to replay; the refusal's pasted removal is `rm -fv`.
Smaller: the relation names come from one list (`HNSW_INDEXES`), bound as an
array; `scale` is a generated column of the payload; readMarker's shape check
carries the kept-scale rule, so the loop's reuse test is one term; the
build's confound stays the accumulator's, said so; test-schema pins the
chunk-context default too. The denylist copies left in test-live,
test-search-path and measure-1288 predate this change and are on the boyscout
list.

**Ninth pass.** Two mechanisms rebuilt at the root rather than patched. The
interrupt handling: the eighth pass's note-only traps had made a signal to
the wrapper before its command ran vanish — a `kill` during a thirty-minute
readiness wait set a flag nothing read, the wait ran out, the bench started
and the wrapper exited 0 — and its status remap reported any non-zero exit
after any signal as 130 (reproduced under bash 3.2). Now the trap acts
(`exit 130`/`143`) until the command runs, when it becomes a no-op body — not
an empty string, which a child inherits as "ignore" and never sees the
signal — and the command's own status carries out through the EXIT trap. The
fingerprint: the counters half is lost to a crash recovery, so a rewrite that
committed before a recovery and was never judged (the run died before its
own comparison) left counters below the build's, said and not refused, with
the file unchanged — invisible. Each relation's main-fork size joined the
record: DML over the rows grows it, nothing resets it, and growth past a
tenth of the build's is the refusal; the counters are no longer
load-bearing, which also covers a server with `track_counts` off (said when
seen). Then: a marker table that exists with no row is a refusal, not "no
corpus" (the fresh path would have dropped what stood under it); the marker
is written after the exact pass's confound gate, so a refused build leaves
nothing to reuse, and that gate refuses in the named form rather than
throwing; the loop's tail is one `if (kept)`/`else` with no non-null
assertions, and the dead `!beforeArm` on the marker write went with it. The
spawned migrator runs with `--no-env-file`: Bun loads `db/.env` into a child
for every variable the passed environment lacks — every `OB1_*` name after
the strip — so the allowlist had a hole the size of the file the fork
documents as the migrator's own (reproduced); `runMigrator` takes an
optional environment and the three suites still spelling the spawn use it;
one `migrationFiles()` lists the directory for the bare apply, the ledger
comparison and test-upgrade's count.

**Tenth pass, on the tree merged with main again** (changes 68–70; this
section became 71, its test case [15]; main's `OB1_BENCH_UPTO` applies bare
on the whole-schema path and is refused with `OB1_PG_KEEP`, since a schema
cut at a migration is not one the ledger describes). Two things at the root.
The marker records the build's transaction id, and a reuse counts the rows of
either table whose `xmin` is newer — exact at any share and blind to a
statistics reset, where a subset backfill committed on an earlier interrupted
run had grown the heap by less than the tolerance and moved counters a
recovery then zeroed; with that, the ledger-keyed re-check of the oracle's
premise went, since no row written since the build is the premise's proof.
And the database-level HNSW bounds in force are compared with the tree's
seeds on both paths: a kept database carries the `ALTER DATABASE` its build's
014 ran, the migrator skips a recorded 014 and 014's guard leaves a seed in
place, so a config-only change to `HNSW_SEEDS` would have walked under the old
bound while section E's header named the new one. Then: `--no-env-file`
rides on every `bun` spawn `runScript` makes with its own environment, not
only the migrator's (test-live's re-embed worker with a stripped shell was
the reachable case); `dropSchema` refuses a database holding a kept corpus
unless `OB1_DROP_KEPT_CORPUS=1` names the intent, so a suite run under a kept
name cannot drop thirty minutes of build in silence; the kept-table checks
throw a tagged error and anything else — a dropped connection, a timeout —
is rethrown rather than blamed on the corpus; the script's comment says what
its `created` arm does and the kept hint prints only for a container that
started; the marker's `stats.confound` is documented as the exact pass's
value; the reuse assigns its stats once.

**Boyscout, while the files were open** (what the passes cut for space, no
behaviour change): the script's stop timeout is one constant where it had
been spelled three ways; test-upgrade's [7] reads `MIGRATOR_ENV` where an
alias of it stood; the marker constant says why its name is spelled out in the
tagged templates; two comments that narrated which review run found what say
the fact instead; change 28's section L table gained the `source` column the
bench now prints, every row `loaded`; the README's thirty-minute wait is said
to be a kept volume's that already exists; a second look folded the script's
four removals into one `discard` and let the README count the thirty minutes
as the 1,800 tries they are. Left as they were, being either behaviour or
beyond the touched files: caching the exact oracle's answers in the marker
(the bulk of a reuse's remaining minutes at ten million rows — SMD-1562), and
test-live's own stripped-shell spawns for the re-embed worker and preflight,
which predate this change.

Upstream status: **not applicable** — a fork-only bench harness. **Unfiled**
upstream. Reproduce: `OB1_PG_KEEP=x OB1_BENCH_SCALES=150000 ./with-postgres.sh
bun bench-hnsw.ts` twice; the second run's section L says `reused`.
