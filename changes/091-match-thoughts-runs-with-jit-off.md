# 91. `match_thoughts` runs with `jit = off` — migration 040 adds 017's clause to 039's function, so a planner path an operator disables no longer JIT-compiles the gate's sample on every call, and a generic plan's flat estimate no longer compiles the walk (SMD-1624)

Change 80 shipped with a premise stated in its header: 038's sample statement
has, in every piece, exactly one viable planner path — a TID Range Scan for
the block (019's `enable_seqscan = off` is on the function), a Nested Loop
for the `LATERAL` join, Sort/Unique or HashAggregate for the `DISTINCT` draw
— and when a session, role or database turns that path off the planner still
takes it and adds `disable_cost`, 1e10. The statement's cost is then far past
`jit_above_cost` and its inlining and optimisation thresholds, and the
executor compiles the sample on every execution: the same plan node, the
same eight buffers, the same rows, nothing in preflight or the ledger, and
some fifty milliseconds of compiler on every filtered call. `ALTER DATABASE …
SET enable_nestloop = off` is a spelling operators use to tame a nested-loop
disaster elsewhere, and it would have given every fresh connection that.
SMD-1624 asked for the decision between a function-level `SET jit = off`,
pinning the paths, and leaving the premise stated.

Main took change 81 — migration 039, the half-precision index, which
redefines `match_thoughts`' walk `ORDER BY` and nothing in the sample — and
changes 82 to 85 while this change was in review, so it is migration 040 and
change 91. The measurements below were taken on 038's function; the statement
they are about is the same in 038, 039 and 040, byte for byte.

**Measured first.** The ticket's table reproduced on this tree through the
function — 25,000 rows at 1,024 dimensions (385 heap pages; the HNSW index
dropped, so the 50% column is a GIN bitmap and a sort, the fixture's cost),
the floor lowered to 0 so the sample runs, medians of nine calls after three
warm ones, round trip included, an empty-match filter / a filter matching
half the rows:

| setting (session) | 038's function | 038's + `jit = off` on the function |
| --- | ---: | ---: |
| default | 0.99 / 59 ms | 1.30 / 66 |
| `enable_tidscan = off` | **51.3 / 108** | 1.28 / 62 |
| `enable_nestloop = off` | **59.0 / 108** | 1.07 / 66 |
| `enable_hashagg = off`, `enable_sort = off` | **105 / 270** | 0.99 / 65 |
| `enable_tidscan = off`, session `jit = off` | 1.04 / 66 | 1.11 / 60 |

The sample statement alone under `enable_tidscan = off`: total cost
80,000,000,070 (eight times `disable_cost`), 52 ms with the JIT block —
Inlining 7.4, Optimization 23.4, Emission 20.9 — and 0.18 ms without it. The
hashagg-and-sort case costs more than the other two because every `ORDER BY`
in the body carries `disable_cost` with sort disabled: the walk's statements
were compiled too. The tidscan and nestloop sensitivities are 038's; the sort
one is 037's (`count(DISTINCT …)` sorted). A row-level-security policy of
`USING (true)` reproduced nothing — the planner folds a constant policy — so
SMD-1625 stands on its own fixture, not this one.

**Migration 040.** 039's `CREATE OR REPLACE` with one clause added between
019's `SET enable_seqscan = off` and `AS $$`: `SET jit = off`. The body is
039's byte for byte — test-upgrade [18] compares `prosrc` across the upgrade,
test-schema [20] re-applies 039 alone and compares too — and with it 039's
half-precision cast in the walk's `ORDER BY`, 014's sentinel, the two
template constants, 019's two clauses and `ROWS 10`, 020's `DROP` of the
4-argument form with its ACL capture and replay; 040 is the last definer of
the function, which preflight's remedies and the suites' `restoreShipped`
apply alone. 039's index swap is not carried: it is a one-time move of two
indexes, not part of the function, and 039's own successor list names the
cast and not the swap; preflight's `walk index` check still names 039 for an
index out of step with the body, and after a hand re-apply of 039 the
`candidate scan` check names 040 for the clause 039's `CREATE` resets. It is 017's clause for 017's reason: nothing in
this body has enough rows for JIT to pay for itself — the walk passes a few
hundred tuples under the seeded bounds, the exact branch scores at most
`v_exact` rows, the collection stops at `v_exact + 1`, the sample reads eight
pages — and what prices its statements past the threshold is never the
work. It is `disable_cost`, or a generic plan's flat estimate: change 28
measured every generic plan at ten million rows carrying 30–110 ms its custom
twin did not (the routing count on the empty filter 31 ms against 0.03, the
exact branch 108 against 24, the 2,000-row walk 136 against 20) and, with
`jit = off`, 0.03, 11 and 23. The one generic plan whose cost is not JIT —
the 50% walk's GIN bitmap over five million rows sorted by distance, 11.6 s
against 15 ms custom, 11.7 with jit off — this change does not touch; that
is the plan mode, SMD-1464's.

**Why not the alternatives.** Pinning `enable_tidscan = on` would be
harmless and cover one case; `enable_nestloop = on` covers a second and
overrides an operator's setting for the walk's chunk join too; the third
needs `enable_sort = on` as well, over every `ORDER BY` in the body — and none
of the three touches the generic plan's JIT at scale, the compile under
row-level security (SMD-1625) or PostgreSQL 13's (038's Prerequisites). One
clause removes the compile in every case and changes nothing about which
plan the operator's settings choose. A higher `jit_above_cost` on the
function has no finite value safely above 1e10 per disabled node. Leaving
the premise stated was what 038 did. Not a plan mode: 038's sample adopts
the generic plan by design, the walk's mode is SMD-1464's, and 019's rule
stands — 019's "no other SET" was written about the walk bounds (the
operator's database-level knob) and a plan mode, and `jit` is neither; 017
and 027 have carried it since.

**The bench at a million rows, and what the pair could not say.** Run on
the tree before 039 landed, where 038 was the function before this one: the
before arm (`OB1_BENCH_UPTO=038` there) and the after arm, each on its own
container and corpus, agreed on every tier but two: the 5,000-row and 1%
tiers — both routed to the walk branch, with K=10 the exact threshold is
1,000 — ran the walk statement as an HNSW walk under 038 (546 and 424 ms,
8.8 and 8.9 of the exact top-10) and as a GIN bitmap with a sort under 040
(61 and 86 ms, 10 of 10). That is not the clause. It is the edge change 28
documented for exactly those two tiers: "between about half a percent and
one percent of the table, the walk branch is on the planner's edge, and
which side it lands on is decided by the statistics sample" — 332 and 283 ms
walking HNSW in two of its passes, 23 and 38 served from GIN in the third,
same rows, a fresh `ANALYZE` each time. Two containers are two statistics
samples; a second after run on a fresh corpus fell the GIN way too (30 and
53 ms, 10 of 10), and a third could have fallen either way. So the
attribution was done
on ONE corpus, kept under `OB1_PG_KEEP=jit1m`: the function with the clause
(A), with it `RESET` — 038's function — (B), and with it again (A′), twenty
seeded queries per tier on a fresh connection each, so every arm walks the
same plan-cache trajectory (custom plans for five calls, then generic where
not costlier); median of calls 6–20 / 1–5:

| tier | A: 040 | B: clause RESET (038's) | A′: 040 again | rows identical |
| --- | ---: | ---: | ---: | :---: |
| 50% | 13.0 / 18.7 ms | 16.8 / 17.4 | 13.9 / 15.4 | yes |
| 10% | 66.2 / 52.9 | 63.6 / 63.0 | 52.6 / 51.1 | yes |
| 1% | 54.8 / 45.3 | 43.4 / 52.7 | 43.6 / 48.4 | yes |
| 5,000 rows | 33.6 / 32.9 | 25.8 / 26.0 | 25.5 / 23.2 | yes |
| 2,000 rows | 17.0 / 20.0 | 13.9 / 14.0 | 13.2 / 13.4 | yes |
| 0.1% | 11.8 / 12.3 | 10.7 / 10.0 | 11.1 / 10.9 | yes |
| 900 rows | 12.0 / 12.5 | 8.9 / 10.9 | 10.7 / 11.0 | yes |
| 0.01% | 3.1 / 3.1 | 1.7 / 2.4 | 2.1 / 3.2 | yes |
| nothing | 1.3 / 1.5 | 0.7 / 1.0 | 0.8 / 0.9 | yes |

Identical rows in every cell, the arms within the run's spread (the first
arm ran coldest), and the first five calls costing what the rest cost under
both functions: at a million rows no generic plan of this body is priced
past `jit_above_cost` yet — change 28 put that between a million and ten
million — so the clause removes nothing here and costs nothing. Section C's
third column, "generic, jit on", read within noise of the generic column on
every branch (walk 0.1% 477 against 487 ms, route 50% 32.0 against 31.7,
estimate 0.11–0.14 against 0.12–0.16): agreement, as a flat estimate under
the threshold predicts. The ten-million arm was not re-run for this change
— the machine was carrying another session's ten-million containers — and
change 28's "generic, jit off" column (0.03 / 11 / 23 ms against 31 / 108 /
136) is what the function's generic plans now pay there; the third column
is where the next ten-million run reads it.

