# 66. A re-capture writes no provenance — migration 035 drops 025's "add if empty" from the capture path, so no capture can close a supersession loop and none takes the supersession lock (SMD-1453)

Change 46 (migration 025) let the 3-argument `upsert_thought` fill a NULL
`derived_from` or `supersedes` on a re-capture of the same text —
`COALESCE(thoughts.x, EXCLUDED.x)`, add if empty, never change: the fill —
because `update_thought` then had no way to set provenance after the fact. It
never asked whether the pointer it filled closed a loop: change 54's cycle walk
(migration 029) was the review path's, change 60 (migration 032) moved it into
`update_thought`, and the capture path had none. So R with no pointer, X
superseding R, then a capture of R's text naming `supersedes` X — sequentially,
no race — wrote R → X → R, and both rows read as superseded. Change 63
(migration 033) took the supersession lock around the fill to order it against
the walk, stated the residue in its header, wrote the loop in `test-schema`
[33], and measured what the lock cost: a capture *naming* `supersedes` held the
one brain-wide key from before its label read to commit, HNSW insert included —
about 145 such captures a second at 1,024 dimensions whatever the worker count,
a ceiling. The lock existed only for the fill, but which of the two a capture
is becomes known only under the fingerprint lock, so 033's order made every
capture naming `supersedes` take it.

SMD-1453 offered three: walk the fill (a refusal on the capture path, the lock
and its ceiling kept), refuse the fill (a dedup of text that exists raises), or
drop it. **Migration 035 drops it.** Change 60's envelope — migration 032's
`p_provenance` on `update_thought`, an object naming `derived_from` and
`supersedes` — has been the way to set, change and clear provenance on an
existing thought since it landed, walked, audited, one function; so the fill's
reason is gone, and the rule has one owner. A capture of text that is already
there is a dedup: it merges as 021 and 022 say; it does not decide what the
existing thought derives from or replaces. And the caller is told, not
surprised: the return carries `existed`.

