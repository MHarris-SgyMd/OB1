# 68. delete_thought joins the writers' lock order, closing a deadlock between an accept and a delete of the superseded thought (SMD-1462)

Change 63 (SMD-1043, migration 033) put every writer of `thoughts.supersedes`
on one lock order — the supersession advisory lock
`hashtext('ob1:supersession-review')`, then the fingerprint lock, then the row —
and its second review pass named the one writer left outside it: `delete_thought`
(migration 009). The function took no advisory lock. Its `DELETE` holds the
thought's row, and change 54's (SMD-1294, migration 029) `ON DELETE CASCADE` from
`thoughts` onto `supersession_proposals` reaches every proposal that names the
row and waits to remove it.

**The cycle, both shipped functions.** `review_supersession_proposal(P, 'accept')`
locks the proposal row `P` `FOR UPDATE`, takes the supersession lock, locks the
superseding thought `S` `FOR NO KEY UPDATE`, then writes `S.supersedes = Z`
through `update_thought`, whose FK check (`thoughts_supersedes_fkey`, change 25 /
migration 025) takes `KEY SHARE` on the superseded thought `Z`. Meanwhile
`delete_thought(Z)` holds `Z` and, through the cascade, waits on `P`; the review
holds `P` and waits on `KEY SHARE` of `Z`. 033's pass reproduced it 23 times in
40 against a real server, the delete the `40P01` victim each time — pre-existing
since 029/032, and 033's header and change 62 stated it as the residue outside
the order rather than claiming the order was universal.

**The fix (migration 036) — two changes, and running it proved both are
needed.** `delete_thought` takes
`pg_advisory_xact_lock(hashtext('ob1:supersession-review'))` before its `DELETE`
— the identical key the review, `update_thought` and `upsert_thought` take, one
hash entry, transaction-scoped, taken unconditionally because the function cannot
know whether a proposal names the row before it is gone. The ticket proposed that
alone and warned that reordering the review's proposal-row lock "is not enough on
its own". The live race (`db/test-live.ts` [6g]) showed the delete-side lock is
not enough on its own either: with only `delete_thought` fixed it deadlocked 10
of 40 during the build, because `review_supersession_proposal` locks the proposal
row `P` **before** it reaches the advisory lock (029/032), so a delete holding the
lock waits on `P` through the cascade while a review holding `P` waits on the lock
— the same cycle, one row along. (The shipped [6g] guards the reorder through its
no-deadlock arm rather than reproducing that intermediate state.) So the second change: `review_supersession_proposal` takes the
advisory lock **before** it locks `P`, for accept and reject alike. Now a delete
and a review contend on the lock first, and whichever wins runs to commit — the
review writing its pointer, or the delete removing `Z` and cascading `P` — before
the other touches a row. Forty tries, no `40P01`. Both bodies are otherwise 009's
and 032's verbatim (the review keeps its two `update_thought` calls and its
no-UPDATE, no-walk shape); both signatures are unchanged, so the stores and tools
call them as before.

**The 23503 the same lock closes.** 033's probe found a second, smaller thing: a
supersedes target deleted between `update_thought`'s existence walk (the plain
`SELECT` that answers `SUPERSEDES_NOT_FOUND`) and its `UPDATE` (where the FK
fires) surfaced as a raw `23503 thoughts_supersedes_fkey`, not the
`SUPERSEDES_NOT_FOUND` its COMMENT promises "for a target deleted in the instant".
The delete-side lock closes that window from the same edge: `update_thought`
holds the supersession lock across **both** its walk and its `UPDATE` whenever
`supersedes` is named (033), and `delete_thought` now contends on it, so a
through-the-functions delete cannot slip between the two. Update-first: the walk
sees `Z`, the `UPDATE` takes `KEY SHARE` on a `Z` still there, and the delete's
`ON DELETE SET NULL` (025's FK) clears the pointer afterwards. Delete-first: the
walk, under a fresh `READ COMMITTED` snapshot, finds `Z` gone and returns
`SUPERSEDES_NOT_FOUND`. Either way, no 23503 — the COMMENT's promise is honoured,
not tightened, so `update_thought`'s 280-line body stays 033's byte for byte. A
raw `DELETE FROM thoughts` around the function takes no advisory lock and could
still race the walk into a 23503, exactly as a raw content `UPDATE` around
`update_thought` escapes the fingerprint lock (033's header): the order is a
contract among the shipped functions.

No runtime, store or preflight change — two SQL functions redefined, each
carrying its prior body with only the lock relocated. The `delete_thought(uuid,
jsonb)` COMMENT names the new lock. `db/test-live.ts` [6g] races forty accepts
against forty deletes: the pre-036 lockless delete (009's body by hand) deadlocks,
the shipped pair does not and its cascade still removes the proposal; [6h] races
`update_thought` naming supersedes against a delete of that target forty times and
sees never a raw 23503, always `SUPERSEDES_NOT_FOUND` or a clean write.
`db/test-schema.ts` [36] pins 036 as the last definer of both functions and each
lock before its contended row.

Upstream status: **not applicable** — the deadlock is between two fork functions
(029/032's supersession review and 009's delete) that upstream does not have.
**Unfiled** upstream. Reproduce: `./with-postgres.sh bun db/test-live.ts` and
read [6g]/[6h].