**The walk under the operator's `enable_nestloop = off`, measured.** The
ticket asked what the walk does under the setting that pinning would have
overridden. On the same corpus, the same three arms, session-level `SET
enable_nestloop = off`, median of calls 6–20 / 1–5:

| tier | A: 040 | B: clause RESET (038's) | A′: 040 again |
| --- | ---: | ---: | ---: |
| 50% | 3,022 / 2,747 ms | 2,830 / 2,502 | 3,473 / 3,215 |
| 1% | 2,320 / 2,265 | 2,340 / 2,640 | 2,799 / 2,901 |
| 5,000 rows | 2,404 / 2,195 | 2,849 / 2,851 | 2,907 / 2,790 |
| 900 rows | 2,141 / 2,047 | 2,454 / 2,484 | 2,754 / 2,662 |
| nothing | 0.62 / 1.08 | **66.8 / 66.8** | 1.19 / 1.73 |

The `nothing` row is this change: the sample's compile, 66 ms on every call
to a brain whose operator turned nested loops off, gone. The other rows are
not: without a nested loop the walk's chunk join and the exact branch's
parent lookups become joins over the whole chunk table, 2–3 s on every
filtered call with rows, identical rows and the same under 038. Pinning
`enable_nestloop = on` on the function would remove that — and would
override the operator's setting for every statement of the call, a second
mechanism and its own decision: SMD-1677, filed with this table (done:
migration 041, change 94).

**What the clause does not fix.** Under row-level security the collection
and the walk's direct CTE are sequential scans of the heap (`jsonb_contains`
is not leakproof): the compile goes, the scan stays — SMD-1625. On
PostgreSQL 13 the probe has no TID Range path and is a sequential scan per
block; the same. `disable_cost` is still in the estimate under a disabled
path — the TID Range Scan at 8e10, the Nested Loop at 1e10 — and a reader of
auto_explain sees the cost and no JIT block; the plan and the eight buffers
are the same. On a server built without JIT (`pg_jit_available()` false:
PGlite, some managed images) the clause is accepted and does nothing.

