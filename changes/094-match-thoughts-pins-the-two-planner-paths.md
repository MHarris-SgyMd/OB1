# 94. `match_thoughts` pins the two planner paths its statements are built around — migration 041 adds `enable_nestloop = on` and `enable_tidscan = on` to 040's function, so an operator's `enable_nestloop = off` no longer turns every join in the call into a merge or hash join over the whole table, and on PostgreSQL 18 `enable_tidscan = off` no longer turns the gate's eight one-page probes into eight scans of the heap (SMD-1677, SMD-1703)

**The mechanism.** Every join in `match_thoughts`' body is a primary-key
probe driven by an outer the statement itself bounds: the parent lookup that
closes each of the three `RETURN QUERY` branches (`FROM best b JOIN thoughts
t ON t.id = b.tid`, over at most 2 × v_fetch candidates or v_exact rows), the
broad walk's chunk side (`JOIN thoughts p ON p.id = c.thought_id`, one probe
per HNSW-ordered candidate, stopping at v_fetch), and the gate's sample
(eight block numbers to eight TID range probes). A nested loop with an index
probe inside is the plan for each by construction; the nested-loop disaster
that `SET enable_nestloop = off` exists to tame — a misestimated outer of
millions of rows — cannot happen here. But the setting is one operators put
at database level to stop such a plan elsewhere, and it reaches every call
to this function. Change 91's million-row A/B ran the function under it and
found every filtered tier with rows at 2–3 s, the same under 038 and 040,
identical rows — and filed this. What the planner had done, read out of the
installed body with `extractBody` and explained under the function's own
settings on 100,000 rows at 64 dimensions (4,767 heap pages, 50,000 chunk
rows), custom plan, warm:

| statement | default | `enable_nestloop = off` | what replaced the nested loop |
| --- | ---: | ---: | --- |
| unfiltered | 1.10 ms / 3,436 buffers | 41.6 ms / 101,458 | Merge Join, inner `Index Scan using thoughts_pkey` over the whole table (97,800 rows, 35.7 ms) |
| walk, 50% filter | 2.01 / 4,631 | 82.3 / 156,453 | the same Merge Join (30.7 ms) — and the chunk side a Sort over a Hash Join of every chunk row against a Bitmap Heap Scan of every filtered parent (46 ms) |
| exact, 900 rows | 2.38 / 8,213 | 39.6 / 104,924 | the same Merge Join (33.4 ms) |

Two things the ticket's table had not shown. The **unfiltered** branch is
hit too — the closing join is the same in all three branches, so every call
to a brain whose operator turned nested loops off pays it, not only the
filtered ones. And the walk's **answer changes**: the hash join computes an
exact top-v_fetch over all chunks where the nested loop takes the HNSW's,
so the 50% and 10% tiers return different rows under the setting (marked ≠
below) and the same rows again once the pin is on.

**Measured at a million rows**, one corpus (the bench's, built under this
tree and kept as `OB1_PG_KEEP=nl1m`; 49,999 heap pages, 400,000 chunk rows),
040's function with the two pins applied as an `ALTER FUNCTION` for the
pinned arms, twenty seeded queries per tier on a fresh connection per cell,
median of calls 6–20 / 1–5, PostgreSQL 16; ≠ marks rows differing from arm
A's:

