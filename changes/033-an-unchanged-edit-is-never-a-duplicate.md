# 33. An unchanged edit is never a duplicate — the re-embed stops failing legacy twins

Migration 018 (Linear SMD-1022, found by the first review pass of change 29).
`update_thought` ran its duplicate check whenever `p_content` was given: another
row carrying the same fingerprint meant `DUPLICATE_CONTENT`. The check assumed
the text was new. `db/reembed.ts` passes each row its own unchanged text,
because that is the only way to make `update_thought` replace the embedding and
the chunk rows — and for one class of row the check then refused the row's own
text. Migration 003 added `content_fingerprint` with a partial unique index and
no backfill, so a brain from before it can hold two rows that normalise to the
same text, both with NULL fingerprints; a load that inserted into `thoughts`
directly leaves the same state. Re-embedding the first of the pair gave it a
fingerprint as a side effect. Re-embedding the second found the first and was
refused: failed, exit 1, and `--retry-failed` reproduced it on every run while
`ob1_config` already recorded the new model. Rows from before 003 are the
common case for any brain that predates this fork.

**One writer stays one writer.** The alternative was a dedicated
`reembed_thought` that sets the vector and replaces the chunks without touching
content or fingerprint. It would have copied the stale-read guard, the actor
setting and the chunk replacement out of `update_thought` — a value defined
twice, the defect this fork keeps removing, with every stored vector as the
value. Instead `update_thought` is redefined with one rule: when the new text
normalises to what the row already holds, the edit cannot create a duplicate
that was not already there, so it is not refused. If another row already holds
that key, this row's fingerprint is set to NULL — whatever a raw update around
the function may have left there — so the partial index is never violated, and
the result names the holder: `duplicate_of` when its text is the same, a twin;
`fingerprint_held_by` when its key is stale and this row cannot take the
fingerprint it should have. Otherwise the fingerprint
is written: the backfill 003 never had, one row at a time, now stated rather
than incidental. Editing a thought *into* another thought's text is refused
exactly as before. The hash rule comes from 016's `content_fingerprint_of`
rather than a third inline copy, and 008's actor, 009's millisecond-truncated
guard in the UPDATE itself and 013's `context` are carried forward — the trap
008's header records, checked by name in `pg_proc` by `test-schema.ts` [19].

**The race, closed where it lives.** Two workers reaching the two rows of a
pair at the same moment both passed the check — the first's fingerprint was
uncommitted — and the second then blocked on the unique index and raised
`duplicate key value violates unique constraint "idx_thoughts_fingerprint"`
when the first committed: measured, with the lock line removed. `update_thought`
now takes a transaction-scoped advisory lock on the fingerprint before the
check, for every content write through it that would take a key the row does
not already own, so two edits to one text are serialised and the lookup that
follows is authoritative under READ COMMITTED — the default, and stated as the
precondition it is. `test-live.ts` [6b]
holds the first twin's transaction open on one connection, shows the second
waiting on the *advisory* lock in `pg_locks` rather than on a transaction id,
and gets ok with `duplicate_of` once the first commits. The same lock turns
009's documented race for a genuine edit — two rows edited into the same new
text at once — into `DUPLICATE_CONTENT` instead of a constraint error. It
covered edits only until change 63: `upsert_thought` wrote fingerprints without
it, so a capture of text X committing while an edit to X was in flight still
ended in the edit raising the unique violation, exactly as before this change
(migration 033 takes the same lock in both capture forms). One lock per
edit; deadlock would need a transaction that calls `update_thought` twice with
different texts while another does the reverse, which no caller does.

**What the pass does with it.** `reembed.ts` requires 018 (exit 2 naming the
migration otherwise — a pass against 013's body fails every legacy twin for
ever), says per row when it found a pair, and prints every group of thoughts
sharing one normalised text at the end of a run and under `--status`: one query
over the corpus, hashing every row's text rather than trusting the column, so the
list is the same before, during and after a pass. Both rows are re-embedded;
only one carries the fingerprint, so a later capture of that text merges into
it and not the other. Whether they should be one thought is the operator's
call, and nothing is written to the claim row — that per-row-outcome decision
belonged to SMD-1021, change 34. The `update_thought` tool appends the same note to its
reply, and `normaliseMutation` carries `duplicateOf` for both stores. Stated in
018's header and not fixed: `upsert_thought` capturing text equal to a legacy
NULL-fingerprint row still creates a second row, since `ON CONFLICT` cannot see
a NULL; the pairs query surfaces those too. `test-schema.ts` [19] (at the
default width and at 8), `test-live.ts` [6b] and a legacy pair in [9]'s
fixture, `test-update-delete.ts` [8b].