**What holds it.** `CREATE OR REPLACE` resets `proconfig`, exactly as it
resets 014's and 019's clauses, and the ledger cannot see it — the class of
loss change 70 and 80 could only state. preflight's `candidate scan` check
(019's) now reads `jit = off` beside `enable_seqscan = off` and `ROWS 10`: ok
names all three; a body carrying 019's clauses and not 040's warns with the
compile it lets back in, the migration as the remedy while the ledger does
not record 040 and the `ALTER FUNCTION … SET jit = off` when it does;
test-preflight's fixtures that model 019's loss restore the jit clause so
they stay 019's, and a new probe models 040's alone. test-schema [20] and
[21] pin exactly three clauses on the shipped body — a successor that adds
or drops one fails there on purpose. test-live [5e], on a 3,000-row heap
with the floor lowered: under each of the three disabled paths the statement
read out of the installed body, explained under the function's own settings,
keeps its TID Range Scan at `disable_cost` and has no JIT block; the same
statement with `jit` forced back on has one — Generation, Inlining,
Optimization, Emission, EXPLAIN's JIT total 41–45 ms on the CI image in that
run, 40–70 across the pass-1 runs — so the first check has
teeth; and through the function the mutant, 040's clause `RESET` (what a
redefinition without it leaves), pays the compile on every call: 55 ms a call
against 8 with the clause, 8 by default on that fixture. The forced-on plan
and the timing run only where the server has JIT and its own `jit` is on,
on 14–17, and are one skipped group otherwise; the catalog and plan
checks run everywhere. test-upgrade [18] applies 040 onto a populated 039:
no column, signature, row or privilege moves, the body byte for byte,
`jit=off` beside 014's and 019's clauses, and after a hand re-apply of 014
puts the 4-argument form back, 040 alone drops it again. db/bench-hnsw.ts
section C's third arm, which had been the generic plan with `jit = off`,
now forces `jit = on` over the function's clause: the column is what the
clause saves, and on a body before 040 (`OB1_BENCH_UPTO=039`, the new before
arm) the last two columns agree.