| tier | A default | B `enable_nestloop = off` | C off, pinned | D `enable_tidscan = off` | E off, pinned | F default, pinned | A′ default again |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| unfiltered | 6.12 / 10.4 | 1,330 / 1,348 | 6.85 / 10.1 | 5.93 / 8.68 | 6.29 / 9.20 | 6.94 / 9.95 | 6.59 / 9.16 |
| 50% | 10.6 / 10.8 | 2,154 / 1,868 ≠ | 10.9 / 11.5 | 9.85 / 10.4 | 10.6 / 13.9 | 11.0 / 12.8 | 11.6 / 11.9 |
| 10% | 32.4 / 29.7 | 1,757 / 1,662 ≠ | 36.5 / 34.2 | 33.0 / 32.7 | 36.2 / 37.8 | 38.6 / 36.9 | 39.7 / 37.8 |
| 1% | 31.8 / 35.1 | 1,813 / 1,784 | 35.0 / 35.5 | 34.6 / 33.5 | 33.9 / 36.3 | 34.5 / 47.0 | 36.5 / 33.7 |
| 5,000 rows | 18.9 / 19.6 | 1,732 / 1,687 | 20.4 / 21.8 | 22.8 / 21.8 | 22.6 / 22.0 | 20.5 / 21.4 | 21.4 / 22.7 |
| 2,000 rows | 9.47 / 12.3 | 1,830 / 2,143 | 11.9 / 12.9 | 10.8 / 13.1 | 13.6 / 14.8 | 11.1 / 12.2 | 12.0 / 12.6 |
| 0.1% | 7.67 / 7.52 | 1,820 / 1,847 | 7.50 / 8.63 | 7.62 / 8.02 | 8.78 / 10.9 | 8.08 / 8.06 | 8.92 / 9.51 |
| 900 rows | 5.59 / 6.90 | 1,649 / 1,647 | 5.27 / 6.78 | 6.68 / 6.27 | 6.95 / 8.77 | 6.25 / 8.31 | 7.07 / 7.80 |
| 0.01% | 1.13 / 1.53 | 1,524 / 1,534 | 1.09 / 1.51 | 1.17 / 1.76 | 1.31 / 1.84 | 1.10 / 1.23 | 1.26 / 1.84 |
| nothing | 0.43 / 0.58 | 0.44 / 0.68 | 0.41 / 0.55 | 0.43 / 0.58 | 0.49 / 0.63 | 0.40 / 0.52 | 0.44 / 0.51 |

C against A is what the pin buys where the setting is off: the default's
time and the default's rows in every tier. F against A and A′ is what it
costs where the setting was already on: nothing outside the run's own
spread. The `nothing` tier never paid — its exact branch has an empty
candidate set, and a hash join with an empty build side reads no probe
side. Column D is 16: `enable_tidscan = off` there changes the cost figure
(disable_cost on the probe, which 040 stopped compiling) and nothing else.

**The second pin is SMD-1703's**, measured on PostgreSQL 18.6 with the same
100,000-row corpus. On 14–17 `enable_tidscan = off` leaves the probe's TID
Range path in place at disable_cost; on 18 tidpath.c never builds it, so the
probe's only plan is a sequential scan of the heap with the ctid range as a
filter, `Disabled: true`, taken anyway, once per block drawn:

| session (18.6) | probe node | buffers | exec |
| --- | --- | ---: | ---: |
| default | Tid Range Scan | 8 | 0.35 ms |
| `enable_tidscan = off` | Seq Scan, `Disabled: true` | 38,136 (8 × 4,767 pages) | 74.7 ms |
| off, pinned | Tid Range Scan | 8 | 0.25 ms |

Through the function on 18 under the setting every filtered tier cost 78–83
ms against 0.7–4.8 by default — the empty-match filter included, at 78 ms,
since the sample runs before the collection — and with the pin every tier
read the default's time and rows. Under `enable_nestloop = off` 18 behaves
as 16 does (its disabled-node count still prefers the merge and hash joins:
unfiltered 38.9 ms, 50% 100 ms, 900 rows 36 ms at 100,000 rows) and the pin
restores the default there too.

