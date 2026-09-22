# 52. The PostgREST store maps every row it returns — one `isoTimestamp`, one normaliser per row shape, shared with the SQL store (SMD-1040)

`server-portable/store-postgrest.ts`'s `matchThoughts` returned
`(data ?? []) as ThoughtMatch[]`: the client's own row under a type that says
`created_at: string` in ISO form. The SQL store has always mapped the same row
through `new Date(...).toISOString()`; so had this store's two younger methods,
`keywordThoughts` (after a review caught a locale-formatted date on it) and
`hybridThoughts` (mapped from the day it arrived, change 32). The oldest method
was never revisited. The SMD-958 review named it (finding T12) and it was
ticketed rather than fixed, because by then nothing in the product read it:
`search` and `search_thoughts` go through `hybridThoughts`, and the only
remaining caller, `preflight.ts`'s 014 and 020 probes, reads row counts. That
is also why no test noticed: `test-store-postgrest` [3] asserted count, content
and similarity on a `matchThoughts` row, and the format assertion lived in [3b]
and [3c], on the two methods already fixed.

Measured before fixing, over `compat/supabase-sql` — the fixture the suite
uses, which is real SQL through Bun's driver — the row's `created_at` was a
`Date` object, not a string at all; `JSON.stringify` hid it (a Date serialises
to ISO), and a template string showed
`Mon Sep 14 2026 11:27:09 GMT-0500 (Central Daylight Time)`. Over PostgREST
itself the same column is a JSON string in Postgres's own form,
`2026-09-14T16:27:09.123456+00:00` — a string, but not the one the SQL store
returns for the same row. Both are the class of difference that survives every
test asserting presence.

**The first commit was the ticket's shape** — one `normaliseMatchRow` in
`store.ts` beside `normaliseHybridRow`, both stores calling it — and left the
keyword mappers as two inline copies because "they agree today and both suites
assert their format". **A review pass (high effort, triaged) found that fix
narrower than its own mechanism, and one input it broke on.** Fixed here:

- `matchThoughts` was not the last bare cast. `getThought`, `listThoughts` and
  `pageThoughtMeta` on the PostgREST store were casts of the same kind, and
  `getThought` is the one the `fetch` tool prints verbatim — so the
  store-dependent wire format the ticket says it closes was still open on the
  one read path a user sees, while the fix had landed on the method only
  preflight counts. Now `normaliseThoughtRecord`, `normaliseListItem` and
  `normaliseThoughtMeta`, in `store.ts`, called by both stores; the SQL store's
  inline copies of each are gone.
- The keyword mappers are folded too (`normaliseKeywordRow`). The reviewer's
  argument was exact: "they agree today and both suites assert their format"
  is verbatim the state T12 found `matchThoughts` in, and the PR was already
  editing both files at the method above.
- `toISOString` throws on an infinite timestamp, which the column allows and
  migration 020 ranks by design (`test-schema` plants both infinities). The
  bare cast passed such a row through; the new normaliser would have aborted
  the whole result array on it, and both preflight probes would have degraded
  to `skip`. One `isoTimestamp` now formats every timestamp the stores return:
  a finite one as `toISOString`, an infinite one in Postgres's own spelling on
  either client (Bun hands back the number `±Infinity`, PostgREST the string).
  `test-store-postgrest` [3d] plants a row dated `infinity` and reads it back
  through `matchThoughts`, `getThought`, `listThoughts` and `pageThoughtMeta`.
- The first commit's `typeof score === "number"` assertion could not fail:
  `typeof NaN` is `"number"`, so a dropped or renamed column under `Number()`
  passes it. `Number.isFinite` now, there and on the pre-existing [3c] line.
- No suite can produce PostgREST's `+00:00` string — the fixture hands the store
  a Date — so [3] feeds `isoTimestamp` that string, the space-separated form,
  a Date, and both spellings of both infinities, and asserts the output.