**What it costs where it does nothing.** One more `proconfig` entry, set at
call entry and restored at exit — microseconds, what 017 and 027 pay. The
default column in the table above is within the run's spread (0.99–1.30 ms
across the six cells that ran without JIT under either function).

**Not done here.** The walk under an operator's `enable_nestloop = off`
(SMD-1677, the table above; done: migration 041, change 94); the plan mode of the walk and the threshold
(SMD-1464); row-level security's sequential scan (SMD-1625); preflight's
recogniser for the gate's body (change 80's "Not done here"). The
ten-million arm was not re-run; a hundred million rows was not run.

**Review** — pass 1, two reviewers (a cold reader over the diff and the
documents; a run-it reviewer mutating the mechanism in its own worktree),
triaged fix / ticket / no. What changed: the header and this section had
cited a change-28 line that does not exist for the two-tier disagreement —
the sentence change 28 does have is quoted now, and the flip is named as
the walk statement's plan, not the branch; preflight's file remedy dropped
the keyword ALTER that 040 cannot restore in one reachable state (019
recorded, 040 not, the keyword estimate reset), and the ledger-records-040
wording with its `SET jit = off` ALTER had no test — test-preflight probes
both states now (211); [5e]'s "not JIT-compiled" check was vacuous on its
own for the tidscan case (without the function's settings the plan is a
cheap sequential scan no JIT would touch, and the bare check passed with
the clause absent) — it is one tooth with the disable-cost assertion now;
[5e] runs its timing only where the server's own `jit` is on (an operator's
database-level `jit = off` made the mutant compile nothing and the tooth
fail with 040 correct) and bounds the fixed call at the default plus 25 ms,
the compile's size, where `3 × default` was loose; the "byte for byte"
claim is checked in the fast loop too (test-schema [20] re-applies 038
alone: same body, no jit clause — 039 since the merge; 904 then, 925 on the
merged tree); README's [5d] paragraph and two
header figures corrected. What the run-it reviewer verified: the clause
deleted from 040 is killed in all four suites — test-schema [20] and [21],
test-upgrade [18] twice, test-live [5e] eight times including all three
plan checks, test-preflight three times; preflight blinded to the clause is
killed by exactly the new probe; the forced-on arm neutered is killed by
exactly its three assertions; a line added to 040's body is killed by
[18]'s byte-for-byte assertion; three runs of [5e] put the mutant at 51–56
ms against 7.9–8.9 fixed and 8.0–8.2 default, four times the bound. Not
changed: the timing message's "with 040's clause" label reads from the
file's intent, not the catalog, and would mislead only after the catalog
assertion before it has already failed.

