# 58. Vendored SQL stops replacing what the migrations own — four files cut where they redefined `upsert_thought`, `trace_provenance` and `release_thought`, preflight names a replaced body, and check 7 holds the line (SMD-1250)

**The problem.** The community tree is vendored verbatim, and three of its
files carried `CREATE OR REPLACE FUNCTION public.upsert_thought(p_content
TEXT, p_payload JSONB DEFAULT '{}')` while presenting themselves as additive
sidecars: `schemas/enhanced-thoughts/schema.sql` and two drafts under
`docs/drafts/`. Against upstream's brain that was roughly true — upstream's
`upsert_thought` is the guide's. Against a brain built by `db/migrate.ts` it is
a replacement: `CREATE OR REPLACE` on a matching signature puts the new body
where 005's was, with no error, and a payload that is not a JSON object — the
double-encoding trap 005 closed — is emptied silently again for every caller of
the 2-argument form (PostgREST callers by name, the two-step fallback; the SQL
store calls the 3-argument form and was not touched by these three). Nothing
would have said so: preflight's body checks read sentinels, and 005's body
predates the convention.

**The scan found worse.** Check 7 run over the tree as vendored, before any
fix, lists 35 statements in 16 files under the rule as shipped: 24 violations
in 8 sidecar files, and 11 statements in the 8 bootstrap files the exceptions
cover (23 and 11 under its first draft, before `COMMENT ON FUNCTION` joined
it). Beyond the ticket's three:
`schemas/provenance-chains/schema.sql` defines `trace_provenance(uuid, int,
int)` and `find_derivatives(uuid, int)` — the argument lists 025 and 026 use.
Run against a migrated brain (the fourth review pass did), both `CREATE OR
REPLACE`s fail on the return type — upstream's `RETURNS TABLE` differs — and
the SQL editor rolls the paste back; statement by statement, what lands
silently is its `COMMENT ON COLUMN thoughts.derived_from` and `supersedes`
over 025's contract comments and a second copy of 025's array `CHECK`; after
the `DROP FUNCTION`s its own README's rollback runs, the two bodies install —
upstream's per-path recursive walk over 026's bounded one, the twenty-second
timeout change 47 removed — and the migrator's `--reapply` then fails on the
same return type until both are dropped again. `schemas/thought-work-claims/schema.sql`
defines `release_thought` and `release_claims_for_worker` under 015's exact
signatures and replaces both bodies with no error (run: every worker release
then fails 015's CHECK, since upstream's leaves the lease set, and a clean
shutdown deletes the worker's rows instead of returning them to the pool),
adds a `claim_thoughts` overload beside 015's (an id list in, where 015's
takes a pool name), and re-comments 015's table and columns and 028's
`release_thought`. And
`recipes/edge-function-cost-optimization/migrations/20260417_edge_fn_optimizations.sql`
— "additive (no schema changes)" by its README — defines `thought_stats_summary()`
over 024's (run: `thought_stats` then raises `field name must not be null`
on the first thought whose topics hold a null element, which 024's body
drops) and `upsert_thought(text, jsonb, vector)`, the 3-argument capture
every write on the SQL path runs, with a body from 2026-04 that has none of
005's guard, 008's actor, 021's label, 022's window rule or 025's provenance
envelope: one paste, and every capture after it wrote a row missing all five.
The remaining hits were files that create a brain rather than add to one — the
getting-started guide, a recipe's Neon SQL, a Kubernetes init script and the
ConfigMap carrying it, a local-Postgres recipe's two init scripts, and the
fingerprint recipe's README, which is where 003's statement came from.

