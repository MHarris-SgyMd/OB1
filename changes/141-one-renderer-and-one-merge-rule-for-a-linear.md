# 141. One renderer and one merge rule for a Linear ticket, whichever tool writes it — the dump carries the issue, the pipeline honours the source's clock and, where that clock is silent, the brain's (SMD-1958)

**What changed.** The corpus builder asks Linear for the adapter's selection
(`ISSUE_FIELDS`, with `LABELS_BOUND` and `RELATIONS_BOUND`, moved from
`db/sync-linear.ts` to `db/ingest-linear.ts` — the adapter owns the shape it
maps, and the sync imports them) and writes each document with an `issue`
object and `fetchedAt`, the build instant, beside the fields the harnesses
read; `corpusIngested` is now `linearAdapter.map(d.issue)` under the dump's
scope `linear:corpus`, so the ingester's text, facets, canonical, links and
mentions for a ticket are the sync's, byte for byte. The contract
(`db/ingest-contract.ts`) gains an optional `watermark` — a facet key and value,
the source's own clock, and `asOf`, when the view was taken; the Linear adapter
sets the value to the issue's `updatedAt` under `linear_updated_at`, the key the
sync's plan reads, and the dump supplies `asOf`; `docOf` writes the key into
the row's metadata itself, so the guard is never inert for an adapter that
forgot the facet — and `upsertRecord` writes a record only when the row's
stored value under that key is older, or equal with the row not written after
`asOf`, in the same clause that guards the write; otherwise the outcome is
`stale`, the structure is not recorded (the record's links and mentions are the
older state's and would close what the sync wrote), and the run counts and says
it; a record with nothing to write is `unchanged` whatever the clocks say. The
second clock exists because Linear renames a project, a state or a label
without touching `updatedAt`, and the sync re-renders the ticket from the
census — so two views can carry one value and differ. A record whose identity another thought holds
is asked about BEFORE the write (`source_thought`, so a brain the sync filled
before 053 answers by its claim) and is `held`: with one renderer the sync's
row holds the same text, and the insert would otherwise trip the fingerprint
index first and read `skipped` — true, and the wrong word for a row that is
this very ticket; `record_thought_source`'s `IDENTITY_HELD` stays the backstop
for the race. A dump built before the field (no `issue`) is
refused once, by name, with the rebuild command; a record whose `id` and
`issue.identifier` disagree is refused too, and a dump refused whole exits 2 as
a missing file does. `test-live.ts` [22] runs the sync's
per-ticket unit (`syncIssue`) over the real `SqlStore` with the two model calls
faked and counted: the dump first, then the sync — `unchanged`, no model call,
no second row, the identity on the dump's row; the ticket moves in Linear — the
sync edits the row and its structure, the rebuilt dump is `unchanged` at every
one of the four writes, the old dump is `stale` and moves nothing back; the
project is renamed (same `updatedAt`) — the sync re-renders, the dump built
before the rename is `stale` by the brain's clock, one built after is
`unchanged`, one with no build instant writes, and a view the clock would
refuse that has nothing to write is `unchanged`, not `stale`; the
sync first, then the dump — `captured`, then `held`, no row on the dump's id,
and the sync again `unchanged`. `db/README.md`'s "Two writers of one identity"
is rewritten as the three rules (one holder, metadata merges, the clock wins,
with the brain's clock where Linear's is silent, and which tickets the dump can
hold at all); the interim "rebuild without `--linear`" instruction is gone. The
harnesses' text rule is untouched: `eval-real.ts` still queries by a title the
document does not contain.

**Why.** SMD-1954's first review pass found the two tools rendering a ticket
two ways and the ingester replacing metadata wholesale, so on one brain every
rebuild rewrote ~300 rows one way and the next sync pass wrote them back (300
embed and 300 chat calls). SMD-1867 (PR #135) shipped the merge, the vector
clear and `held`; this closes the text half and the case the first half opened:
with one renderer, an OLD dump over a brain the sync kept current would have
been a clean `updated` back to the dump's day.

**Held.** `bun ingest-linear.ts --self-check` (the watermark is the issue's
`updatedAt` under the facet key; `ISSUE_FIELDS` selects every key of a
`LinearIssue`); `bun ingest-records.ts --self-check` (the text is the adapter's
render, not the eval's title + text; the canonical is the sync's bytes; the
watermark carried through `docOf`; a dump without `issue` refused with the
rebuild command; an id/identifier disagreement refused); `bun sync-linear.ts
--self-check`; `test-live.ts` [22] as above and [19] on the dump's new shape;
`tsc` clean in `db/` and `evals/`. Mutant: the watermark clause removed from
the guard — [22]'s old dump reads `updated` and the row Backlog again. Run
against the real thing: the corpus rebuilt from Linear with the new selection
(879 documents, every `issue` the fourteen keys of the type), dry-run through
the ingester, and its canonicals compared with what the sync's `--full` pass
had stored on the dogfood brain — of 137 tickets in both, 135 byte-identical,
the 2 that differed had moved in Linear since the pass (`updatedAt` and the
relations), their rendered text identical.

**Review passes.**

| pass | finding | caught by | fix |
| --- | --- | --- | --- |
| 1 | the guard was `stored <= record`, so at an EQUAL watermark an older dump's text won — and Linear renames a project, state or label without bumping `updatedAt` while the sync re-renders from the census: a Monday dump on Friday undid Tuesday's rename, and the next pass redid it — the ticket's failure, narrowed to renamed-between tickets | independent read | the dump carries `fetchedAt`, the contract's `watermark.asOf`; at an equal value a row written after it is `stale`; a record with nothing to write stays `unchanged`; [22] renames a project and drives the three cases |
| 1 | a dump refused whole was a stderr note beside a run that ingested the other sources and exited 0, where a missing file exits 2 | independent read | exit 2 with the reason |
| 1 | the contract said the watermark "is one of the facets" and nothing made it so: an adapter that forgot the facet had an inert guard | independent read | `docOf` writes the key into the row's metadata; the self-check plants a watermark with no facet |
| 1 | the `ISSUE_FIELDS` self-check stripped two brace levels of a three-deep selection, leaving `{`, `}`, `nodes` as "selected" | independent read + own read | innermost braces stripped until none remain; tokens held to `\w+` |
| 2 | the docs said a row written after `asOf` "was rendered by a later view" — `updated_at` is the brain's last write by anyone (a facet patch, a re-embed, a retag, a hand edit), so a rename the dump saw can read `stale` behind such a write; the sync's next pass lands it, a delay not a loss; the brace loop hung on an unbalanced selection instead of failing; two doc nits (the ingester reads `id` too; the dump's filter is a non-empty text and `OB1_CORPUS_MIN_CHARS`); "a record with nothing to write is `unchanged` whatever the clocks say" had no assertion | independent read (the stop signal: nothing above low) + own read | the words in the contract, the docblock and the README; the loop fails by name; the nits; [22] re-ingests a clock-refused view with nothing to write and reads `unchanged` |
| 1 | [19]'s comments still said the held record's "transaction rolled back" — the pre-check answers before any write now; the README did not say which tickets a dump can hold | independent read + own read | the words; the in-function `IDENTITY_HELD` named as [48]'s; the population sentence |

**Not taken.** Comments in the thought text — the sync never fetched them and
one renderer means one text; the thread is a derived-thought question beside
SMD-1951's addendum (the next slice). Per-project scopes for the dump — it is
one export, cleared as one. A `stale` that patches metadata alone — an older
record has nothing newer to say. Fetching live through the sync's client
instead of extending the dump — the dump is the harnesses' fixture and the
ingester's input in one file, built once.

**Follow-ups.** SMD-1951's addendum (dated `## Update` sections as derived
observations), SMD-1867's third slice. SMD-1865's extractor measurement stays
an operator run.

**Upstream status:** not sent — the ingester and the board sync are the fork's own.