Pass 2, the same two reviewers on pass 1's additions first. What changed:
PostgreSQL 18 replaced the `disable_cost` penalty with a count of disabled
nodes kept beside the cost (`Disabled: true` in the plan), so on 18 a
disabled path no longer carries the sample past `jit_above_cost` and the
compile this change removes cannot be triggered that way — run on 18.6, the
plan under each disabled path cost 36–1,490, nothing was compiled with the
clause or without it, the mutant timed 10.35 against 10.11, and seven [5e]
assertions failed against a correct 040; [5e] reads the server version and
on 18 asserts the absence (no JIT block with or without the clause,
`Disabled: true`, an ordinary cost) and skips the mutant arm with a line
saying why, and the header's first screen, Failure modes and Prerequisites
say 14–17 for the trigger and what 18 does (the clause stands on 18 for the
generic plan's flat estimate, row-level security's compile and 13's).
preflight's file remedy had named 019's file whenever the ledger lacked 019
— pre-existing, rewritten by pass 1 — and 019's `CREATE` is the 4-argument
form 020 dropped: on any brain past 020 it re-creates the overload the
`search signatures` check then fails the start on, and restores none of the
6-argument function's clauses; the remedy now names 040, the last definer,
which carries 019's clauses and `ROWS 10` with its own and drops that form,
with the keyword `ALTER` beside it (019's file is never named), and the
`RESET ALL` probe asserts the whole string. [5e]'s `jit` gate was read on
the suite's pool while the timing ran on fresh connections, so a
database-level `jit = off` set after the pool connected read as "on", the
timing ran, and its tooth failed at 7.97 against 8.05 for the wrong reason
(run-it, M4a); the gate is read on a fresh connection now. The 019-loss
fixture in test-preflight records 040 beside 019 (a brain whose function
carries the clause and whose ledger records 019 records 040), one probe's
comment had the ledger state inverted, this paragraph undercounted the
clause-deleted mutant's test-preflight kills (three, not two), and the
compile's figures name their quantity. What the run-it reviewer verified:
pass 1's fold is load-bearing — without the `!/JIT:/` term all three plan
assertions passed with the clause deleted, each printing "— but a JIT block
is in the plan"; with it all three fail; `keywordAlter` (pass 2 renamed it
`kwAlter`) emptied and
`ledgerHas040` ignored were each killed by exactly the probes written for
them; a body edit and the clause deleted are killed in test-schema by
exactly the pinned assertions; over four more [5e] runs the fixed call was
0.2–1.3 ms over the default against a 25 ms bound while the compiled arm
ranged 52–87 ms and two compiled medians in one run were 31 ms apart — the
teeth compare the uncompiled arms and leave the compiled one its noise. Not
changed: "30–130 ms of startup" in two pre-existing comments where change
28 and this section say 30–110 (boyscout).

Pass 3, the same two reviewers on pass 2's additions first. What changed:
on PostgreSQL 18 `enable_tidscan = off` does not price the TID Range path,
it never builds it — tidpath.c returns before `create_tidrangescan_path`
where 14–17 built the path and priced it — so the probe's only path is a
sequential scan of the heap with the ctid range as a filter, disabled and
taken anyway: `Seq Scan on thoughts t`, `Disabled: true`, 258 buffers
against 8 on the 43-page fixture (43 pages × 6 distinct blocks), and on an
ad hoc 2,469-page heap 19,752 buffers and 152 ms for the statement, the
empty-filter call 22 → 164 ms. That is 13's state (038's Prerequisites)
reached on a supported version by an operator's setting, the cost the gate
exists to avoid, and no clause on the function reaches it — SMD-1703, filed
with the table (done: migration 041 pins `enable_tidscan = on`, change 94). Pass 2's 18 branch had asserted `Disabled: true` and no JIT
block and passed over that plan without naming it (the `Disabled: true`
it matched was the sequential scan's); [5e] now asserts the node per case
on 18 — a `Seq Scan` under `enable_tidscan = off`, the TID Range Scan under
the other two — and names the failing term, and the header's first screen,
the 18 bullet and Prerequisites say what 18 does under each. Pass 2's "the
plan under each disabled path cost 36–1,490" was this finding unread. Also:
[5e] reports the arms that do not run through the suite's `skip()` rather
than a printed line, so the count reads as 514 on 14–17 with JIT and fewer
with skips elsewhere (the README count line says so); the pending-040
remedy carries its note about 019's clauses only when those are missing,
not for the common brain at 039 with the jit clause alone to gain;
preflight's warn strings and the README's [5e] paragraph say 14–17 for the
compile and what the clause guards on 18; the bound's comment cited seven
runs for a figure four support and a 150 ms figure that was row-level
security's; the first screen's wrap; a stale probe comment; this
paragraph's `keywordAlter`, which pass 2 had renamed. What the run-it
reviewer verified: the clause deleted from 040 on 18 is killed by the two
proconfig assertions and nothing else — the three plan lines are green with
or without it, as designed and now said in the comment; `disableCost`
forced false on 16 fails all three 18 assertions (the branch cannot take
18's path on 16); the remedy naming 019's file again is killed by three
probes, `kwAlter` emptied by four; the stale-pool gate reproduced pass 2's
wrong-reason failure and the fresh-connection gate skips instead; the whole
of test-live on 18.6 passes, 507 of 507, the seven fewer being [5e]'s
skipped arms and no other section differing. Not changed: the first
`median([])` runs colder than the later arms (12–13 ms against 9–11), a few
milliseconds of headroom the 25 ms bound does not need; the wording
"migration 019 is not applied" where the ledger records neither 019 nor
040, which is the ledger's word and 019's precedent.

Pass 4, the same two reviewers, the cold one also reading as an operator on
Supabase and as the maintainer merging. What changed: main had moved — 039
(change 81, the half-precision index, which redefines `match_thoughts`) and
changes 82 to 85 landed while this was in review — so this is migration 040
on 039's body, change 91 and test-upgrade [18]; every pin, remedy string,
count and pointer was re-applied onto main's text (the reliable pattern:
take main's file at every stop, re-apply the section once), test-upgrade
[7]'s tripwire reads "last eleven", and the section says what was measured
on which body. Supabase's images are built without LLVM JIT and its
upgrades set `jit = off`, so on the fork's stated target the compile this
change removes cannot happen today: the header's first screen and the
without-JIT bullet say so, and preflight's warning appends "(not on this
server today …)" when the server it reads has no JIT or its own `jit` off
— the clause still guards a self-hosted or future server, and the generic
plan wherever JIT is on. The 18 bullet's "13's state under Prerequisites"
pointed at this file's Prerequisites, which do not describe 13 (038's do);
"eight heap reads per filtered call" read as page reads where it meant
whole-heap scans; the first screen's parenthetical had grown to five ragged
lines and said "Failure modes below" twice; a bullet ended with "call"
alone on a line; [5e]'s 18
message named the node it expected rather than the one the plan had, and
its 14–17 label claimed a JIT term that cannot bite on a server without JIT
or with its own `jit` off (the proconfig assertions are the clause's teeth
there, as on 18); the `failed` list could blame a forced-on plan that was
never forced; SMD-1703's table gained the 2,469-page row this section
already quoted.
What the run-it reviewer verified: every mutant of pass 3's additions was
killed by exactly the predicted assertion — the node regexes swapped (each
message ending "— but: no Tid Range Scan" or "— but: no Seq Scan"), the
`Disabled: true` and cost terms inverted, the 019 note made unconditional
(one probe) or never appended (the other), the keyword `ALTER` dropped from
the file form; a database-level `jit = off` set before the pool connects
takes the skip path on 16; pass 1's fold still kills (without its JIT term
the three plan lines pass with the clause deleted, printing the
self-incriminating "— but a JIT block is in the plan"); the compiled call
was 49.6 ms once, so "never under 50" became "49.6–87"; a `skip()` counts
once for the seven assertions it stands for, which the count lines now call
a skipped group. Not changed: the 14–17 assertion's JIT term is still one
conjunction with the cost and node terms; on a server without JIT the label
says which term cannot bite rather than splitting it.

