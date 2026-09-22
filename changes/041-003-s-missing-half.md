# 41. 003's missing half — migration 023 fingerprints every legacy singleton, and the oldest of each twin group, once

`db/migrations/023_content_fingerprint_backfill.sql` and
`server-portable/preflight.ts` (Linear SMD-1042, filed by change 33's first
review pass). Migration 003 added `content_fingerprint` with a partial unique
index and no backfill, and its header gave no reason. Every row from before it
carries NULL, and so does every row a load inserted around `upsert_thought` —
the getting-started guide's hand-pasted schema is exactly such a brain. So a
capture of a legacy row's text inserted a SECOND row: `ON CONFLICT` cannot see a
NULL, the capture succeeded, search returned both, and every later capture of
that text merged into the new row while the old one stayed. 018 states this and
does not fix it; its only backfill is one row at a time, on the rows a re-embed
pass visits, and a brain that never switches model keeps every pre-003 singleton
unfingerprinted for ever. 018's header deferred the ownership rule here in so
many words — "whichever edit committed first, until SMD-1042 states a rule
(oldest by `created_at`) and applies it to the rest".

**The rule: the oldest takes the key, when the key is free.** A row without a
fingerprint takes `content_fingerprint_of(content)` (016's function, byte-
identical to 003's inline rule) when no row holds that key and it is the oldest
of the NULL rows that hash to it — `created_at`, then id, NULL `created_at` (a
raw load may leave it) last: the order `reembed.ts`'s pairs list prints a group
in — and the list now marks the row holding the key, so what 023 decided is
readable there (a fingerprinted row keeps the key whatever its age). A legacy
singleton — the common case — is fingerprinted and a capture of its text merges
into it from then on. True twins end with exactly one fingerprinted and the rest
NULL, the state 018 leaves after a pass, so `duplicate_of` and the pairs list
keep meaning what they meant. A NULL row whose key another row holds — the same
text under a fingerprint, or a stale key left by a raw update of content (018's
`fingerprint_held_by` case) — stays NULL: the key is taken, whatever the
holder's text, and 018 decided that. No existing key is touched, right or stale.
Not the community recipe's rule: `recipes/fingerprint-dedup-backfill` strips
punctuation, possessives and plurals before hashing, so its fingerprints never
match capture's; a brain that ran it holds stale keys, and 023 leaves them.

**A function, so the remedy is one statement.** The rule lives in
`backfill_content_fingerprints(p_limit integer DEFAULT NULL)`, and the file
calls it once. 021's backfill is an inline `DO` block; this one is a function
because it is needed again — a load that inserts into `thoughts` directly after
023 leaves NULL rows again, and the remedy is then `SELECT
backfill_content_fingerprints();`, one statement preflight can name rather than
a body to paste (the remedy shape SMD-1193 found wanting). Re-applying the file
re-runs it and it writes nothing: it hashes only the rows whose fingerprint is
NULL and whose key is free. `p_limit` is for the by-hand path — batches until it
returns 0, and the `NOT EXISTS` sits inside the limited set so 0 means none
remain (`p_limit` is at least 1; 0 is refused). It returns the rows it found
waiting — each written unless a writer settled it while the call waited for the
lock, and a row settled that way is no longer waiting — so a loop until 0 is
exact. The scan runs before the lock, at ACCESS SHARE, into a temporary table
dropped with the transaction; under the lock the rows found are re-checked by
index — still NULL, still the text that was hashed, the key still free — so a
batch costs its writers the batch's own writes and never a rescan of every NULL
row, and a raw edit of content in the window is never given a key for text it
no longer holds. The file's own call takes `{{BACKFILL_LIMIT}}` — NULL unless
`OB1_BACKFILL_LIMIT` is in the migrator's environment at that invocation, the
channel `{{TRGM_INDEX}}` already uses, validated in `config.mjs` and forwarded by
the compose migrate service.

**One transaction, and the lock is the point.** Once the scan has found rows,
the function takes `LOCK TABLE thoughts IN EXCLUSIVE MODE`, held to commit — a
no-op re-run takes no lock at all — and the lock is what
makes the rule exact. A concurrent `upsert_thought` of a legacy singleton's text
cannot insert a fingerprinted row under the backfill and leave the UPDATE to
raise 23505: the INSERT waits, then lands `ON CONFLICT` on the row 023 just
fingerprinted and merges — the defect fixed in the same instant it would have
struck. A concurrent `update_thought` — a re-embed pass reaching a legacy twin —
waits at its `SELECT … FOR UPDATE`, because ROW SHARE conflicts with EXCLUSIVE,
and its holder lookup then sees the committed key and answers `duplicate_of`.
The trigger hold alone would take only SHARE ROW EXCLUSIVE, which ROW SHARE does
not conflict with: under that lock the edit passes its lookup, waits at its
UPDATE, and raises 23505 after the commit — the symptom 018 removed, back for
the duration of the upgrade. Reads proceed throughout. A write in flight before
the LOCK holds it up until that write commits, bounded by a transaction-local
`lock_timeout` of 10 s, so an idle-in-transaction writer fails the migration
(re-run it) rather than queueing every other writer behind the wait. The
re-check needs READ COMMITTED, which is the default and what `migrate.ts` runs
at, as 018's header says of its lock; under REPEATABLE READ the unique index
gives the answer instead — 23505, the file rolls back whole, a re-run succeeds.
Every writer into a table that references `thoughts` waits on the lock — the
foreign-key check takes ROW SHARE — so both 015 consumers park for its duration
and their leases expire: a re-embed pass at `update_thought`'s `FOR UPDATE`, an
entity-extraction worker at its insert. The header says to stop both first, or
batch under the lease. The
`updated_at` trigger is held off for the UPDATE as 021 holds it: the fingerprint
is not an edit, and two rules read that column — 021's `updated_at <=
finished_at` evidence and 018's `if_unchanged_since` guard. 008's audit trigger
diffs content, metadata and the vector's presence, so a fingerprint-only UPDATE
writes no audit row; 016's entity trigger fires on `UPDATE OF content` only.

**What it costs.** `content_fingerprint` is indexed, so the UPDATE is never HOT:
every row written is a new tuple entered into every index on `thoughts`, the
HNSW index included — 021's backfill is not a precedent, `embedding_model` is
unindexed and that UPDATE was HOT. Measured on the test container at 1,024
dimensions, 20,000 legacy rows with random vectors beside 20,000 fingerprinted
ones: the whole-corpus call 59 s — 3.0 ms a row, and the HNSW index is the cost,
since the same call with that index dropped takes 0.36 s; a `p_limit` batch of
1,000 2.0 s; the no-op re-run 8 ms, taking no lock. About five minutes of
waiting writers per 100,000 legacy rows. `migrate.ts` sets no `statement_timeout`, so a server
default applies; the header says to apply the migration in a quiet window, and
gives a brain with millions of legacy rows the batch path without a hand-edited
file: `OB1_BACKFILL_LIMIT=10000 bun migrate.ts` (one batch, and the ledger row),
then `SELECT backfill_content_fingerprints(10000)` until it returns 0, each call
its own transaction — preflight decides "pending" from the rows, not the ledger,
and warns until the loop is done. The migration builds `ob1_fp_backfill_idx`, a
partial expression index on `(content_fingerprint_of(content), created_at, id)
WHERE content_fingerprint IS NULL`: the scan is an ordered walk of exactly the
rows waiting, a batch's LIMIT stops it early instead of every call rehashing and
sorting every NULL row still waiting, preflight's probe on every start reads it
rather than the heap, and on a fingerprinted brain it is empty — `upsert_thought`
always writes the key, and the backfill moves rows out of it.

**Preflight.** `fingerprint backfill`, over a direct connection: a thought
without a fingerprint whose text no row holds is a warning — naming 023 where the
function does not exist, and where it does the one statement and its batched
form, claiming no cause it cannot read (a batched upgrade still running looks
the same as a raw load), as the table's
owner (the function holds the trigger, so it needs the owner; preflight reads
the owner from `pg_class`), or — where the ledger already says 023 and the
function is absent, a brain adopted with `--baseline` — the body by hand, since
the migrator would skip the file; NULL rows that each share their text with the
row holding the key — twins, or a stale key — are ok, pointing at the pairs
list; no NULL row is ok, said as "missing", since a stale key on a row that has
one doubles on capture too and is not read here. Presence is read from the
catalog first, so a brain before 003 or 016 is a skip, not a raise; the
`EXISTS` stops at the first pending row, so a brain before 023 answers at once.
Over PostgREST a skip, beside `atomic capture` and `write privileges`;
and the direct-connection block's checks are now one list, so a connection that
fails between two of them leaves the first unreported carrying the error and
every later one saying it was not reached — never a second row for a check that
already reported. A warning, not a failure: captures work, they double.

**Verify, as the ticket asked.** `db/test-upgrade.ts` [6]: 023 onto a populated
022 — at 022 a capture of a legacy row's text inserts a second row; after 023
exactly the singletons and the older twin carry fingerprints, the row whose text
a captured row holds stays NULL, no `updated_at` moves, no audit row, the
trigger is enabled again, the schema gains one function and no column, a
capture of the former singleton's text merges, and a re-apply writes nothing.
`db/test-schema.ts` [24]: the rule through planted rows — a singleton, twins
dated apart, a pair whose older row has no `created_at`, a row whose text a
captured row holds, a row whose key a stale holder carries — three written, the
rest NULL and the stale key untouched; a capture merges; an unchanged edit of
the newer twin names the older as `duplicate_of`; `p_limit` batches, the third
returning 0 with the blocked rows still there; [2] re-applies 023 as a no-op.
`db/test-live.ts` [6c], on a real server: the backfill held open on one
connection, a capture of the singleton's text and a re-embed of the newer twin
on two others — `pg_locks` shows both waiting on the *relation* lock; once the
first commits the capture returns the singleton's id and the edit is told
`duplicate_of`, not 23505; `reembed.ts --status` lists the same one group before
and after. `server-portable/test-preflight.ts` [5]: the warning with the
one-statement remedy naming the owner, the ok once run, the twin as ok, and the
function dropped as a warning naming the migration until 023 is re-applied.

**A first pass, triaged: ten fixes, one ticket.** The scan ran under the table
lock, so the header's batch path for millions of rows rescanned every NULL row
per batch, writers waiting — the scan now runs before the lock at ACCESS SHARE
into a temporary table, and the rows found are re-checked under the lock by
index. The header, the README and this section said the first id the pairs
list prints is the row that takes the key, which is false where a fingerprinted
row already held it — the list now marks the holder and the claim is scoped.
The batch path itself was "run the file by hand up to its last line" — the call
reads `ob1.backfill_limit` instead. `p_limit` 0 returned 0 with everything
still waiting — refused, before the lock. The re-check's argument needs READ
COMMITTED and did not say so; a re-embed pass running during the upgrade parks
every worker until its leases expire, unsaid — both in the header now. In
preflight: an ok that said "every thought carries a fingerprint" while a stale
key doubles on capture as a NULL does, narrowed to "missing" with what is not
read; the "apply 023" remedy on a `--baseline`d brain whose ledger already says
023, now the body by hand as `reembed.ts` says for 021; a skip branch for a
missing table that could not be reached, since the same statement referenced
the table — presence read from the catalog first; and the block's outer catch
reported only `atomic capture`, so a failed catalog connection silenced this
check and `write privileges` — both say so now. To a ticket: a census of
stale keys (a brain that ran the community recipe holds one on every row), which
means hashing every fingerprinted row and belongs to a command, not a start.

**A second pass, triaged: nine fixes, one ticket, and the stop.** The top
finding was in the first pass's own addition: the re-check under the lock asked
whether the row was still NULL and the key still free, not whether the row's
text still hashed to the key found — a raw edit of content in the window would
have been given a stale key by the migration itself. It asks now. The pairs
list's new mark grouped a stale-key holder with the NULL row it blocks and
advised deleting the unmarked row, the only one carrying the text — the holder
is marked STALE and the advice says re-save it, delete nothing; and "the next
pass gives it to the oldest" was 018's arrival order misdescribed. The
`fingerprint backfill` warning claimed the pending rows were loaded since 023,
which a batched upgrade still running contradicts, and prescribed the unbounded
call — neutral now, with the batched form beside it; its ledger probe raised
for a role without SELECT on the ledger — guarded; its count of NULL rows was
an unbounded heap scan on every start — bounded at 10,001. The outer catch
still added `atomic capture` unconditionally and covered two names — one list
of the block's checks drives it. The header named only a re-embed pass to stop,
where every foreign-key writer waits — both 015 consumers now. The batch loop's
scanning is the square of the corpus over the batch, unsaid — said, with the
expression index that makes each call an ordered walk. To a ticket: a BEFORE
INSERT trigger computing the fingerprint a raw INSERT omits, which closes the
door 023 sweeps behind — a second mechanism, weighed in the header.

**A third pass, triaged: ten fixes, and the stop held.** The top finding was
again in the previous pass's own addition: the check list the outer catch now
reads blamed the wrong check when one of the block's checks could end without
reporting — `candidate scan` where `match_thoughts` is undefined, `embedding
contract` where `ob1_config` has no width row — so both report now, and an error
after every check has reported is no longer dropped. The batch limit was a
persistent role-level setting read unvalidated — a typo failed the migration
with a message naming neither, and a forgotten RESET batched every later run
under that role — so it is `OB1_BACKFILL_LIMIT`, the migrator's run-scoped
substitution channel, validated in `config.mjs`. The `fingerprint backfill`
probe hashed every NULL row on every start in the steady state 023 leaves —
bounded to the first 10,001, and the ok says how far it looked; its ledger
presence and read were a third copy of a fact the block already held — one read,
hoisted, that every ledger-aware remedy shares. The pairs list's advice for a
stale holder assumed one unmarked row where twins a stale holder blocked are
two — reworded, and the header says so. Each batch call must be its own
transaction and the header, COMMENT and remedy did not say so — they do; "takes
no lock at all" was imprecise — it takes no table lock. The holder probe ran
once per NULL row rather than once per key — after `DISTINCT ON` now. And the
list itself is kept in step with the block by a test that reads the source and
proves an unreachable database names every check.

**A fourth pass, triaged: nine fixes, one ticket, and the stop held.** The top
finding was in the third pass's own addition: the batch-limit resolver ran at
module scope in `config.mjs`, which the servers, preflight and `reembed.ts` all
import — a malformed value for a migrator-only setting would have stopped every
one of them at import, the gate meant to name the problem first. It resolves
inside `migrationValues()` now, where only the migrator and the schema tests
ask; it caps at int4, since a larger literal typed bigint would have matched no
overload; the test harnesses pin it, since the shell's value changed what a
suite applied; the compose migrate service forwards it and `.env.example` names
it, since under compose the documented path had silently done nothing; the
migrator prints the value in force; and "run-scoped" says what it means — the
environment at that invocation, a `.env` beside the migrator included. The
`--baseline` remedy said "re-run the body", whose last line is the template
placeholder — it says to substitute NULL, and says so too where the role cannot
read the ledger, instead of a remedy the migrator would skip. The capped ok
claimed "the first 10,000" and stayed ok while a waiting row could sit beyond
the sample — it says what it sampled, what it did not read, and the statement
that settles it. The check list's test guarded set equality where the catch
depends on order — order now, with the anchors asserted. And the partial
expression index the header prescribed as a hand step is built by the
migration: the steady-state cost of the probe on every start was a heap pass,
and is an index walk. To a ticket: a trigger that NULLs a key not equal to its
row's own hash, which would make the stale-key state unrepresentable and retire
the prose that explains it — a second mechanism, weighed in the header beside
the fingerprint-computing one.

**Tidy-up, while the files were open.** No behaviour change. `plantLegacyRow`
and `updatedAtTriggerState` in `db/test-support.ts` for the fixture and the
catalog probe two suites had verbatim; `test-schema.ts`'s `fpOf` at file scope
instead of in two sections; the count `test-upgrade.ts` [6] and `test-schema.ts`
[24] named "written" named "found", as the function documents it; one detail
prefix for `fingerprint backfill`'s two warnings; and `db/README.md`'s 022 bullet
saying `FOR UPDATE` where the body, its header and the test all say `FOR NO KEY
UPDATE`.

**Not done here.** A BEFORE INSERT trigger that computes the fingerprint a raw
INSERT omits, and its sibling that NULLs a stale key (tickets, above). SMD-1043's advisory lock in both inserting
`upsert_thought` overloads (done in change 63) — 023 redefines no function, and a capture racing an edit outside the
backfill's transaction still ended as 018's header says until then. Deleting the extra twin
stays the operator's call (`delete_thought`; the pairs list names them). 018's
file is applied and hashed, so its disclaimers deferring to SMD-1042 stay as
written; `db/README.md` is what moves. The function carries no sentinel — it is
new and has no successor; SMD-1227 tables the sentinels.