**The posture, decided.** The ticket offered three: fence the files, refuse at
the database, delete them. Taken under the standard change 51 wrote down —
audit once, hold the delta, a standing check carries it — with one rule per
kind of file. A **sidecar**, a file that adds to an existing brain, has its
redefining statements **cut** and a header naming the migration that owns each
function and why the cut is safe: enhanced-thoughts loses its section 6 (its
README never mentioned the upsert; the columns are filled by the file's own
backfill, and a capture does not update them — the README says so now);
provenance-chains loses sections 5 and 6, its two comments on 025's columns
and its copy of 025's array `CHECK` under another name (the metadata-merge
helpers, which have no counterpart in the migrations, stay; the README's
example calls run against 025's and 026's functions, and the README now says
what those return and do not do — the fork's columns, no tier redaction,
`SECURITY INVOKER` — where upstream's text promised redaction; its rollback no
longer drops the two functions, 025's two columns or 025's two indexes); the
cost-optimization
migration loses both functions and now says why, with the recipe's Edge Function
steps standing and its step 1 rewritten; and thought-work-claims, every
statement of which targets 015's table, becomes a stub — its README carries the
reason at the top and its rollback, which would have dropped 015's table with
the three workers' state in it, is replaced by that reason. The two
`docs/drafts/` SQL files are **deleted**: upstream's scratch space, nothing here
depends on them, and the one recipe README that linked the base draft as "the
canonical thoughts schema this recipe mirrors" points at `db/migrations/`
instead. A file that **creates a brain** is **excepted**, per file and function
and counted, with the reason beside it in the checker: the guide (SETUP.md
already sends this fork's readers past it), the Neon, Kubernetes and
local-Postgres bootstraps, and the fingerprint recipe's README, which gains a
note above its Step 2 saying what pasting it onto a migrated brain would do.

**Check 7.** `scripts/check-fork-consistency.mjs` reads the owned set from
`db/migrations/` — every `CREATE [OR REPLACE] FUNCTION` at the start of a line,
dollar-quoted bodies and then comments stripped first, with the file that last
defines it: 36 names today, never typed, through `ownedFunctionsIn` in
`db/config.mjs`, and `test-schema` reads the same set and holds it to 36 or
more (a smaller set is a reader that lost definitions, not a migration gone) —
and fails any `CREATE`, `DROP` or `ALTER` of a `FUNCTION`, `PROCEDURE` or
`ROUTINE`, or a `COMMENT ON` one, naming an owned function at the start of a
line, bare or schema-qualified, quoted or not (the quoting a Supabase dashboard
export emits), the name on the line after the keyword allowed, in every
non-binary, non-ignored file under the seven category directories whole —
their root READMEs and `_template`s included, which the per-contribution walk
the other checks use skips — and `docs/`. A second owned set, read the same
way, is the `thoughts` columns whose `COMMENT` a migration writes (three: 021's
`embedding_model`, 025's `derived_from` and `supersedes`), and a vendored
`COMMENT ON COLUMN` of one fails too — the one statement upstream's
provenance-chains file did land silently. The rules are two regexes,
`coreFunctionStatement` and `coreColumnCommentStatement` in `db/config.mjs`,
multiline and tested against a whole text, and `test-schema` [31] applies
both to the fixed enhanced-thoughts file. By name, not signature: a
matching signature is the silent replacement, and an overload beside an owned
function is the ambiguity 004's header names. `COMMENT` because 028 and 031
carry a data contract in a function's comment, which a vendored `COMMENT ON`
overwrites as silently as `CREATE OR REPLACE` overwrites the body. Fifteen
strings the function rule must catch and thirteen it must not — a `GRANT`, a
`REVOKE`, a `COMMENT ON COLUMN` of an unowned column, a `SELECT`, a header
comment quoting a statement, `update_updated_at_column()`,
`match_thoughts_recency(`, `upsert_thought_v2(` — and two the column rule
must catch and three it must not, run through the scan's own machinery on
every invocation, and exceptions are
counted as check 6's are. Proven: a probe file with a definition, a drop and a
comment failed on three lines; one line appended beside the excepted statement
in the fingerprint README failed as "covers 1 line(s) but 2 match"; the fourth
pass's probes — mixed case, a `.sql.example`, the deleted draft re-added, a
README fence, CRLF, a BOM, the name on the next line — each failed; the fixed
tree passes, 118 contributions, no violations. Known and accepted: a `DROP
FUNCTION a(), b()` list and dynamic SQL (`EXECUTE 'CREATE …'` in a DO block)
are not caught — no vendored file writes either.

**Preflight names the body, and the migration that owns it.** `atomic capture`
read the 3-argument body's sentinel and nothing else; two of its remedies named
022 as the last definer of the 3-argument form, and 025 has been that since
change 46 — so the remedy itself would have put 022's body over 025's, dropping
the provenance envelope silently, the exact class this change is about. Now:
the 3-argument form missing is a refusal naming 025; a 3-argument body without
022's sentinel warns naming 004, 005, 008 or 021 re-applied without 025 after
them, or the cost-optimization recipe's overload, remedy 025; a body with 022's sentinel but without 025's envelope
(022 re-applied by hand — a state preflight passed as shipped before) warns
naming 025; a 2-argument body without 005's guard (the guide, the fingerprint
recipe's Step 2, or a schema that mirrors columns on write, pasted onto a
migrated brain) warns naming 005 and then 025 again, since 005's file
redefines the 3-argument form too; and the ok says both bodies are the shipped
ones. `provenance` reads `trace_provenance`'s body for 026's
`ob1:provenance-walk-bounded` and warns, naming 026, when it is gone — 025
re-applied by hand or the vendored provenance-chains schema. The two
recognisers, `UPSERT_TWO_ARG_SHIPPED_RE` and `UPSERT_THREE_ARG_SHIPPED_RE`, live
in `db/config.mjs`: each is the one clause that migration added and no earlier
body has (005's `jsonb_typeof(p_payload) <> 'object'`, 025's
`p_payload->'derived_from'`), where the migrations have no sentinel and cannot
gain one (a hashed file). The two forms are picked by signature, not arity —
a vendored bootstrap's `upsert_thought(text, vector, jsonb)` is a third
3-argument form, and reading whichever the catalog returned first judged a
healthy brain by the wrong body — with the signature built from `pg_type`'s
names rather than `regprocedure`'s text, which schema-qualifies `vector` when
pgvector is off the search path (the shape change 43's check already fails)
and would have called a present form missing; any other overload is named in
the detail. The 2-argument verdict rides every 3-argument state, the refusal
included. `test-search-path` [4] holds the signature pick to the off-path
shape — the refusal it would otherwise have raised there is what the second
review pass found. The 2-argument body is judged on its own and said beside
whichever 3-argument state fires, with 005-then-025 as the remedy, so a brain
with both replaced hears it once rather than on the run after the first
remedy. Two more bodies the fourth pass replaced on a real brain gained a
recogniser and a check: `stats summary` warns when `thought_stats_summary`'s
body lacks 024's type guard on the topics array (the recipe's body raises on a
null element), and a new `work claims` check fails when `release_thought`'s or
`release_claims_for_worker`'s body does not clear the lease as 015's CHECK
requires (upstream's thought-work-claims paste; every worker release would
fail), names any overload of the four claim names no migration defines with
its `DROP`, and skips before 015. The `provenance` remedies are ledger-aware
now and say to `DROP` both functions first when the body present returns
other columns, since the migrator's re-run otherwise fails on the return type
— the fourth pass ran that remedy and watched it fail. The re-run remedy
every ledger-aware check shares no longer blames `--baseline` alone: its
parenthetical names a body put there or removed from outside the migrations.
Over PostgREST none of this is reachable, and the skip says so as before.

**Proof.** `test-schema` [31] reads the owned set as the checker does and pins
the three last definers preflight's remedies spell (`upsert_thought` 025,
`trace_provenance` 026, `release_thought` 015 — when one moves, so must the
remedy), holds both recognisers against the shipped bodies, then applies the
fixed `schemas/enhanced-thoughts/schema.sql` whole to the migrated brain
(Supabase's roles created first, since its `GRANT`s name them) and asserts every
owned body and overload is byte for byte as the migrations left them while the
file's own columns and functions arrive and a double-encoded payload is still
refused; then what upstream's file did — 003's body over 005's raises nothing,
changes exactly one owned body, and the double-encoded payload is emptied
silently again — and what the recogniser is for: 022 over 025 keeps the
sentinel and drops the envelope; then the last definers re-applied put every
body back. `test-preflight` drives each warning and its remedy against real
Postgres: 021 over 025, 022 over 025, 003 over 005, 003 and 021 together (one
warning naming both bodies, remedy 005 then 025), 005 alone (a pre-022
3-argument body with the 2-argument one right, which is why the remedy says
"then 025 again"), the form dropped (remedy 025, not 004, not 022), 025 over
026 for `provenance`; and, from the fourth pass, a stats body that is not 024's, a release body that is not 015's, a stray claim overload named with its `DROP`; 683 and 188 assertions. `check-fork-consistency` passes
the fixed tree and failed the probes above.

**Not done, and why.** Vendored `COMMENT ON COLUMN`, `DROP INDEX` and `ADD
CONSTRAINT` over 025's columns are a column-level owned set — cut here where
found (two comments, two index drops, one duplicate `CHECK`), with
provenance-chains keeping two `CHECK`s on the two columns 025 declined; check
5 covers an unguarded `ADD COLUMN`, and the rest waits for a ticket that reads
columns and indexes from the migrations as this one reads functions.
`thought_stats_summary` and
`release_thought` have no recogniser: nothing in 024's or 015's body is a
clause a vendored body would lack by construction, so check 7 is their guard
and SMD-1227's table of sentinels the way to more. The getting-started guide
keeps its three statements unfenced in the text — SETUP.md is the fork's
front door and says to read it instead — and preflight is the guard for a
reader who pastes it anyway.

Upstream status: **unfiled** — the three files disagree with each other there
too (the ticket's finding: `enhanced-thoughts` declares `importance SMALLINT
DEFAULT 3` and its own upsert writes a default of 50 clamped to 0–100), and
which body an upstream brain ends up with depends on the order the user pasted
recipes in. A note could be offered.