Pass 5, the same two reviewers on the merge. What changed: [5e]'s
"the mutant pays the compile" tooth had compared the two arms with each
other — `mutant − fixed ≥ 10` — and passed with the clause deleted from
040, both arms compiled and 12.9 ms apart in the run that found it, which
is the compiled call's own noise (the fixed-against-default bound was the
tooth in that pair); each arm is judged against the default now, the mutant
at least 20 ms over it and the fixed call at most 20 ms over it, and re-run
with the clause deleted under the new bounds: the fixed arm at 44.9 against
a default of 11.5 fails, the mutant at 45.6 passes, as they should.
[5d]'s "installed" and "restored" assertions read the body's floor and the
probe, which 039's body satisfies too, so a slip back to applying 039 had
left 039 as the shipped state for the sections after and nothing said —
both read the `jit=off` clause now. Prose the renumber left behind: the
operator's-path paragraph described a 38-file tree, a brain "at 038" with
one pending file and 038's file pasted over 040 (which also loses 039's
cast and trips the `walk index` check) — it is 039's file, 40 files, a
brain at 039; "test-upgrade [18] onto a populated 038" and "`OB1_BENCH_UPTO=038`,
the new before arm" said 038 where the code says 039; the header's
`enable_nestloop` table pointer said change 81, which is SMD-1501's; this
Review had re-recorded three pass-3 fixes under pass 4; "test-schema [20]
re-applies 038 alone" and "the common brain at 038" said 038 for 039. What
the run-it reviewer verified on the merged tree: clean controls 925 / 221 /
523 on 16 and 516 with one skipped group on 18 / 224; the clause deleted
from 040 is killed in test-schema three times (the `reapply("039")` block
passes by design — it pins 039's clauses, not 040's), test-upgrade [18]
twice, test-live [5e] seven times and test-preflight four times. Not
changed: main's change 81 still describes the pre-040 tree as fact ("[8e]
and [20] pin 039", "[5d] applies 039") — numbered sections are history,
and change 80's pointers were annotated because they were forward references
to this ticket.