**Migration 041** is 040's `CREATE OR REPLACE` with two clauses after `SET
jit = off`: `SET enable_nestloop = on` and `SET enable_tidscan = on`. The
body is 040's — 039's — byte for byte (test-upgrade [19] compares `prosrc`
across the upgrade; test-schema [20] re-applies 039 and 040 alone and
compares), with everything 040 carried; this file is the last definer, which
preflight's remedy and the suites' `restoreShipped` apply alone.

**Why pin here where 040 declined to.** 040 was about a compile: JIT fired
on a cost figure, and one clause on the executor removed it in every case —
a disabled path, a generic plan's flat estimate, row-level security — where
pinning paths would have covered one case each and overridden the operator
for nothing. This is about a plan: under the setting the planner chooses a
different, worse plan, and only a pin or a statement shape that admits no
other plan can give the right one back. The argument is 019's for
`enable_seqscan = off` — the body's statements are built around one path
each, and a planner setting made for tables not shaped like that does not
tune this call, it defeats it — applied to two more paths. 019's "no other
SET" was written about the walk's bounds and a plan mode; 040 took the
exception for `jit`, and 041 takes it for two planner paths on the same
reading. Both tickets asked the policy question once and SMD-1703's update
made SMD-1677 the place it is decided: the function pins the paths its
statements rely on, and any pins ship in one migration, one preflight check
and one clause count.

**Not a statement shape.** A LATERAL subquery that cannot be pulled up —
`CROSS JOIN LATERAL (SELECT … FROM thoughts t WHERE t.id = b.tid LIMIT 1)
t`, the sample's own trick; a bare LATERAL is flattened back into the join,
as the exact branch's comment records — admits only a nested loop, and under
`enable_nestloop = off` it held the default's plan, buffers and time in all
three branches (1.46 / 1.37 / 2.43 ms at 100,000 rows). It is the same
decision, the function choosing its join method, written into four
statements instead of one clause: it changes the texts test-schema [20]
compares, swaps the plan aliases (`t`/`t_1`) the bench attributes nodes by,
carries disable_cost in the estimate (1e10 per join, 2e10 in the walk —
harmless since 040, but a reader of auto_explain sees it), rests on a
planner-internals rule (a subquery with LIMIT is not flattened) where a SET
clause rests on a documented one, and has no answer for the TID range probe,
whose path on 18 is not costed away but never built.

**Not pinned, deliberately.** `enable_hashagg` and `enable_sort`: with both
off the sample's DISTINCT draw and every ORDER BY carry disable_cost and the
planner takes them anyway — the same plan, the same rows, and since 040 no
compile (change 91's table); pinning them would override the operator for
no measured gain, so a reader of auto_explain still sees a cost past 1e10 on
14–17 under those two, and 041's first screen says so. `enable_indexscan`,
`enable_bitmapscan`, `enable_hashjoin`, `enable_mergejoin`: no measured case,
no operator reason to set them database-wide, and a function that pins every
planner setting is a plan mode by another name. The two pinned are the two an
operator's setting was measured defeating. The operator's escape is 040's:
`ALTER FUNCTION … RESET enable_nestloop` takes a pin off for a brain whose
operator wants the session's setting inside the call, and preflight warns
until the migrator re-applies 041.

**What it does not fix.** Row-level security's sequential scans of the heap
(SMD-1625); PostgreSQL 13, where the probe has no TID Range path whatever the
setting (038's Prerequisites); the plan mode of the walk and the threshold
(SMD-1464).

**What holds it.** preflight's `candidate scan` reads both pins beside 019's
clause and 040's: ok names all three files; a body missing the pins warns
with what each setting does without them (the whole-table joins, 18's heap
scans), naming 041 as the remedy while the ledger does not record it and the
`ALTER FUNCTION … SET enable_nestloop = on SET enable_tidscan = on` when it
does; 039 applied alone by hand is reported as two losses with one remedy,
040 alone as the pins' loss alone, and one pin of two is still the warning
(test-preflight, 233 assertions). test-schema [20] and [21] pin exactly five
clauses; [20] re-applies 039 and 040 alone and finds each dropping what the
later files added; [8e] names 041 the last definer. test-live [5e]'s tidscan
and nestloop cases now find the default's plan under the session's setting —
a TID Range Scan at an ordinary cost, no `Disabled` node on 18, the sample's
buffers on a heap they could have read whole — and, with the pin `RESET`
(the mutant, what 040's file re-applied by hand leaves), disable_cost back on
14–17 and on 18 the disabled node back and, under `enable_tidscan = off`, the
probe a sequential scan reading the whole heap per block; the compile story
(the forced-on JIT block, the timing mutant) moves to the one path 041 leaves
unpinned. New [5f] loads 12,000 rows with chunks, both HNSW indexes rebuilt,
and under a session `enable_nestloop = off` explains the three `RETURN
QUERY` statements read out of the body under the function's settings: every
join a Nested Loop touching the default's buffers (within a tenth, plus 64 —
byte-identical in every run so far); with the pin RESET a Merge or Hash Join
touching at least the heap's page count more; and through
the function the pinned call returns the default's ten rows, in order, under
the setting — the buffer count is the tooth because it does not depend on
the machine, and the timing at scale is the tables above. test-upgrade [19]
applies 041 onto a populated 040: no column, signature, row or privilege
moves, the body byte for byte, the two pins beside 014's, 019's and 040's
clauses, and after a hand re-apply of 014 puts the 4-argument form back, 041
alone drops it again; [7]'s tripwire reads "last twelve". db/bench-hnsw.ts's
before arm for this change is `OB1_BENCH_UPTO=040`, and under default
session settings its section B should agree with the default row for
row.

**What it costs where it does nothing.** Two more `proconfig` entries, set at
call entry and restored at exit — microseconds, what 014, 019 and 040 pay —
and column F above. The bench's own pair on the same kept corpus (its build
run, then a reuse with 041 applied onto it, on an idle VM) agrees: section B
returns the same rows and the same recall in every tier, and its medians
read 9.7 / 34.7 / 26.4 / 15.1 / 8.1 / 6.9 / 5.6 / 1.0 / 0.3 ms after against
10.8 / 34.4 / 32.4 / 18.8 / 10.4 / 9.6 / 5.3 / 1.0 / 0.3 before, the 50% tier
down to the 0.01% and `nothing`. (A first after-run, taken while the
ten-million rebuild shared the VM, read 20–90% above the before-run in
every tier with the same rows — the confound, not the pins, and it is not
cited.)

**Ten million rows.** The SMD-1018 corpus kept from change 76
(`OB1_PG_KEEP=hnsw10m`, 499,999 heap pages, four million chunk rows; its
ledger stopped at 037) was brought to 041 by hand — 039's two index rebuilds
under a database-level `maintenance_work_mem` of 9 GB took twenty minutes —
and measured through the function, ten seeded queries per tier on a fresh
connection per cell, median of calls 4–10 / 1–3, PostgreSQL 16. First with
the whole-table arm in the middle (B, the pins RESET), which took twenty
minutes on its own; then the pinned arms alone, back to back, on the warm
cache B had evicted:

| tier | A default (041) | B `enable_nestloop = off`, pins RESET | C off (041), after B | D default, pins RESET | A′ | A (warm) | C off (041), warm | A′ (warm) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| unfiltered | 20.6 / 26.3 | 18,075 / 18,465 | 82.9 / 82.8 | 36.7 / 44.0 | 36.0 / 32.7 | 7.6 / 8.4 | 12.0 / 9.7 | 10.9 / 9.0 |
| 50% | 22.2 / 28.3 | 28,726 / 33,886 ≠ | 52.8 / 16.8 | 14.1 / 17.7 | 15.0 / 23.7 | 11.4 / 20.9 | 13.4 / 18.2 | 14.3 / 19.7 |
| 1% | 977 / 879 | 21,510 / 23,355 ≠ | 949 / 821 | 941 / 571 | 963 / 580 | 491 / 339 | 463 / 406 | 428 / 391 |
| 5,000 rows | 56.9 / 56.2 | 19,884 / 19,806 | 51.8 / 50.6 | 47.6 / 48.7 | 47.5 / 48.4 | 54.4 / 54.5 | 52.8 / 53.9 | 51.7 / 52.8 |
| 900 rows | 10.6 / 11.2 | 16,779 / 16,806 | 9.4 / 10.1 | 8.0 / 8.8 | 8.2 / 8.9 | 11.0 / 13.4 | 10.7 / 11.5 | 10.1 / 10.8 |
| nothing | 1.1 / 1.1 | 0.4 / 0.6 | 0.6 / 0.7 | 0.5 / 0.6 | 0.5 / 0.8 | 0.5 / 0.8 | 0.6 / 0.7 | 0.5 / 0.8 |

Seventeen to thirty-four seconds a call under the setting without the pin —
the merge join's inner side is an index scan over ten million primary-key
entries, the walk's hash join builds over four million chunk rows — the
unfiltered call among them, and the walk's rows changed; with the pin, tens
of milliseconds. Column C after B reads higher than A on the unfiltered and
50% tiers because B's whole-table scans had just evicted the buffer cache
(its first-three-calls median says the same), which is why the pinned arms
were run again alone: warm, C is within A and A′'s spread in every tier. The
1% tier's 400–1,000 ms is the same in every arm and is not this change's:
a hundred thousand matching rows walk the index to its seeded bound, change
28's knife edge at that tier. The bench's own reuse of this volume is over
(its marker's fingerprint refuses rebuilt indexes; db/README.md says a
pre-039 corpus must be rebuilt); `podman volume rm ob1-pg-keep-hnsw10m`
when it is no longer wanted.

**Not done here.** A hundred million rows. Row-level security and the plan
mode are under What it does not fix; the ten-million volume's retirement
from the bench is under Ten million rows.

**Review** — pass 1, two reviewers (a cold reader over the diff, the header
and this section; a run-it reviewer mutating the mechanism in its own
worktree), triaged fix / ticket / no. What changed: main had moved — PR #83
(SMD-1328) merged after this branch was cut and numbered its section 91
beside PR #82's 91 — so main was merged, that section renumbered to 92 and
moved into file order, and this one is 93 — 94 once PR #84 (SMD-1796) took 93 before this
was pushed — with the intro's count and range,
the file list, change 91's three pointers, the README's inventory, the
bench's header, 041's header and test-live's pointer following (caught:
cold-read). preflight's warning after the header's own escape hatch
(`ALTER FUNCTION … RESET enable_nestloop`) had said both pins were missing
and that "a later redefinition dropped its SET clauses" when one pin was
taken off by a RESET; it names the pin that is missing and what that setting
alone does, its ledger clause allows for a RESET, and test-preflight's
one-pin probe asserts the single-pin wording and the absence of the other's
(caught: cold-read; held: test-preflight). test-live [5d]'s six strings that
still named 040 as the installed body and preflight's remedy, and [5e]'s
finally comment, say 041 (caught: cold-read). 041's first screen had claimed
the sample's DISTINCT draw was the only cost left past 1e10 where its own
Design bullet says the body's ORDER BYs carry it too; and the Design bullet
now says the clauses re-enable a path and do not force one — hash and merge
joins stay available and the planner still chooses by cost inside the call
(caught: cold-read). The ALTER-form remedy with the pin SETs (041 recorded,
pins RESET) had no probe, so a typo in the fragment would have passed the
suite; one probe asserts the recorded-but-dropped-or-RESET wording and the
three-SET ALTER (caught: run-it; held: test-preflight). [5e]'s pinned-case
message hard-coded the node it expected — under the tidscan mutant on 18 it
read "a TID Range Scan … 344 buffers" over a Disabled Seq Scan; it prints
the node, the Disabled and JIT terms it saw (caught: run-it). What the run-it
reviewer verified: each pin deleted from 041 is caught by all four suites
(test-schema [20] and [21], test-preflight's shipped-ok and re-apply probes,
test-upgrade [19], test-live [5d], [5e]'s pinned case with the
self-incriminating cost 1e10 or 8e10, and [5f]'s three pinned arms reading
"every join is a Nested Loop (Merge Join)"); the tidscan pin deleted on 18
fires [5e] by buffers, "344 buffers on a 43-page heap", and by the Disabled
and Seq Scan terms — SMD-1703's tooth; [5f]'s pinned arm is a tooth on its
own when the mutant arm's bound is loosened (mutant C), so the two arms are
independent; preflight's `pinned` forced true fails four probes and the
pins-alone remedy renamed to 040's file fails two; [19]'s precondition
catches the section applied onto 039; a database-level `ALTER DATABASE … SET
enable_nestloop = off` behaves as the session-level SET the tests use, and
the pinned statements carry no disable_cost term under it. Not changed:
[20]'s five-settings string loosened to accept three or five passes on the
shipped state — that mutant cannot fail by construction, and [21] pins the
count independently, as mutant A showed.

Pass 2, the same two reviewers, aimed at pass 1's additions. No defect in
the mechanism, the preflight logic or the tests; what changed is text. The
`SET jit = off` comment carried from 040 into 041's CREATE said "this file"
meaning 040 and ended "not the enable_* paths pinned" two lines above the
two pins — the one place a reader of the installed file was told something
false; it attributes itself to 040 and points at this header (caught:
cold-read). The header's ten-million sentence said "seventeen to thirty-four
seconds" under a table whose largest median is 28,726 ms — the 34 is the
first-three-calls figure of the 50% tier that only this section's table
carries; it says so (caught: cold-read). This section and the README
described [5f]'s bounds as "at most twice" and "three times as many or
more" where the code asserts within a tenth plus 64 and at least the heap's
page count more (caught: cold-read), and the README's "the sample's eight
buffers" for [5e]'s pinned case is "fewer buffers than the heap has pages",
the tooth as written (caught: cold-read). preflight's ALTER remedy named
both pins whenever either was missing, where pass 1 had made the message
name only the missing one; the remedy follows the message (caught:
cold-read). test-preflight's comment on the unrecorded-041 probe still
described the state before pass 1 inserted the recorded-041 probe ahead of
it, which leaves both pins RESET too (caught: cold-read). [5e]'s timing
bound is scaled from the run's own EXPLAIN JIT total, and with the pinned
cases skipping the forced-on arm the list has one entry, pushed only where
the server compiles: the `jitAvailable` guard alone kept an empty list — and
an infinite bound that makes the fixed-arm line vacuous — out of the suite;
an assertion says so if the guard ever moves (caught: run-it). What the
run-it reviewer verified: every pass-1 wording seam is held — the pin names'
order swapped, the ledger clause forced to its recorded branch, either
`pinWhy` sentence dropped, and `pinned` made a disjunction each fail at
least one probe, the last exactly the one-pin probe written for it; the
recorded-041 probe reaches preflight's ALTER branch (a misspelt SET fragment
fails it and nothing else); on the shipped code a database-level `jit = off`
skips [5e]'s timing arm cleanly on 16 (534 + 1 skipped) as 18 does; with
`enable_nestloop`, `enable_hashagg` and `enable_sort` all off at database
level the pinned function returns the default's rows in the default's time
and the only disable_cost in any statement is the sorts' — the "not pinned,
deliberately" claim, live; and [5f]'s pinned and default buffer counts were
byte-identical in every pair over three runs and two queries. Not changed:
[5f]'s `within a tenth plus 64` could be equality on that evidence, and
stays a bound so a drift in the walk's reads fails as a drift and not as the
pin (a boyscout candidate either way). The stop signal fired here: pass 2's
findings were polish in pass 1's additions and in prose, and the two
reviewers' mechanism checks were clean twice over. Boyscout, after the
signal: the tidy-ups both passes cut for space, in the touched files — the
header's million-row table gains the column E its own sentence counted, its
four over-long prose lines are rewrapped, this section's Not done here no
longer repeats What it does not fix and Ten million rows, "column for
column" is "row for row", test-live's fixture comment names PostgreSQL's
64 MB default rather than the container's, [5f] asserts the default arm's
joins are all Nested Loops before it judges the pinned arm against them
(three assertions, so a planner that ever preferred a hash join on the
fixture fails as itself and not as the pin) and says its rows check is
no-harm, test-upgrade [19]'s last assertion reads the tidscan pin beside
the nestloop one, and preflight's recorded-but-one-pin-missing sentence
leads with the RESET, since a redefinition would have dropped both. No
behaviour change.

**The operator's path, walked.** A brain at 040 whose operator has `ALTER
DATABASE … SET enable_nestloop = off`: preflight's `candidate scan` warns
"…but not enable_nestloop = on and enable_tidscan = on — migration 041 is not
applied: an operator's enable_nestloop = off at any level reaches every join
in the call…", remedy `Apply db/migrations/041_match_thoughts_pin_paths.sql`;
`bun db/migrate.ts` applies it (one `CREATE OR REPLACE`, no rows touched); the
next call takes the default's plan under the operator's setting, which stays
where it was for every other statement on the server. A brain at 041 whose
operator re-applies 040's file by hand: the pins are gone, the ledger
unchanged, and preflight names the loss with the `ALTER` that puts both back.

**Upstream status:** not applicable — 014's routing statement, 037's gate and
038's probe are this fork's, and the pins are clauses on this fork's function.
