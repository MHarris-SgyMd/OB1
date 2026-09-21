# 96. The two `created_at` mappers change 92 scoped out take the same rule — the provenance walk and `list_supersession_proposals` no longer fabricate the epoch on a NULL, and the proposal tool no longer *throws* on an `infinity`-dated thought (SMD-1803)

Change 92 (SMD-1328) settled the null / no-ISO-form decision on the
list/match/get read path and the five renderers, and in its **Declined** note
named the two mappers it left on the pre-fix `new Date(...)` convention:
`derivationFields` (025's `trace_provenance` / `find_derivatives`, feeding
`ProvenanceNode` and `Derivative`) and `normaliseProposal` (029's
`list_supersession_proposals`). Both are graph walks over captured thoughts, off
the path 92 scoped and reachable only by a hand-INSERT, so they were the
follow-up. This is it: they take 92's rule too.

**What changed.** Both mappers now read `created_at` through
`isoTimestampOrNull`, so it is `string | null` on `ProvenanceNode`, `Derivative`
and the proposal's `older` / `newer` — a NULL ancestor or proposal thought reads
back as `null`, not the fabricated epoch string. `normaliseProposal`'s local
`iso = (v) => new Date(v).toISOString()` is gone: `older.created_at` /
`newer.created_at` take `isoTimestampOrNull`, `judgedAt` (029's
`NOT NULL DEFAULT now()`) takes `isoTimestamp`, and `reviewedAt` (set only on
review) `isoTimestampOrNull`.

**The severe half.** That local `iso` had no `infinity` branch, so an `infinity`-
or BC-dated proposal thought made `new Date("infinity").toISOString()` throw
`RangeError: Invalid time value`, and `list_supersession_proposals` returned an
error for the **whole queue** rather than misrendering one row — worse than the
silent epoch fabrication 92 fixed. It now returns, keeping the sentinel as its
own text.

**Render and CLI.** The proposal `day()` in `index.ts` moves onto `displayDate`
(`[undated]` for a null date, `infinity` for the sentinel — never the
`12/31/1969` `toLocaleDateString` gave `new Date(null)`, nor "Invalid Date"). The
offline maintainer CLI `db/consolidate.ts`, which the tool's text points
operators at, carried the same two defects: its `day()` now goes through the
store's `isoTimestampOrNull` (a sentinel has no `T`, so it prints whole rather
than sliced to a stub), and the judge-prompt `dateOf` feed
(`server-portable/consolidate.ts`) renders a NULL as `an unknown date` instead of
feeding the model a fabricated `1970-01-01` — `infinity` was already inert there,
since `getTime()` is `NaN` and `String(d)` kept it.

**Teeth.** `test-thoughts` [9] asserts `buildJudgeMessages` renders a NULL date as
`an unknown date` (not the epoch) and an `infinity` one as its own text (not a
throw). `test-store-sql` [13] and `test-store-postgrest` [12] plant a NULL-dated
ancestor and derivative and an `infinity`/NULL-dated proposal pair, and assert
`traceProvenance` / `findDerivatives` map the NULL to `null` and
`listSupersessionProposals` **returns** rather than throwing, keeping `infinity`
and `null`. `test-e2e-sql` [12] drives the real tool over MCP: pre-fix the call
returned `isError` (the `RangeError`), post-fix it renders `older [infinity]` /
`newer [undated]` with no fabricated date reaching the client. `db/test-live` [16]
is the CLI's teeth — it runs `db/consolidate.ts --list` as a subprocess over a
planted `infinity`/NULL-dated proposal pair and asserts it exits 0 (pre-fix its
`day()` threw and `--list` crashed) rendering `[infinity]` / `[undated]`, no
`[1970-01-01]`.

**Upstream status:** these two mappers are fork-only — migrations 025
(provenance) and 029 (proposals) and their tools are fork additions, and
`server/index.ts` (the upstream edge) has no provenance or proposal code at all,
so there is no upstream mapper carrying this bug to fix or file. (server/'s own
`created_at` read/render path still carries the `new Date(...)` fabrication change
92 left there by design; that is 92's divergence, not this one's.) Not filed
upstream — these rows reach no capture path.