Pass 6, the same two reviewers, the cold one applying pass 5's lesson to
every assertion of the ticket. What changed: pass 5's bounds were a literal
20 ms while the compile is a machine constant — EXPLAIN's JIT total ran 36
to 60 ms on this machine, once 36 where inlining was cheap — so a faster
host would bring the compiled arm toward the bound and the pair would turn
vacuous on one side and flaky on the other; each bound is now half the
smallest compile the run's own forced-on plans reported, never under 10 ms,
and the default is measured immediately before the fixed arm so a load
spike on the shared machine lands on both or neither. The comment under the
fixed-arm bound still described the design pass 5 removed ("25 ms", "the
tooth above compares it with the uncompiled arm and asks only for 10 ms");
the trigger assertion's label says it measures the trigger and that the
clause's tooth is the next line (with the clause deleted it passes, both
arms compiled 0.4 ms apart — by design, now said). test-schema [20]'s
`reapply("039")` block asserted the body and 039's settings under one
label, so a body change printed the settings; two assertions now (926).
[5d]'s messages still said "038" for the installed function and one claimed
preflight's remedy names 038, which it has not since 039 landed; "040" and
"the gate", and the kept body's variable named for what it is. The
pass-5 paragraph read as one run where it was two; four ragged wraps in the
header; a 040 line in this file's file list beside 039's. What the run-it
reviewer verified: the four mutants pass 5 could not finish — a byte in the
body is killed by test-schema [20] and test-upgrade [18] twice; the server's
`jit` read forced true by exactly the jit-off-server probe; the remedy
slipped to 039's file by four probes; [5d] slipped back to 039 by exactly
pass 5's two new teeth and nothing else — and the clause deleted from 040 is
killed by the fixed-arm bound at 45.6 against 9.7 while the trigger line
passes at 45.1 (both compiled, 0.4 apart: pass 5's fix is what kills);
three clean runs put the compiled arm 28–30 ms over the default and the
fixed arm 0.04–0.5 over it. Not changed: the four probes that pin the
remedy string match the filename by regex, and the raw-body probe pins
039's remedy the same way — one tooth for that string, four for this one,
recorded so the count is known; a `SET jit = false` in a successor would
store "false" and fail every regex and [20]'s pin, which is the pin doing
its job.

Boyscout, after the passes: the two pre-existing comments that said "30–130
ms of startup" for the generic plans at ten million rows (db/bench-hnsw.ts,
db/test-support.ts) say 30–110, change 28's figure; db/README.md's "twenty-three
migrations applied" says forty. A second look: the unrecorded-040 probe
asserts its two claims under two labels (225), the test-live count line's
parenthetical is a clause, and [5d]'s comment on applying before the index
drop says whose order it keeps — no behaviour change.

**The operator's path, walked.** A brain with rows migrated by `bun
db/migrate.ts` through 040 (on a brain at 039 it is the one pending file):
one `match_thoughts` whose `proconfig` reads `hnsw.iterative_scan=relaxed_order,
enable_seqscan=off, jit=off`, preflight's `candidate scan` ok naming all
three, a filtered call answering as before. The same brain with 039's file
pasted over 040 by hand (for its index swap, say): the plain run reports
"applied 0, skipped 40", the body is unchanged — 039's and 040's are the
same — and what is lost is the clause — `candidate scan` warns
"carries enable_seqscan = off and both row estimates hold, but not jit = off
although migration 040 is recorded as applied — a later redefinition dropped
its SET clause" with `ALTER FUNCTION match_thoughts(…) SET jit = off;` as
the remedy, and `migrate.ts --reapply` (40 re-applied) restores it with
everything else, after which the check is ok again. The PostgREST contract
is byte-identical to 020's.

**Upstream status:** not applicable — 014's routing statement, 037's gate and
038's sample are this fork's.