**Migration 035.** The 3-argument form's `ON CONFLICT` clause no longer sets
`derived_from` or `supersedes`; a fresh INSERT writes both from the envelope
as 025 did, a re-capture leaves both columns as they were whatever the envelope
names. Validation is unchanged and runs before the write is known to be a
dedup, so a malformed reference is refused either way — a `derived_from`
naming no thought included; a well-formed `supersedes` naming no thought is
the FK's, which runs on the INSERT only (see "Closed, and not"). The
supersession lock leaves the capture path — with no pointer ever written onto
an existing row there is nothing for it to order. The return is `{id,
fingerprint, existed, supersedes}`: `existed` true means the text was already
there, the metadata merged, the vector and windows moved by 021/022, and any
provenance named not written; `supersedes` is the row's pointer after the
write, so a caller told the text existed can say what stands. `existed` is "a
row held this fingerprint when the locked read ran": a writer that bypasses the
fingerprint lock can make the merge report false (the class 018, 023 and 033
already exclude), and a legacy row with a NULL fingerprint is not found. Also,
022's `FOR NO KEY UPDATE` label read runs for every capture now, not only with
a vector, so the flag is right for a vectorless capture too. The 2-argument
body is carried verbatim from 033 so 035 is the last definer of both inserting
forms and preflight keeps one remedy; `update_thought` is not redefined — 033
stays its last definer, with the order 033 gave it. 032's `COMMENT ON
review_supersession_proposal` said "a capture's add-if-empty through
upsert_thought aside", and is re-issued here with the aside replaced by the
rule, as 033 re-issued `update_thought`'s.

**Callers.** Nothing changes its call. 013's 4-argument form returns `v_result
|| {"chunks": n}`, so both keys pass through to both servers, and
`CaptureResult` carries them. The `capture_thought` tool's reply says what
stands when the caller sent `supersedes` and the text existed — it already
supersedes what was named, currently supersedes another (`update_thought` would
replace it), was named as its own predecessor, or holds no pointer and
`update_thought`'s `supersedes` records it "if that thought exists and closes
no loop"; the edit is named only where it would record or replace — and says
the tools cannot set `derived_from` on an existing thought when that was sent.
Two things at the same boundary are older than this change and follow it: the
tool pre-checks `derived_from`'s shape as it pre-checked `supersedes`', before
the two model calls are paid (since 032 a non-id element was refused only at
the write); and a first capture naming a thought that does not exist is refused
in the tool's words rather than Postgres's foreign-key text (since 025).

**Why a capture needs no supersession lock.** The lock serialises writers of
the `supersedes` column so that `update_thought`'s walk reads pointers no
concurrent writer is changing. A capture now writes that column on a fresh
row only, and a fresh row cannot be part of a loop: a loop through it needs
some row's pointer to reach it, and until this transaction commits no other
transaction can see its id to name it (READ COMMITTED; the FK would refuse an
id that is not there). A walk running meanwhile reads the committed graph,
which the fresh row is not yet in; once it is, it is a leaf pointing at an
existing row. The `KEY SHARE` its FK check takes on the target does not
conflict with `update_thought`'s `FOR NO KEY UPDATE` (change 60) and is taken
last; `delete_thought`'s `FOR UPDATE` on the target does conflict, and the
capture waits for the delete and fails its FK check — 23503, the outcome
before this change too, and SMD-1462's to word. Change 63's order for every
writer — supersession, fingerprint, row — stands; the capture path takes the
suffix fingerprint → row, and `test-live` [6f]'s four writers on two texts
finish as before.

**Five review passes, triaged.** The first (three reviewers: the SQL, the
callers and tests, the prose) found no schema defect. Its SQL reviewer ran
eight workers of captures, edits and review decisions over a seeded brain with
and without deletes: no loop of any length, no deadlock without deletes, and
with them only SMD-1462's review-versus-delete cycle, never raised in a capture
or an edit; the unconditional read against 023's `LOCK TABLE` held under a real
backfill with fifty concurrent vectorless captures. It found the re-capture
naming a `supersedes` that names no thought (stated under "Closed, and not"),
one reply condition, and wording. The second found the number — main had taken
migration 034 and changes 64 and 65 meanwhile, so this is 035, change 66 and
`test-schema` [35] — and the one thing the reply could not know: built from the
caller's inputs alone, it advised recording a pointer the thought already held,
replacing one without saying so, or an edit `update_thought` refuses; the
return's `supersedes` and the reply's four shapes are its fix. The third was
the stop signal: the second pass's `RETURNING` had moved the anchor [35]
sliced the `ON CONFLICT` clause by, so an assertion passed on an empty tail —
the anchors are guarded now — and the reply compared ids case-sensitively
against Postgres's lower-case text. The fourth took another altitude: hostile
inputs at the tool boundary (the two pre-existing items under "Callers", an
empty `derived_from` firing the note, and advice that could name an edit
refused for a loop as well as for a missing thought — it carries the condition
now); the operator who skipped a week — a brain at 032 with filled pointers, a
loop, an accepted proposal, a legacy row and windows, upgraded through 033,
034 and 035 in one run, `--reapply`, then 025, 033 and 034 re-applied by hand
and `--reapply` again, byte-identical to a fresh install in every function
body, ACL and COMMENT, two hundred captures, two hundred edits and fifty
reviews with a backfill mid-way giving no deadlock and no loop; and a cold
read, which caught a renumber miss hidden by a line wrap and the seams four
passes had spliced. The fifth enumerated every input cell of the capture tool
and drove each through the server — no false reply, every advised edit warned
of the two conditions under which it is refused — ran every CI step locally,
codemod round trip included, and read this section whole, which is why it is
this length.

**Closed, and not.** Closed: the capture path cannot write a supersession
loop by any sequence — a loop now needs a writer outside the two functions
(raw SQL) — and the ceiling with it. No longer refused, and stated: a
re-capture naming a `supersedes` that names no thought, or one whose chain
reaches this thought — the FK and the walk ran only where a pointer is
written, and a re-capture writes none (a first capture's FK still refuses a
missing target) — so `existed` comes back true and no provenance is written
(the dedup's own merge runs: metadata, `updated_at`), and `update_thought`,
which the reply names with the condition spelled out, refuses it by name
(`SUPERSEDES_NOT_FOUND`, `WOULD_CYCLE`); the caller learns one step later, not
never. Changed, and stated: 025's "a re-capture may add provenance the row did
not have" is gone; a caller that later wants to record what a captured thought
supersedes calls `update_thought` with the envelope. Not this change's:
`delete_thought` outside the lock order (SMD-1462); the 2-argument form's
silence on the envelope's provenance (PostgREST's two-step fallback has
dropped it since 025); `derived_from`, an array with no acyclicity rule
anywhere, which `trace_provenance` is cycle-guarded against (change 47); a
`derived_from` id naming no thought still refused in Postgres's words; 022's
"unknown vouches for nothing" (SMD-1245). No data changes: a pointer a
re-capture filled before 035 stays, loop or not — no shipped code sends
`supersedes` on its own, but `capture_thought` forwards a caller's, so a loop is
possible wherever a client re-captured existing text naming one; the header
gives a query that finds a two-row loop, one row per loop, and the envelope's
`{"supersedes": null}` to clear one.

**The sentinel, and the preflight.** The 3-argument body carries
`ob1:re-capture-writes-no-provenance` beside 022's and 033's. `atomic capture`
reads it and grades a stale 3-argument body five ways now — before 022, 025,
033, 035, or missing — with 035 the one remedy; the cause follows the ledger
as change 63 made it, and says both halves when the ledger records 033 but not
035 and the body lacks 033's lock (025 re-applied by hand *and* 035 pending).
`test-preflight` adds 033 re-applied by hand over 035 to the walk.

**Cost.** Less, and measured with change 63's design — alternating arms each
on a fresh schema, 033, 035, 033, 035, the cold first arm discarded — at 1,024
dimensions, HNSW, a 300-row corpus, the SQL store with 64 connections: 50
concurrent captures naming `supersedes` against 50 naming none, medians of
four rounds, 292.6 vs 91.3 ms and 284.4 vs 87.7 ms at 033 (3.2×), 94.2 vs
79.7 ms and 73.6 vs 74.0 ms at 035 (1.2×, 1.0×); 200 concurrent naming
`supersedes` 1,650.7 and 1,358.6 ms at 033, 342.2 and 308.4 ms at 035 —
inside the plain arms' own spread (200 naming none: 410.9 / 317.2 ms at 033,
346.8 / 334.5 ms at 035); one serial capture naming `supersedes` 7.30 / 6.75
ms at 033, 7.22 / 6.27 ms at 035. The per-call cost is the HNSW insert either
way; the lock only took the parallelism. More: one index probe per vectorless
3-argument capture, under the fingerprint lock, on the partial unique index the
INSERT's arbitration reads anyway.

**Verified.** `test-schema` [35] (841): 035 the last definer of
`upsert_thought` and 033 of `update_thought`; the 3-argument body read from
`pg_proc` — 035's sentinel beside the two before it, no supersession lock, an
`ON CONFLICT` clause that sets neither column while the INSERT lists both, the
row read unconditional, `existed` and the row's `supersedes` returned, 022's
DELETE condition kept; a first capture writes provenance with `existed: false`;
a re-capture naming other provenance leaves the row's, one over a row with none
fills nothing, a vectorless one says `existed: true`; validation still refuses
a malformed envelope on a dedup; SMD-1453's sequence writes no loop and
`update_thought` refuses the same pointer; a capture naming `supersedes` holds
one advisory lock inside its transaction; both COMMENTs; the trap — 033
re-applied by hand puts the fill and the lock back and writes the loop, 035
restores. [22], [23], [31], [33] follow the last definer ([33]'s own trap had
restored `update_thought` by re-applying 033's whole file, which put 033's
capture bodies back for every section after it; it restores both names now).
The 4-argument pass-through is read from 013's source there and called on a
real server in `test-live` [13]: PGlite aborts with a WASM out-of-bounds on a
windowed capture through that form, at 033 as at 035. `test-live` (482): [6e]
arm 3, a capture naming `supersedes` completes while another connection holds
the supersession lock, its pointer written on its fresh row — where at 033 it
waited; [13], a re-capture naming provenance over a row with none fills nothing
and says `existed` with the pointer that stands, the envelope records it, and
`existed` rides beside `chunks` through the 4-argument form. `test-upgrade`
[13] (162): 035 onto a populated 033 whose re-capture had just written the
loop — no column, signature, row, audit row or ACL moves, the loop stays, the
2-argument body and `update_thought` byte-identical before and after, the next
such re-capture fills nothing, the loop is cleared through the envelope and
cannot be re-written, a re-run is a no-op. `test-e2e-sql` [7] (94): the reply's
four `supersedes` shapes and `derived_from` alone through the server, upper-case
ids, both refusals the advice warns of, both pre-checks. `test-preflight`
(205), `test-search-path`, both store suites (each asserting the two keys),
`test-update-delete`, `test-audit`, `tsc`, the consistency checker.

Upstream status: **not applicable** — upstream's `upsert_thought` writes no
provenance at all.