**A first review pass, triaged: eight fixes, one ticket.** Two were behaviour.
The migration-018 check in `reembed.ts` sat above the read-only branch, so
`--status` and `--dry-run` refused to run on a brain at 017 — a report command
demanding a schema write; it runs only before a pass now. And the CASE that
kept "the row's fingerprint, necessarily NULL" when a duplicate was found kept
whatever was there: a raw update around `update_thought` (upstream's pre-009
path never recomputed the column) leaves a hash describing text the row no
longer holds, and 013 at least refused that row where 018 accepted it and kept
the hash. It writes NULL now, which is what the comment claimed, and [19] plants
the stale case. The rest: the duplicate predicate was written twice behind an
IF/ELSE — one lookup after the lock, one condition for the refusal; the
`duplicates` counter disagreed with the group count by construction (a pair's
first row is never reported) and is gone; `reembed.ts` asked for the field
name `duplicate_of` in `prosrc` where the repo's convention is a contract
sentinel, so 018 carries `ob1:unchanged-edit-not-duplicate` and the pass, and
[19], ask for that; [6b]'s connection A had no `.catch`, so a throw there
would have ended the suite before the tally; and the claim that "writers of one
fingerprint are serialised" was scoped to what is true — edits, under READ
COMMITTED, with `upsert_thought` uncovered — here, in the header, the COMMENT
and `db/README.md`. To a ticket: the one-shot fingerprint backfill 003 never
had (SMD-1042, done in change 41), feasible now that `content_fingerprint_of` exists and the
right fix for every legacy singleton a pass never visits, but a data migration
with its own questions about a full-table hash inside one transaction.

**A second pass, triaged: eight fixes, one ticket, one declined.** Two were
behaviour and both were about trusting a read. "Unchanged" was decided from a
row read without a lock, so a caller passing no `if_unchanged_since` could
read X, have another edit commit Y, and write X back over it as an unchanged
edit — the interleaving 013 refused; the row is read `FOR UPDATE` now, before
the advisory lock, which also puts the two locks in one order and removes the
deadlock a transaction holding a row could have met from one ordinary
concurrent edit. And the lookup trusted the other row's stored hash: a row
whose column still said hash(X) while its text was something else was reported
as the twin, and the operator sent to delete the wrong row. The holder's text is
hashed again; `duplicate_of` means the same text, and a stale holder is
reported as `fingerprint_held_by` instead, with [19] planting both sides of the
stale case. The rest: the pairs report groups by the hash of every row's text
rather than the column, so a stale row is bucketed by what it says and the list
really is the same across a pass; `--status` on a brain at 015 crashed on the
016 function the report needs and now says so in one line; [6b] counts advisory
waiters for B's own backend rather than the whole server; the lock, the second
hash and the lookup are skipped when the locked row already owns the key, which
the unique index makes safe and which is every fingerprinted row a pass
visits; and this section's design paragraph, which still said "left as it is".
To a ticket: taking the same lock in `upsert_thought` (SMD-1043), which would
make "writes of one fingerprint are serialised" simply true and delete the
disclaimers, but redefines two capture overloads on the hot path. Declined:
not writing the fingerprint on an unchanged edit at all — it would leave every
legacy singleton unfingerprinted until SMD-1042 ships (change 41), and a recapture would
create a second row where 013 already merged; the header now states that
arrival order is the ownership rule until SMD-1042 replaces it (change 41 does: oldest by `created_at`, then id).

**A third pass, triaged: ten fixes, and the stop.** Nothing in the rule
itself. Two were in the pass: "DUPLICATE_CONTENT cannot reach here" was false
— `updated_at` is the editing transaction's start time at millisecond
precision, so an edit that began before the worker's read and committed after
it passes the guard, and the worker's text is then a change into another row's
— so the pass treats it as it treats STALE_READ, re-read and retry; and the
pairs report, made to hash every row's text in the second pass, ran on every
`--status`, which is asked repeatedly during a pass, so on a large brain a
cheap probe appeared to hang — it hashes only the rows without a fingerprint
again, and the stale key it would have caught is reported by the pass itself
through `fingerprint_held_by`. The probe for 018 matches the exact signature
the pass calls rather than the name, consults the ledger so a brain adopted
with `--baseline` is told to re-run the body rather than told to apply a
migration the migrator will skip, and `--dry-run` reports the refusal a run
would make instead of a worker plan. Two claims made true: a transaction
holding locks from an earlier call can still deadlock against one ordinary
edit — lock order is per call — and a refused call now returns with the row
locked until the caller's transaction ends, where 013 held nothing. The
`duplicate_of` note no longer asserts that both rows predate deduplication,
since a fresh capture merged around a legacy row produces the same result; it
says what is known and asks the reader to read both before deleting. A
vacuous assertion in `test-update-delete.ts` [8b] and two stale numbers in
this file. Nothing here touched `update_thought`'s rule, which is the signal
to stop reviewing and open the PR. Then the tidy-ups the three passes had cut
for space, since the files were open: 018 reports the twin or the stale holder
straight from the lookup's two columns instead of copying them into two more
variables, the pass says the two things 018 reports in one place, the pairs
query counts with a window instead of a second scan of its own CTE, and the
tool's note lives beside `explainRefusal`, which is where a reader looks for
what the tool says about an edit.
