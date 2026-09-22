# 92. A NULL `created_at` is `null`, not the fabricated epoch, and a timestamp with no ISO form renders as its own text — the decision SMD-1040 documented and left, made once in `isoTimestamp`/`displayDate` (SMD-1328)

`thoughts.created_at` is `timestamptz DEFAULT now()` with no `NOT NULL`
(migration 001); 020's `recency_score` has an explicit NULL branch and
`db/test-schema.ts` plants a no-date row and asserts `match_thoughts` returns
it. But every read mapper ran the column through `new Date(v).toISOString()`,
and `new Date(null)` is the epoch — so a NULL row came back as the fabricated
string `1970-01-01T00:00:00.000Z`, silently, on **both** stores, and the five
`toLocaleDateString` renderers printed **"Invalid Date"** for an `infinity` or a
BC date. No capture path can make such a row — every insert omits the column and
takes the DEFAULT — so it needs a direct INSERT; the risk is a fabricated date
shown as real, not a crash. Change 52 (SMD-1040) put the timestamp convention in
one place (`isoTimestamp`) and documented that NULL and the no-ISO-form values
were still open, under types that said `created_at: string`. This is that
decision.

**The decision.** A SQL NULL is `null` under `created_at: string | null` — the
widening `updated_at` and `ThoughtMeta.created_at` already carried, with
`updated_at?: string | null` on `ThoughtRecord` as the precedent — and the tools
render a null date as **absent**. `infinity` and `-infinity` stay their **own
string** on both stores (`isoTimestamp` keeps them, `infinity` is the value 020
ranks by and `[3d]` pins it), and the tools show that text, not "Invalid Date". A
BC or extended-year date has no ISO form either, but the stores split on it:
PostgREST's text survives and renders as itself, while Bun's SQL driver has
already turned it into `Date(NaN)` before the store is reached, so `isoTimestamp`
yields the literal string "Invalid Date" and `displayDate` faithfully prints
*that* — the declined case below, not a value this change makes legible. The rule
lives in two helpers: `isoTimestampOrNull` for the read path, `displayDate` (new,
in `thoughts.ts`) for the render path.

**Where it's applied.** One read-path change: `normaliseListItem` takes
`isoTimestampOrNull`, so the list item, the three match shapes and the record
that spread it all read a NULL as null — `match_thoughts`, `getThought` and
`listThoughts` no longer fabricate. Five renderers move onto `displayDate`:
`thoughtTitle` (the `search`/`fetch` title — a null date is the existing
`Open Brain` prefix, not `1/1/1970`); the two `Captured:` lines in
`search_thoughts`/`search_thoughts_keyword` (omitted when the date is absent);
the `list_thoughts` `[date]` prefix (`[undated]`, since the bracket is
structural); and the `thought_stats` range (024's `min`/`max` already skip NULLs,
so `displayDate` only keeps an `infinity` edge legible).

**Declined.** Recovering the SQL store's *text* for a BC/extended-year date —
Bun's driver hands the store `Date(NaN)` (or an extended-year `Date` that fails
`ISO_RE`) before it is seen, where PostgREST's text survives — would mean
`SELECT created_at::text` beside every column in `store-sql.ts`. That row reaches
no capture path, only a hand-written INSERT, and the two drivers disagree at the
wire; the one odd row is left as each client renders it rather than rewriting
every SELECT. Two mappers this ticket did **not** move stay on the pre-fix
convention. `derivationFields` (025's provenance/derivative walk) runs
`created_at` through `isoTimestamp`, which keeps `infinity` but fabricates the
epoch on a NULL ancestor. `normaliseProposal`'s local `iso` (029's
`list_supersession_proposals`, and the `day()` renderer beside it) calls
`new Date(v).toISOString()` directly, with no such guard — so, worse, an
`infinity`- or BC-dated proposal thought makes it **throw** and
`list_supersession_proposals` errors out entirely rather than misrendering.
The offline maintainer CLI `db/consolidate.ts` carries the same two defects (its
`day()` at :277 throws on infinity and fabricates on NULL; its judge-prompt
`dateOf` feed at :489–490 fabricates on NULL). All of these are graph walks over
captured thoughts, off the list/match/get path this ticket scoped and reachable
only by a hand-INSERT, so they are the follow-up **SMD-1803**, not this change.

**A parity note.** Before change 52 the PostgREST store passed a NULL
`created_at` through as JSON null, so `fetch` returned `created_at: null` while
the SQL store fabricated the epoch; change 52 made **both** return the epoch. This
change makes both return `null` — the honest value, and the one the PostgREST
store had before parity was chosen.

**Teeth.** `test-thoughts` [5]/[5b] cover `thoughtTitle` and `displayDate`
directly, including that a row *genuinely* dated at the epoch still renders
`1/1/1970` — the fix suppresses fabrication from NULL, not the value 0.
`test-store-sql` [11] and `test-store-postgrest`'s undated block plant a NULL row
and assert `null` on `matchThoughts`/`getThought`/`listThoughts`; `test-e2e-sql`
[11] drives the real tools over MCP and asserts the rendered `list_thoughts`
shows `[undated]`/`[infinity]` and `fetch` titles an undated thought `Open Brain
…`, with no `1970` and no `Invalid Date` in the output over those two rows.

**Upstream status:** divergence. `server/index.ts` and upstream's store carry the
same `new Date(...)` fabrication; the fork's fix lives in `server-portable`, and
this is not filed upstream (an undated row reaches no capture path).
