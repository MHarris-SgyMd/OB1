# 95. A thought cited as a source cannot be deleted from under the citation — `thought_facets` with one kind, a statement-level guard on `thoughts` that refuses with its own SQLSTATE, `delete_thought` answering it as a value with the citing rows named, and a detach opt-in (SMD-1712)

Nothing on the fork recorded that one thought is the *source* of a statement
made in another. Change 46 (migration 025) records what a thought was derived
from and which thought it replaces — facts about the whole thought. A citation
is finer: "this statement in note C rests on thought S". Without it,
`delete_thought(S)` removed a source a later note leaned on, silently, and the
note read the same afterwards with nothing behind it. The proposal bundle of
2026-09-12 drafted the fix — a `thought_facets` sidecar with a claim kind, a
`BEFORE DELETE` guard raising `foreign_key_violation`, `delete_thought`
catching it — against a `main` that had since moved under every hunk (the
ticket lists the eleven ways). The idea lands here as migration **042** on the
fork's own terms.

**The gate, and the number it was decided on.** SMD-1712 was gated on
SMD-1711's re-measure at ten tagged tickets. When this was built the log held
three (this file's "Review passes" section explains the tag): 9 review-pass
commits since the first tagged one, 69 finding rows, **68 tagged (99%)** against
**0 of 511** before the convention; cold-read caught 82% of the code and
test-teeth defects, run-it 11%, mutants 7%; defect share 42 / 28 / 62% at passes
one to three (small n). The epic SMD-1729 says to re-decide the gate on what is
tagged rather than let it stall Phase 2, and the operator called it: the tag
convention shows that what is recorded at the moment of the act is recoverable
and what is not, is not — 0 of 511 before, 68 of 69 after — which is the
thesis this facet rests on. The ten-ticket re-measure still runs when it can
(`bun scripts/mechanism-yield.mjs --since fe09f4d`); it now judges Phase 3.

**What 042 adds.** One table, `thought_facets` (`thought_id` → `thoughts`
`ON DELETE CASCADE`, `kind`, `payload jsonb`, `valid_until`, `superseded_by` →
a later facet, `ON DELETE SET NULL`), with **one registered kind**, `citation`,
payload `{text, stance, source_id}` — the statement, whether it was stated /
retrieved / inferred, the thought it rests on. `thought_facets_validate`
(`BEFORE INSERT OR UPDATE`) refuses an unregistered kind, a non-object payload,
an empty text, a stance outside the three, a `source_id` that is not an existing
thought or is the citing thought itself, all as `check_violation`; a later
migration registers a kind by extending the function, not by the proposal's
vocabulary registry, which is not built. A citation is *active* while
`valid_until` is null or future and no facet that still exists supersedes it
(`thought_facet_active`, the one spelling — why "still exists" rather than
"pointer is null" is below); only active citations gate a delete, and a read
should label an expired one, never hide it (change 46's rule, the ticket's
rider on proposal issue 04).

`thoughts_guard_citation_sources` is **`AFTER DELETE … FOR EACH STATEMENT`,
`REFERENCING OLD TABLE AS deleted`** — not the proposal's row-level `BEFORE`
trigger, and this was found while writing the tests, not designed in. A
row-level guard sees one row at a time: "delete the note and its source
together" would be refused or not by the order the rows came in (the note's
row first cascades its facet and the source then passes; the source's row first
finds the citation and refuses), and a reset — `DELETE FROM thoughts` — would
be refused the moment any citation existed. Order-dependent behaviour is the
class this fork treats as a defect, so the statement is the unit a deletion is
judged by: the guard counts the active citations whose source is a deleted row
**and whose own thought the statement leaves standing** — which is every
citation the join finds, because the cascade on `thought_id` is a row-level
`AFTER` trigger and Postgres fires those before any statement-level one. A
`NOT IN (SELECT id FROM deleted)` clause was written to say so explicitly; its
mutant passed every check, so it was removed rather than kept as a mechanism
that is not one, and the reliance is stated in the header. The guard judges the
state the statement *leaves*: deleting the thought that carries a replacing
citation together with the source revives the replaced citation on a note that
survives (`superseded_by`'s `SET NULL`), and the statement is refused — after
it, that note would rest on nothing, which is the question the guard asks. The
first review pass raised that case, and writing its test found the gap: the
`SET NULL` is a nested referential action and fires *after* the statement-level
guard, so the first draft judged the replaced citation still superseded, marked
it, and the `SET NULL` then revived it — detached, under refuse mode.
`thought_facet_active` therefore reads whether the superseder still exists,
not whether the pointer is null, which says what the `SET NULL` is about to say
whatever the phase order ([41] holds the case both ways). If
any survive, and the transaction-local `ob1.cited_delete` is not `detach`, it
raises **SQLSTATE `OB001`** and the whole statement fails. Otherwise it
*detaches* every surviving citation that named a deleted row, active or not:
the row keeps its text and stance, `source_id` becomes JSON null and
`source_deleted_id` / `source_deleted_at` record which thought went and when —
the citation survives as "rested on a thought deleted at T", which is what a
reader of the note needs to know, and no row names a thought that is gone. The
citing rows are read **under a row lock** (`FOR NO KEY UPDATE`) before anything
is decided, so each row's status comes from the version its lock won: a
citation revived by a concurrent writer — `valid_until` or `superseded_by`
cleared between a look and a write — is seen as active, where the first draft's
unlocked count followed by an UPDATE counted the old version as expired and
rewrote the new one under refuse mode (the first review pass's top finding;
`db/test-live.ts` [6i] arm 4 holds it against a real server, and
`thought_facet_active(thought_facets)` is the one spelling of "still counts" the
guard and the function's sample share). The rewrite runs only when the delete
proceeds — the first pass had made count and rewrite one `UPDATE … RETURNING`,
which rewrote every citing row and discarded the rewrite on each refusal
(second pass); the lock footprint stays and is stated: a refuse-mode delete of
a source cited N times holds N facet rows until the statement fails (fifth
pass). Nothing can slip in between the locked read and the rewrite: a new
citation's writer takes `KEY SHARE` on the source and waits on the `DELETE`'s
own row lock. A detach also moves the citing thoughts' `updated_at`: a facet
is part of its thought's record, so a reader holding an older
`if_unchanged_since` is told `STALE_READ` on its next edit rather than writing
text that still asserts the statement rests on the deleted source; only for
*active* citations, since marking an expired or superseded one is history's
bookkeeping and moving a clock for it would send an editor with nothing to
reconcile back to re-read (seventh pass); 008's audit trigger sees an empty
diff and writes no row, and a facet event on the audit trail is the event
shape's to define (SMD-1730; fifth pass). That bump locked
the citing thoughts *after* the facets, which the sixth pass caught as a
deadlock with a raw delete of a citing thought — that delete holds the
thought's row while its cascade wants the facets — so the guard now locks the
citing thoughts' rows *first*, before any facet: whoever wins the thought, the
other waits and no cycle forms ([6i] arm 6 holds it deterministically). Each
citing row is judged once, in the locked read; the refusal's sample and the
rewrite go by the ids that read classed, so count and sample cannot disagree
(sixth pass). The detached shape is accepted by the validate trigger
only as the guard writes it — from the source the row had, once that thought
is gone, with a real timestamp — so a raw `UPDATE` cannot detach a live
citation or forge a deletion; a detached citation is not re-pointed at a new
source either, since the reverse transition would leave the deletion keys
beside a live source (third pass) — though it follows its *own* source back
when 008/009's recovery restores that thought under its id, the deletion keys
going with the deletion (fifth pass); a detached row may arrive *whole* by
`INSERT` under the same checks, since a restore or an import of the facet table
would otherwise lose exactly the history the detach kept (fourth pass), its
deleted id stored canonical like a live one (fifth), and re-attached at once
when its lost source already exists again — a restore that brought the
thoughts back first (sixth); a citation *with* a source carries no deletion
keys, written or added, so no row reads as detached from a thought that was
never deleted (sixth); and
the source id is stored canonical, since
the validate regex is case-insensitive and a raw writer's upper-case uuid would
otherwise have been invisible to the guard's text compare — its source
deletable from under it (both second pass; [41]). `superseded_by` carries a
partial index, because its `SET NULL` is a referential action that scans for
the pointing rows on every facet the `thought_id` cascade removes (third pass).
It totals what it did in two transaction-local settings, summed across
statements. The refusal is the *table's*: a bulk `DELETE`, a vendored script,
`psql` all meet it, the way 008's append-only rule is `thought_audit`'s; the
way through is the setting, which only a caller who names it takes. The price
is the transition table, and it was measured rather than asserted (second
review pass, real server): `DELETE FROM thoughts` over 20,000 rows of
1,024-dimension vectors ran in 483 ms with the guard and 534 ms with it
disabled — medians of three, the difference noise — and a single
`delete_thought` of an uncited row takes 0.43 ms. The deleted tuples are held
as the statement already holds them; the DELETE's own work is the cost. Above
that size the reasoning, not a measurement: a transition tuplestore keeps each
tuple as the heap held it, TOAST pointers included, and at this width the
vector is out of line — a reset of a million rows spools headers and pointers,
not gigabytes of vectors, and spills as the DELETE itself does (the fifth pass
named the scale; no reset has been run at it here).

**Under READ COMMITTED.** Every lock-order argument on this fork — change 40's
fingerprint lock, 63's one order, 68's delete, this guard — holds because a
writer that waits on a row lock re-reads the row the lock won. A deleting
transaction run `REPEATABLE READ` or `SERIALIZABLE` reads its own snapshot in
the guard, so a citation committed after that snapshot and before the
`DELETE` is invisible to it and its source goes from under it; a real foreign
key uses a crosscheck snapshot a trigger cannot. The third review pass named
it; the header states the assumption, and preflight gains a **`transaction
isolation`** check that warns — not refuses — when the connection's default is
not read committed, naming the guarantees that rest on it and the `ALTER ROLE`
that restores it. The guard itself does not refuse on isolation, since every
other guarantee here already stands or falls with the same setting.

`delete_thought(uuid, jsonb, boolean)` is **036's body** — the actor and the
mode set first, *outside* the block (a caught exception rolls back its
subtransaction, `set_config` included, and 008's audit trigger must still see
the actor); the supersession advisory lock, also outside the block, since a
savepoint's rollback releases the advisory locks it acquired and this one must
outlive a refusal; then the `DELETE` inside `BEGIN … EXCEPTION WHEN SQLSTATE
'OB001'`, answering `{ok:false, error:'CITED', id, cited_by, citations}` — the
count and up to ten citing rows, newest first. Those ride in the guard's error
`DETAIL` as JSON, read from the rows the guard locked, and the function reads
them back with `GET STACKED DIAGNOSTICS`, so the answer is exactly what the
guard refused on. The first draft re-read the table after the rollback, under a
fresh snapshot where the rows could already differ from the ones that refused;
the fourth pass patched that with a retry when the re-read came back empty,
and the fifth removed the re-read instead — the guard already held the answer
(fifth pass). Only that SQLSTATE is caught: a real
`23503`, a permission failure, anything else propagates as the fault it is —
the proposal's `WHEN foreign_key_violation` would have reported every FK failure
on a delete as "cited". Success carries `detached:n` and, when non-zero,
`inactive:m`. The mode is the *call's*, not the transaction's: the setting that
was there is put back after the block, so a raw `DELETE` later in the same
transaction meets the guard's default, or the caller's own setting, and not
this call's `p_detach` (first review pass; [41]); the two running totals are
read before and subtracted after — the guard adds to them, a refusal's
rollback undoes its adding — so this call's own count is the difference and a
raw detach transaction that calls the function in the middle keeps its sum
(third pass found the loss, the sixth replaced the zero-and-restore with the
difference). The two-argument overload is
**dropped first** (a `DEFAULT` on the third parameter beside it makes every
two-argument call "not unique"); two-argument callers — `db/test-live.ts`
[6g], the vendored servers' `rpc` calls — resolve through the default, which
is the old behaviour plus the refusal. And `record_citation(uuid, uuid, text,
text)` is the one writer, because a citation write locks the source `KEY
SHARE` and every writer of a contended row on this fork has taken the
supersession advisory lock *first* since changes 63 and 68: the function takes
it, then locks both thoughts `KEY SHARE` in its prechecks — so a source deleted
in flight is waited out and answers `SOURCE_NOT_FOUND` as a value rather than
the validate trigger's `check_violation` an instant later ([6i] arm 5) — then
the `INSERT`'s validate trigger re-locks the source. Refusals as values:
`NOT_FOUND`, `SOURCE_NOT_FOUND`, `SELF_CITATION`, `BAD_STANCE`, `EMPTY_TEXT`.
**No MCP tool calls it yet** — the write side of citations belongs to the
epic's event shape (SMD-1730) and grounding rule (SMD-1733); this change is
the guard, and the writer the guard is tested through.

**The check is not a precheck, and the race is measured.** The guard fires
inside the `DELETE`, so a citation committed between a look and the delete is
seen; the validate trigger's `FOR KEY SHARE` on the source is the lock a
foreign key would take, so a delete of that row waits for the citation's
transaction and then, under READ COMMITTED with an `AFTER` trigger running
after the statement's own waits, sees it. `db/test-live.ts` [6i] runs it three
ways against a real server, five after the first pass: a raw `INSERT` holding
`KEY SHARE` (the delete waits, then is refused, nothing dangles), and a sixth
after the sixth pass — a raw delete of the citing note while the source's
detaching delete runs, which completes with nothing to detach where the
fifth pass's lock order deadlocked;
`record_citation` in a transaction that goes on to write `supersedes` (the lock
is re-entrant, no cycle, refused after the commit); the residue stated in 042's
header — a raw writer whose transaction takes the advisory lock *after* the
row, through `update_thought`, against the waiting delete — which deadlocks,
deterministically, and Postgres breaks it with nothing dangling either way (that
arm is what `record_citation`'s order exists to avoid, and a raw `UPDATE` of a
facet's `valid_until` or `superseded_by` — the only way to expire or supersede
a citation until the write side lands a writer for it, SMD-1733 — is the same
residue in the same shape, stated in the header; fourth pass); a citation revived
under an open transaction while its source is deleted (the delete waits on the
row and reads the revived version: refused); and a raw delete of the source in
flight while `record_citation` runs (it waits on the row and answers
`SOURCE_NOT_FOUND` as a value).

**On the portable server.** `MutationError` gains `CITED`; `deleteThought`
takes `detach`, both stores send the third argument explicitly (`p_detach`
named, so PostgREST resolves the one function), and `normaliseMutation` carries
`citedBy`, `citations`, `detached` and `inactive`. The tool gains
`detach_citations` (default false); a refusal reads "Refused: 13 citations on
other thoughts rest on <id> as their source — deleting it would leave those
statements resting on nothing:", lists the ten sampled `thought_id (stance):
text` lines, "…and 3 more", then the way through; a success says how many were
detached and records the deleted id, or how many expired or superseded rows
were marked. The guard runs as the calling role, so `ROLE_GRANTS.capture` gains
`thought_facets` `SELECT, UPDATE` (`since: "042"`) — a self-hosted server role
without them cannot delete *any* thought — and preflight's `write privileges`
names it with its `GRANT`; the README's grants table carries the row (check 7's
README rule holds the two together). Preflight also gains a **`delete
signature`** check beside `edit signature` (first review pass): both stores now
send three arguments, so a server deployed ahead of the migration would have
started green and failed every delete at the first user call with "function
does not exist", and a hand re-apply of 009 or 036 over 042 would put the
two-argument form back beside it and make every two-argument caller "not
unique" — the check names each state with its remedy, as 032's does for
`update_thought`; over PostgREST, where the catalog is out of reach, the same
check probes `delete_thought` with an id no row has, as the edit check does,
since the hosted brain is the one that deploys a server ahead of a migration
(third pass) — and a `permission denied` from that probe is a failure naming
the `GRANT`, not a skip, since the guard reads `thought_facets` as the caller
on every delete and the probe itself just met the missing privilege; the
direct path's `write privileges` says separately what a missing facet
privilege breaks — every delete — rather than the capture path, so an operator
whose capture succeeds is not told the check was wrong (seventh pass). And a
citation's text in a refusal goes through the same
`cleanForDisplay` every other thought-derived text in a reply does — the first
draft had re-implemented the one-line snip without it, the only place a
thought's text would have reached a terminal with its control characters
(first review pass; `snipText` is now the one spelling, and the proposals
tool's snip calls it). The refusal's count is coerced with `Number()` and a
`CITED` body carrying neither count nor rows — one the function did not write
— is said to be that rather than "0 citations", and the tool types the rows
with the store's `Citation` (second pass); the count is a number or a string
of digits and nothing else, since `Number()` alone took `true` and `[5]` for
counts (seventh pass); and the delete-only refusal fields live on
`DeleteResult`'s own failure arm rather than the shared `MutationResult`, so
`UpdateResult` advertises nothing `update_thought` never returns — one
`MutationEnvelope` is what the normaliser reads and both result types narrow
(seventh pass). The hosted remedy for the search
signatures names 042 as the last file to apply through, so an operator who
follows it is not sent back for `delete signature` on the next start (fifth
pass).

**Held by:** `db/test-schema.ts` [41] on PGlite — the shape (two triggers, the
guard per statement over `deleted`, one three-argument `delete_thought`, the
one `EXCEPTION` clause naming the one SQLSTATE, the lock before the block the
`DELETE` runs in and the refusal read from the error, the writer's order, the
`KEY SHARE`, both partial indexes),
refuse / detach /
history marked / thirteen counted and ten sampled / note and source together
clean while a third citer refuses it / two sources in one raw detach statement
totalling 2 / a raw `DELETE` meeting the table's refusal / an unknown mode /
five raw-insert shapes / a real FK failure propagating / 042 re-applied twice /
a whole-table reset clean — and [36] re-pointed at 042's body for 036's lock
assertions; `server-portable/test-update-delete.ts` [10] through the tool over
real Postgres, the FK-fault fixture included; `db/test-live.ts` [6i], the five
race arms above; `test-upgrade` [7]'s window guard and note moved to eleven;
`test-preflight` [5]'s capture-role walk names the facet `UPDATE` and its
signature walk re-applies 036 over 042 and drops 042's form for the `delete
signature` check; `server-portable/test-store-postgrest.ts` [12] drives
`deleteThought` through the SQL shim — `p_detach` named and bound, the `CITED`
envelope normalised, a two-argument named `rpc` still resolving. Ten
mutants, each reverting one mechanism, each failing the suite named for it:
the lock dropped from `delete_thought` ([36], [41], and [6g]'s forty-race
deadlock — 13 of 40), the guard raising `foreign_key_violation` ([41]'s
refusal becomes a fault; [10]), the `KEY SHARE` dropped ([6i] arm 1: the
delete no longer waits), history counted as active, a self-citation allowed,
the writer's lock dropped ([6i] arm 2 deadlocks), the guard's default flipped
to detach, `WHEN OTHERS` (the FK fixture answers `CITED`), the store dropping
`cited_by`, the tool never passing `detach`. An eleventh — the same-statement
exclusion dropped — passed every check and is the clause removed above. The
four review passes added seventeen more, one per fix, each biting. From the
first and second: the mode never put back, the unlocked count-then-detach
guard ([6i] arm 4, twice: once as the first draft's shape, once as a read
without the row lock), the unlocked source precheck ([6i] arm 5), a superseder
already gone still superseding, the citation text skipping the cleaner,
preflight treating every `delete_thought` form as current, the id stored as
written, a live source detached by a raw `UPDATE`, a non-timestamp accepted as
the deletion time, a `source_deleted_id` the row never had, the store's
`typeof` guard on the count. From the third: a detached citation re-pointed,
the superseder index dropped, the totals not put back, the isolation check
treating every level as read committed. From the fourth: a detached row
refused on `INSERT`; and one toothless by design — the guard rewriting by
predicate rather than by the ids it locked, which coincide by construction.
From the fifth: the refusal's `DETAIL` dropped — which first crashed the
function on an empty string as JSON, so the parse is defensive and an `OB001`
without the guard's JSON answers a count of nothing — a detached citation
refused its own restored source, the deleted id stored as written, the citing
thought's clock not moved. From the sixth: the citing thoughts locked after
the facets ([6i] arm 6 deadlocks), a live citation accepting deletion keys, a
detached row inserted whole refused its restored source, the store throwing
on a null citation element. From the seventh: the clock moved for an expired
citation's mark, `true` taken for a count, the facet privilege's failure
worded as the capture path's.

**Considered and kept as is.** The third review pass argued the source pointer
should be typed columns — `source_id uuid`, `source_deleted_id uuid`,
`source_deleted_at timestamptz` — since the upper-case id, the forged detach
and the non-timestamp findings of passes 1–2 are what jsonb keys cost that
types give for free. They are; but `thought_facets` is a sidecar of *kinds*,
each with its own payload, and a column trio for one kind on a table whose
next kinds (a procedure's trigger predicate, a validity window) carry other
pointers puts the per-kind shape back into DDL, which is what the payload and
the one validate function exist to avoid. The validate trigger is the one
place a kind's shape is checked, and every defect found there is now held by
a test. Revisit when a second kind carrying a thought pointer lands; if it
needs the same block, that is the moment for a shared column.

**Not built, and why.** The proposal's vocabulary registry, corrections table,
coverage and yield views (each a later ticket if the facet earns its keep);
`thought_edges` (declined in change 46, and check 7 knows upstream's shape as a
clobber pattern); a read that labels a citation's expiry or a deleted source
(SMD-1725's `as_of` read is where labels on facets belong); any writer over
MCP. Three vendored servers delete with a raw `.delete()` on `thoughts` at four
sites — `integrations/rest-api`'s dedup merge (after it has rewritten the
survivor and logged the merge) and its delete route,
`integrations/delete-thought-mcp`, `integrations/open-brain-rest` — and now
meet the guard as a bare `OB001` with no detach path, the way every
raw writer met 008's rule; routing them through `delete_thought` is
**SMD-1793**, filed from the first review pass in the shape of changes 69 and
71. `--reapply` (change 56) re-runs 009 and 036 in their turn, each re-creating
the two-argument form, and 042 drops it again in its.

**Upstream status:** not applicable — the fork's schema; upstream has no
citation or facet concept.
