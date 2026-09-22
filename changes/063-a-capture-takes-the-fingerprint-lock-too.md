# 63. A capture takes the fingerprint lock too — migration 033 redefines both inserting `upsert_thought` forms, so writers of one text are serialised whichever function they come through (SMD-1043)

Change 33 serialised `update_thought` calls that would take a fingerprint key on
an advisory lock, so two edits into the same text get `DUPLICATE_CONTENT`
instead of racing to the unique index — and scoped the claim honestly: the lock
covered edits only. `upsert_thought` wrote fingerprints without it, so a capture
of text X committing while an edit to X sat between its lookup and its UPDATE
still raised `duplicate key value violates unique constraint
"idx_thoughts_fingerprint"` — at the MCP boundary as `update_thought failed:
…`, in `reembed.ts` as a failed claim whose remedy was `--retry-failed`. Six
disclaimers said so (018's header and COMMENT, `db/README.md`, `reembed.ts`
twice, change 33), and SMD-1022's second review pass ticketed the fix rather
than fold in a redefinition of two capture overloads. Change 40 then named two
more shapes its row lock could not cover — two first captures of one text
racing, and an edit moving another row onto a text as it is captured — where
the capture's label read found no row and left a re-capture's windows as they
were; change 60 a third, a re-capture filling a NULL `supersedes` pointer
without the supersession lock. Four symptoms, one fact: the capture path took
no lock a concurrent writer of the same text also takes.

**Migration 033.** Both inserting overloads — the 2-argument body from 005, the
3-argument body from 025; 013's 4-argument form delegates to the latter and is
not redefined — take `pg_advisory_xact_lock(hashtextextended(v_fingerprint,
0))` before anything reads or writes the row the text lands on: before 022's
`FOR NO KEY UPDATE` label read in the 3-argument form, before the INSERT in
both. Spelled exactly as 018 spells it, so the same key is the same lock —
`test-schema` [33] holds the three bodies to one string rather than a
`lock_fingerprint(text)` helper, which the ticket floated and which would have
meant redefining `update_thought` a third time to call it. Four more things
ride the redefinition, three of them a rule that already had one owner
elsewhere:

- **`update_thought` takes the fingerprint lock before its row.** Whenever
  content arrives, not after the row read and only when the row does not
  already own the key, as 018 wrote — the first review pass's finding, below.
  018's shortcut stays for the second hash and the lookup; only the lock is
  unconditional and early. 032's body otherwise verbatim under 032's
  signature, with 032's DROP-and-replay of the 8- and 7-argument forms
  carried so a hand re-apply of 021 or 018 is undone by the last definer.
- **The supersession lock, first.** When the envelope names `supersedes`, the
  3-argument form takes 029's `hashtext('ob1:supersession-review')` before the
  fingerprint lock, so a re-capture filling a NULL pointer is ordered against
  `update_thought`'s cycle walk and the review path's write (change 60's
  carry-forward). Until change 66: migration 035 drops the fill and, with it,
  this lock from the capture path — 033's "what a successor must carry" list
  is superseded by 035's.
- **One copy of each rule.** `derived_from` is validated through 032's
  `validate_derived_from` — 025's inline copy is gone, and the refusals lose
  their `upsert_thought:` prefix — and both forms hash through 016's
  `content_fingerprint_of`, the last two inline copies of 003's rule.
- **The 2-argument form attributes.** It reads `p_payload.actor` into
  `ob1.actor` as the 3-argument form has since 008. It never did — 008
  redefined only the 3-argument body — so a capture through PostgREST's
  two-step fallback, the one caller of this form, wrote an unattributed audit
  row. The one thing here that is not a lock; `test-upgrade` [12] shows the
  NULL actor at 032 and the name at 033.