- The ISO regex was spelled three times in one suite while the other asserted
  `endsWith("Z")`, a weaker rule; the two suites held different contracts on
  the shared normaliser's output. `db/test-support.ts` exports `ISO_RE`
  (`toISOString`'s exact shape, three fraction digits) and both use it. The
  first commit's prose that the PostgREST suite "now asserts what
  `test-store-sql` [3] always has" was wrong on both counts and is gone.
- The history above was told four times — a docblock, a call-site comment, a
  test comment and this section. It is told here; the code says the mechanism
  (`isoTimestamp`'s docblock names the two clients' shapes and points here).

**A second pass (high effort, triaged) found the first pass's rules meeting
each other, and two more casts.** Fixed:

- The pass-1 normaliser made a NEW divergence on the field this ticket
  unifies. A NULL `created_at` is legal (001 has no `NOT NULL`; 020 and 023
  name the state), sorts first under `ORDER BY created_at DESC`, and the
  PostgREST store's stats walk takes the first row of the first page as the
  newest thought — so `isoTimestamp(null)`'s epoch was reported as the
  corpus's newest date, `<real> → 1/1/1970`, where before the bare cast
  passed JSON null through and the tool omitted the range, and where the SQL
  store's 024 `min`/`max` ignore NULLs. `ThoughtMeta.created_at` is
  `string | null` — the one place in the interface, since only the walk reads
  it — and the walk skips undated rows when picking the range.
  `test-store-postgrest` [8] plants one and checks the range against SQL's
  `min`/`max`.
- `isoTimestamp` threw on anything Date could not parse, from inside `.map()`
  over every row of four read methods that used to be casts — so one row with
  a BC date or a year past ±275760 (Postgres accepts to 294276) would have
  failed `list_thoughts`, `fetch`, the stats walk and both preflight probes
  outright. The rule is now the one the infinities already had: a value with
  no ISO form keeps Postgres's own text, one odd row stays one odd row.
  `undefined` still throws — the column is missing from the row, a SELECT
  bug. [3] feeds it a BC date and `undefined`.
- `normaliseMutation` still formatted `updated_at` and `current_updated_at`
  with `String()`, two hundred lines under a docblock saying nothing else may
  format a timestamp — so `update_thought` printed `+00:00` where `fetch` now
  prints ISO for the same column. Both take `isoTimestampOrNull`; passing the
  ISO value back as `if_unchanged_since` is safe because 021 compares at
  millisecond precision on both sides. `revokedAt` too.
- The PostgREST `getThought` had no `UUID_RE` guard: a malformed id was a raw
  Postgres cast error on one store and `null` on the other, through `fetch`.
  `UUID_RE` moves to `store.ts` (both stores had their own copy) and the guard
  mirrors the SQL store's.
- `traceProvenance` and `findDerivatives` were byte-identical inline mappers
  in both stores, one row shape short of the mechanism — pass 1 edited their
  `created_at` line in all four copies without noticing. `normaliseDerivative`
  and `normaliseProvenanceNode` join the others.
- The normalisers re-spelled the id/content/metadata/created_at quartet five
  times; they compose `normaliseListItem` now, so SMD-1328's decision is one
  edit. The nullable rule was spelled twice with two different null tests
  (`t ?` and `== null`); `isoTimestampOrNull` is the one spelling.
- The one `typeof score === "number"` pass 1 missed (the recency-weighted
  line of [3c]) is `Number.isFinite`; [3d] plants its row through
  `test-support`'s `plantLegacyRow` rather than a third copy of the INSERT
  (the helper's `createdAt` accepts `null` for [8]); the `ISO_RE` block had
  landed between `createAssert`'s JSDoc and `createAssert`.

Ticketed, folded into SMD-1328: what the tools PRINT for a timestamp with no
ISO form. `isoTimestamp`'s sentinels are text a Date cannot parse, and five
readers (`Captured:` twice, the list prefix, the fetch/search title, the
stats range) do `new Date(x).toLocaleDateString()`, which prints
"Invalid Date" — on the SQL store that replaces a hard error with silently
wrong text on a row only raw SQL can create. NULL → epoch and sentinel →
"Invalid Date" are one decision, null under a widened type or a display
helper at five sites, and it is that ticket's. Declined in pass 1 and still: a
per-method conformance sweep over the whole `ThoughtStore` interface — with
every read method on a `store.ts` normaliser and [3d] reading each back, it
would re-assert what [3d] asserts.

**A third pass (high effort, triaged) — the second consecutive stop signal:
its top findings were pass 2's own rules meeting each other, so the loop ends
here.** Fixed:

- `isoTimestampOrNull` tested `== null`, so `undefined` — a column missing
  from the row, which `isoTimestamp` throws on by rule — became `null` for
  every nullable column: a dropped `updated_at` in a SELECT, or 024 renaming
  `last_ts`, would have printed a null edit time or an empty stats range with
  every suite green. It tests `=== null` now; `normaliseMutation`'s pre-018
  envelope, the one place absence is legitimate, says so explicitly.
- Pass 2 wrapped the SQL suite's page-walk comparisons in `String()` to
  satisfy the widened type, which made them vacuous (`"null"` sorts above
  every digit). [5] asserts every page row's `created_at` is non-null ISO.
- [3d] asserted the infinity row by position (`list[0]`, `page[0]`), which a
  NULL — sorting above +infinity under DESC — would displace; by id and by
  value now. Its plant-to-delete span is a `try/finally`, so a thrown store
  call cannot leak the row into the next run. [8]'s oracle was a second
  formatter (`new Date(x).toISOString()`, which throws on the infinity and
  fabricates on an empty range); it is `isoTimestampOrNull`.
- Deleting the two local `UUID_RE`s left each file's JSDoc for it sitting
  above the class declaration; gone, the useful sentence moved onto the
  export. `normaliseProvenanceNode` renamed a key, ran the derivative
  normaliser, destructured the id back out and spread the rest AFTER its
  explicit fields, an overwrite direction TypeScript would not flag; a shared
  `derivationFields` is spread first in both. The stats walk's null-skip loop
  folds into the tally loop it duplicated.

Corrected, not fixed: `isoTimestamp`'s docblock said a value with no ISO form
comes out "the same on both clients". It does not. Verified live by the
reviewer: for a BC date or a year past ±275760, Bun's driver hands the SQL
store `Date(NaN)` (or, on a parameterised query, an extended-year Date whose
`toISOString` fails `ISO_RE`) before the store sees it, so the SQL store
returns JS's "Invalid Date" where PostgREST's text survives. The docblock
says so and names the remedy (`created_at::text` beside the column). Folded
into SMD-1328 with two more facts the reviewer surfaced: this PR changed
the default store's answer for an undated row from JSON null to the epoch
string — parity with the SQL store's long-standing behaviour, but a visible
change (`fetch`'s `metadata.created_at`, the search citation title) that
had gone unannounced; and no test pins what the tools print for a sentinel,
so the eventual fix has nothing to flip. Ticketed: SMD-1336 — the PostgREST
store's client-side stats walk mimics 024 rule by rule (this ticket added
the NULL-skip), but `thought_stats_summary()` is a plain zero-arg jsonb
function it could call over `rpc`, with the walk kept only as the pre-024
fallback; 024's "PostgREST cannot aggregate server-side" premise looks
false. Declined: pinning "Invalid Date" in `test-server` as expected output
(pinning a bug), and widening `ThoughtListItem.created_at` here (SMD-1328's
decision, five reader sites).

**A fourth pass, at the user's call.** Its top three findings were the three
already ticketed (SMD-1328 twice, SMD-1336) — the loop had ended — and the
rest were tidy-ups worth taking in files the PR was already in:

- The stats page walk ordered by `created_at DESC` alone across up to 100
  separate `range()` requests. `created_at` is transaction-fixed, so a
  multi-row INSERT gives thousands of equal values, and a walk over an
  unstable order can count a tied row twice or never. Both stores' page
  queries break ties on `id` (pre-existing; the PR had rewritten the block
  around it).
- `isoTimestampOpt` for the keys an envelope may omit (`updated_at` before
  018, `revoked_at` when not revoked) — the one place `== null` is the right
  test, spelled once instead of three times. The SQL store's `statsSummary`
  had optional keys and an empty-object fallback that `isoTimestampOrNull`
  would now throw on; 024 guarantees every key, so the tolerance is gone
  rather than left to mislead.
- `db/reembed.ts` kept its own copy of the uuid regex for `--accept-failed`;
  it imports the stores' `UUID_RE` now, so the CLI refuses exactly the ids
  the stores answer null for. The PostgREST file header still said the store
  was "unchanged in substance"; it names the mapping layer. [3d]'s `finally`
  comment claimed to protect the next run, which `resetSchema` already does;
  it protects later sections of this run, and [8] has the same contract.

Ticketed: SMD-1338 — the malformed-id rule is enforced per store read method
while `update_thought` and `delete_thought` take a bare `z.string()` and hand
it to Postgres; validate once at the tool boundary.

A boyscout commit took what `--noUnusedLocals` finds in the touched files: an
unused `MutationError` type import in each store, two path imports in the
PostgREST suite for a migrations directory it no longer computes, and the SQL
suite's hand-rolled template substitution (`HERE`, `MIGRATIONS`, `subst()`
and its docblock), superseded by `resetSchema` and never read.

Verified: `test-store-postgrest` 77/77 (60 before this ticket; the first
commit's format assertion, run against `main`'s store, reported
`got object Mon Sep 14 2026 11:27:09 GMT-0500 (Central Daylight Time)` and
failed the suite 59/60), `test-store-sql` 83/83, `test-update-delete` and
`test-agents` unchanged, `test-server` 71/71, `tsc` clean. Upstream status:
**not applicable** — `server-portable/` and its two stores are the fork's
(change 11).
