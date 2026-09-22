# 49. The caveat rule is stated at the table — `thought_work_claims.last_error` on a succeeded row, and `release_thought`'s `p_error`, carry a COMMENT (SMD-1052)

Change 34 gave `thought_work_claims.last_error` a second meaning: on a
**succeeded** row, when set, it is a **caveat** — the write stands, and this is
what the worker could not do (a long thought stored with its head window's vector
because the provider refused the whole content; since change 39, a failure the
operator accepted with `--accept-failed`). `db/reembed.ts` reads every such row
as one shape — `withCaveat()` for the list, `--retry-fallbacks` and the
end-of-run count, a `FILTER` of the same shape in `--status`'s `counts()` —
and its header and `db/README.md` state the rule. The **schema said nothing**:
015 commented `work_type`, `worker_id` and `attempt_count` and not this column,
and `release_thought`'s comment said only "Mark one claim succeeded or failed" —
nothing about `p_error`, which it stores whatever the status. A reader of the
table (`\d+`, a future consumer of the claim table) had no way to learn that any
note on a succeeded row is read as the caveat. `extract-entities.ts` under its
own key is not swept today — but only because it releases success with NULL:
`reembed.ts`'s readers are scoped to the key it is *run* with, and `--job`
accepts any key that names no model (a warning when it lacks the prefix; a key
naming another model or width is refused), so the day someone pointed `--job` at
another tool's bare key its noted rows would go back to the pool. Preflight's
re-embed pass check is scoped to the `reembed:` prefix instead. SMD-1311 would
make `--retry-fallbacks` refuse a key without the prefix.

**Migration 028** is the two statements, and nothing else: an idempotent
`COMMENT ON COLUMN thought_work_claims.last_error` carrying the **data contract**
— failed: why it failed; succeeded, when set: a caveat, the write stands; NULL is
a clean success; the rule as the column's (readers treat any note on a succeeded
row as the caveat, so a consumer stores nothing else there on success); and the
one consumer of succeeded rows that does *not* read the column, 021's evidence
backfill, which trusts a succeeded row whatever its caveat (the reason
`reembed.ts`'s baseline remedy says to `--retry-fallbacks` or `--retire` first).
Which readers, under which keys, what bounds an acceptance and when a caveat row
returns to the pool are the **tools'** contract and change with the tools, so the
comment points at `reembed.ts`'s header ("The head window, recorded", "Saying I
know") and `db/README.md` for them rather than restating them. And
`release_thought`'s `COMMENT ON FUNCTION` re-issued with 015's text kept whole
and one sentence added: `p_error` is stored in `last_error` whatever `p_status`
is, and what it means on success. No DDL on data, no body change, no ACL change,
no placeholder. The ticket named SMD-1043's redefinition as the ride; 1043 is
`upsert_thought`'s advisory lock and never touches the claim table, 023's
backfill landed without it, and nothing filed today redefines `release_thought`
(SMD-1023's lease renewal is the nearest, and it is about the claim), so the
comments travel alone — a docs-only migration is heavy for two statements, and
the alternative was the rule staying where a reader of the schema cannot see it.
Spellings the comment deliberately avoids: the acceptance prefix is named by its
constant (`ACCEPTED_CAVEAT_PREFIX`) rather than quoted, since an applied comment
cannot follow a rewording; no flag is spelled, since `test-schema` [10] strips
`--` to end of line before scanning the migrations and holds that no file puts
that sequence inside a string literal (SMD-1316 would make that strip
literal-aware); and code identifiers stop at two file names, two section titles
and that constant.

The trap a successor must not fall into: `CREATE OR REPLACE FUNCTION` keeps a
function's comment, but any migration that redefines `release_thought` and
re-issues 015's one-sentence `COMMENT` would silently drop the `p_error` sentence.
So `test-schema` [27] asserts the **live** text of both comments
(`col_description`, `obj_description`) after every file has applied — anchored
on the rule's words rather than clause order, no migration number pinned, so a
compliant successor passes and a lossy one fails whichever file it is; 015's
text is checked whole, not its middle clause; the no-`--` rule is asserted of
the live text — and the two facts the comments add, exercised: a succeeded
release with `p_error` stores it, one with NULL leaves the column NULL ([15]
already covers the failed release and the holder rule). Green at both widths;
`test-upgrade` green (the shape comparison of columns and signatures is
unaffected by a comment).

**Four review passes**, and the count is the lesson. The first (medium) found a
pinned migration number, a quoted prefix, dashes in a literal and a wrong ticket
named as the successor, each fixed — and its own fix narrowed the rule to "never
swept under its own key", a false reason. The second (medium) found nothing. The
third (high) caught that false reason, that "one predicate" overstated
`counts()`, that the acceptance bound and 021's backfill were missing, and that
the 015 check was partial — fixed — and filed SMD-1311, SMD-1312 (one exported
spelling of the caveat predicate) and SMD-1313 (a generic last-issued-COMMENT
test); but its own wording of the data rule ("an edited caveat row returns flag
or not") was wrong too: `doneButNotAtTarget()` returns a row only when its thought
is *not at the target*, and a head-window caveat re-captured through the server is
relabelled at the target and stays. The fourth (high) confirmed that, found the
replacement sentence wrong again in two smaller ways (the NULL-label case, a
"key's target" a backfill key lacks), and made the point that settled the shape:
reader behaviour is the tools' contract, it changes (SMD-1311 already would), and
a hashed literal cannot follow it. Three passes had each mis-stated a reader
detail in text `migrate.ts` forbids editing once applied. So the applied comment
now carries the data contract and a pointer, and the reader mechanics live where
they can be corrected. The fourth pass also found `ACCEPTED_CAVEAT_PREFIX`'s doc
comment still naming the `finished_at` bound SMD-1067's second pass replaced with
`claimed_at` (pre-existing; fixed, one line) and that the `--job` acceptance was
overstated (a key naming another model is refused). Not taken: `db/README.md`'s
"asserts 505 properties" is stale (565 now) and has been since SMD-944, a count
no PR maintains.

Upstream status: **not applicable** — the claim table is the fork's (015).