**Lock order.** Every writer of `thoughts` now acquires in one order —
supersession lock, fingerprint lock, row — or a suffix of it, and takes at most
one lock of each class. A capture naming `supersedes`: supersession →
fingerprint → the row the text lands on (until change 66: fingerprint → row,
like a capture without). A capture without: fingerprint → row.
`update_thought` with content: supersession (when named) → fingerprint → the
edited row; without content: supersession → row. The review path: the proposal
row `FOR UPDATE` → supersession → the superseding row → `update_thought`
without content, re-entrant on both. The FK check a `supersedes` write makes
takes `KEY SHARE` on the target last, which does not conflict with `FOR NO KEY
UPDATE` (change 60), and the capture's row lock is `FOR NO KEY UPDATE` (022),
so the foreign keys never enter a cycle among these. One total order, one lock
per class per transaction: no two of these writers can each hold what the
other waits for. Outside the order: `delete_thought`, below. 023's `LOCK TABLE
… IN EXCLUSIVE MODE` is a table lock,
ordered against every INSERT and row lock and not against an advisory lock,
and the backfill takes none, so the two cannot deadlock either — the review
pass ran that three-way as well. READ COMMITTED throughout, as 018 and 023
already require: the waiter's read runs after the holder's commit and sees its
row, which is exactly where 022 said the lock was needed for its rule to
apply.

**A first review pass, triaged: two fixes, three tidy-ups.** The first version
of this change left `update_thought` at 018's order — row, then the fingerprint
lock, and only when the row did not own the key — and argued the capture's
fingerprint → row could not cross it: the row a capture waits for under the
lock for X is the row that *owns* X, and an edit of that row into X skips the
lock. True of any two transactions, and the pass reproduced a cycle of four
against a real server: R owns Y and R′ owns X; edit(R → X) holds R and waits on
the lock for X; capture(X) holds that lock and waits on R′ for its label read;
edit(R′ → Y) holds R′ and waits on the lock for Y; capture(Y) holds that lock
and waits on R. Two edits swapping two rows' texts while both texts are
re-captured, all inside one statement's duration — rare, but a hard cycle
Postgres breaks with 40P01 in one of the four, and before this change nothing
could deadlock at all, since the captures held no lock. Rather than state a
residue, the edit's order moved: `update_thought` takes the fingerprint lock
first whenever content arrives, so every writer's order is the same and there
is nothing left to cross; `test-live` [6f] runs the four by hand in 018's order
and gets the deadlock, then through the shipped functions and does not. The
other fix was numbering: PR #40 had merged meanwhile and taken change 61 and
`test-upgrade` [11], so this is 62 and [12]. The tidy-ups: 032's
`COMMENT ON FUNCTION validate_derived_from` still said `upsert_thought` carried
the rule inline, and is re-issued here; preflight's "025 re-applied by hand puts
it back" is the wrong cause on the brain every operator has the morning of the
upgrade — 033 pending, not re-applied — so the parenthetical follows the
ledger; and a [33] assertion that read the last definer from the *files* to
"prove" a catalog state now reads `pg_proc`.

**A second pass, triaged: the stop signal, one residue named, two lines.** Its
top finding was in the first pass's prose, not its code: the new proof said
*every* writer of `thoughts` is in the order, and `delete_thought` is not. 009's
DELETE holds the thought `FOR UPDATE` while 029's `ON DELETE CASCADE` reaches
the proposals that name it; an acceptance locks the proposal row first (029's
order, which the first pass's list also left out), then the supersession lock,
the superseding row, and asks `KEY SHARE` on the thought being deleted. Two
shipped functions, a cycle of two — reproduced 23 times in 40 against a real
server, the delete the victim each time; a plain edit naming `supersedes`
against the same delete 0 in 40 (0 in 60 on the third pass — and not, as
this paragraph first said, because it holds no proposal row: the delete's SET
NULL cascade does wait on the edited row, and no cycle forms because the FK
check takes `KEY SHARE` on the target only when the pointer *changes*, and a
changed pointer names another row than the one being deleted). Pre-existing
since 029/032 and not this change's to fix — the fix is a `delete_thought`
that takes the supersession lock first, **SMD-1462**, which also carries the
smaller thing the probe saw (a target deleted between `update_thought`'s walk
and its UPDATE surfaces as 23503, not `SUPERSEDES_NOT_FOUND` as 032's COMMENT
promises). The proof is scoped to the writers it names, here and in the
header; the review path's order is stated with the proposal row first; and
§60's pointer to this change said 61. Everything the first pass added — the
moved lock (the two bodies diffed mechanically: one block moved, nothing else),
the carried DROP block (032's identical first `WHEN`, so an existing 9-argument
form's ACL is never touched), [6f]'s waits, `pre033()`'s three branches — was
verified and held.

**Closed, and not.** Closed: a capture racing an edit to the same text (the edit
is told, not refused); two first captures of one text (the second finds the
first's row and 022's rule decides its windows); an edit moving a row onto a
text as it is captured (likewise); a capture filling a NULL pointer while an
edit walks the chain (ordered now). Not closed, and stated in the header: a
re-capture filling a NULL `supersedes` pointer is not *walked* for a loop — R
with no pointer, X superseding R, then R's text captured naming X, one after
another with no race, writes R → X → R. 025's "add if empty" never walked; the
lock orders the fill against the walk, it does not add one. `trace_provenance`
is cycle-guarded, so the cost is two rows both labelled superseded; [33] writes
the loop and shows `update_thought`'s walk seeing it (as of this change; since
change 66 that case is [35]'s and asserts the reverse), and **SMD-1453** holds
whether the fill should walk, refuse, or go — change 60's envelope makes "go"
possible (gone, in change 66: migration 035 drops the fill, and with it the
supersession lock from the capture path). Also unchanged on purpose: 022's
"unknown vouches for nothing" for a caller sending a vector and no label
(SMD-1245's question), and the 2-argument
form's silence on `derived_from` / `supersedes`.

**The sentinel, and the preflight.** Both bodies carry
`ob1:capture-takes-fingerprint-lock` (014's convention). `atomic capture` reads
it over a direct connection beside 022's sentinel and 025's clause, so the
warning now grades a stale 3-argument body four ways — before 022, before 025,
before 033, or missing (five, with before 035, since change 66) — and a stale
2-argument body two ways — before 005 (no guard) or before 033 (005's guard,
no lock) — and the remedy is one file in every case, since 033 is the last
definer of both forms (035 since change 66); the "apply 005, then 025 again"
two-step is gone. `test-preflight` walks 021, 022, 025, 003 and 005 re-applied
by hand over 033 (over 035, with 033 in the walk, since change 66) and asserts
each warning's text and its one remedy.

**Where the disclaimers went.** 018's file is applied and hashed by the ledger,
so its header and COMMENT stay as written and 033 re-issues the COMMENT on
`update_thought` without the clause; `db/README.md`'s 018 row and re-embed
paragraph, `reembed.ts`'s header and its `processRow` comment now say what is
true (a load that inserted the text around `upsert_thought` can still raise
the violation; a capture cannot), and change 33 above carries a note.

**Cost.** One advisory lock acquire per capture — a shared-memory hash entry, no
I/O. Measured at the shipped width (1,024 dimensions), 2,000 operations per
line, four arms in alternating order — 032, 033, 032, 033 — each on a fresh
schema, so the table and the HNSW index grow the same way inside every arm (a
first version ran the rounds on one growing table, and every later round was
slower whatever the body: the index, not the lock). The first arm was the cold
container and is discarded (5.2 ms for a 2-argument capture that costs 0.4–0.8
ms warm). Warm, per operation: fresh 2-argument capture 0.80 ms at 032, 0.39
and 0.68 ms at 033; fresh 3-argument capture with a vector 5.8 ms at 032, 5.0
and 5.7 ms at 033 (the HNSW insert is the cost); re-capture without a vector
2.3–2.7 ms at 032, 2.0–3.0 ms at 033; re-capture with a vector at the same
label 2.2–2.6 ms at 032, 2.2–3.4 ms at 033. Inside the run-to-run spread on
every line, on either side of it. One cost is a ceiling rather than a
per-operation figure, and the third pass measured it: a capture *naming*
`supersedes` holds the one brain-wide supersession key from before its label
read to commit, HNSW insert included, so such captures have no parallelism
among themselves — 200 concurrent at 1,024 dimensions took 1,388 ms, 6.9 ms
each, exactly the serial per-call cost; 50 concurrent ran 3.4–4.4× slower than
the same 50 without `supersedes`. About 145 pointer-naming captures a second at
the shipped width, whatever the worker count; a consolidation or import
pipeline that writes pointers is bounded by it. A fresh row cannot close a
loop — only the ON CONFLICT fill can — but which a capture is becomes known
only under the fingerprint lock, and the supersession lock must precede that
one, so the lock cannot be narrowed without changing the fill; SMD-1453 holds
that question together with the fill's (answered in change 66: the fill goes,
the lock with it, and 200 concurrent pointer-naming captures take what 200
plain ones do).

**A third pass, at the user's call, run rather than read: two documentation
findings, nothing that fails.** The migrator applied 033 onto a populated
032-ledger brain (one applied, bodies and ledger sha right, no row or audit row
moved), `--reapply` re-ran all thirty-three in one transaction and left
`update_thought` one function with the lock before its row, `--dry-run` saw
nothing pending and no drift; preflight on the day-of-upgrade brain said
"migration 033 is not yet applied" from the ledger branch the fixture cannot
reach, and "025 re-applied by hand puts it back" once the ledger recorded 033;
twenty concurrent captures of one text with twenty concurrent edits into it
through the SQL store gave one row, twenty merged keys, twenty
`DUPLICATE_CONTENT`s, nothing thrown; twenty two-argument captures audited
twenty distinct actors; `reembed.ts` over thirty raw legacy-twin pairs with
four workers finished with no failed claim and thirty `duplicate_of` groups;
sixty raced delete-versus-edit pairs gave no 40P01 (the accept-versus-delete
control gave 14 of 20, SMD-1462 as stated). The two findings are above: the
serialisation ceiling the Cost section omitted, and the wrong "why" in the
second pass's residue sentence.

**Verified.** `test-schema` [33] (791): three overloads and one
`update_thought`, the lock spelled once across the three bodies, the
acquisition order read by position in the source (supersession, fingerprint,
the label read, the INSERT; supersession, fingerprint, the row in
`update_thought`), no inline copy of either rule left, every earlier piece by
name, a 2-argument capture attributed, no advisory lock held after a call, the
residue loop written and seen by the walk (as of this change — [35] holds the
reverse since change 66), and the trap — 025 re-applied puts
an unlocked 3-argument body back, 005 both, 032 puts 018's order back in
`update_thought`, 033 restores all three; [22], [23], [31] follow the last
definer. `test-live` [6f] (479): the four-way, by hand in 018's order to the
deadlock, then through the shipped functions to two `DUPLICATE_CONTENT`s with
both edits holding nothing while they wait. [6e]: a 2-argument capture of X held open
while an edit of another row into X waits on the *advisory* lock in `pg_locks`
and is told `DUPLICATE_CONTENT` when the capture commits, one row holding X; a
first 4-argument capture with a window held open while a chunkless re-capture
waits on the same lock, the window kept at the same label and gone at another;
a capture naming `supersedes` waiting on the supersession lock while one
naming none is not (as of this change; arm 3 asserts the reverse since change
66). `test-upgrade` [12] (147): 033 onto a populated 032 — no
column, signature, row, window or audit row moves, the 3-argument form's
hardened ACL is kept across `CREATE OR REPLACE`, `update_thought` one function
with the lock before its row where 032's had it after, a same-model re-capture
keeps its window and pointer, the 2-argument form resolves and attributes, a
re-run is a no-op. `test-preflight` (192), both store suites, `test-e2e-sql`,
`test-update-delete`, `test-audit`, `tsc`, the consistency checker.

Upstream status: **not applicable** — upstream's `upsert_thought` (the
getting-started guide's, and the fingerprint recipe's) has no fingerprint lock
in either function, and upstream has no `update_thought` that takes one.
