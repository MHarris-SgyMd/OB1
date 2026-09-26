# 144. A ticket's dated sections are thoughts of their own — observations derived from the ticket, from whichever writer holds it (SMD-2059)

**What changed.** SMD-1951's labelling found the dated addenda tickets carry
(`## Update 2026-09-19 (board audit)` on 75 of the 271 imports it labelled;
81 rows carry a dated heading of any kind on the dogfood brain today;
`## Corrected …`, `## Measured …`, `## Upstream survey, …`) are observations
about premises that moved, stored inside a `plan` where no filter or report
reaches them. The Linear adapter (`db/ingest-linear.ts`) now yields each
level-2 heading carrying an ISO date as a **derived item**
(`issueSections`, `derivedSections`): identity `SMD-N#<slug of the heading>`
in the `linear` system (a repeated heading counted `-2`, `-3`), the section's
raw Markdown as canonical (`text/markdown`), text = the ticket's identifier
and title, the heading, the body with autolinks and Markdown links flattened,
links `child_of` the ticket and `references` for its autolinks, facets
`type: observation`, `ticket`, `section`, `observed_at`, `url` and the
ticket's `linear_updated_at`, `createdAt` the heading's date. The facet is
`ticket`, never `issue`: `issue` is the sync's claim on a ticket ROW, and a
part carrying it would join the ticket's twin group. Headings only — a bold
`**Corrected …**` paragraph is prose and stays. The contract
(`db/ingest-contract.ts`) gains `Ingested.derived?: Derived[]`; the ingester
(`docsOf`) writes the parts after the parent under its scope and watermark,
each row's `derived_from` resolved at the write to the row that holds the
parent's identity (`source_thought`) — this run's or the sync's. The sync
(`syncDerived`, inside the structure hook's recovery) finds each part by
identity through a new `holderOfIdentity` Writer hook, patches its facets or
leaves it, or edits it, or captures it `derived_from` the head with its own
vector and tags (`type: observation` over the model's guess), records its
structure with the take, and reports a `sections` line; a part that fails
clears the ticket's watermark so the next pass retries. A section edited away
leaves its row (the ingester's add-and-update rule).

**Why.** SMD-1867's contract said the rule; SMD-1951's atomizing did it by
hand for 13 thoughts; the headings are deterministic, so it is adapter work,
not model work, and with both writers doing it the SMD-1958 convergence holds
for the parts too.

**Held.** `bun ingest-linear.ts --self-check` (three sections from a sample,
slugged and counted; a `###` belongs to its section; raw keeps markup,
heading and text do not; a date in parentheses counts, a bold paragraph does
not; identities, links, facets, createdAt); `bun ingest-records.ts
--self-check` (`docsOf`: parent first, the part on its own id under the
parent's scope and clock, derived from the parent's identity, gated with it);
`bun sync-linear.ts --self-check` (capture writes ticket then section
`from=new` with type observation; an unchanged section: no model call; a moved
section: one edit; facets behind: one patch; DUPLICATE_CONTENT refused; a dry
run and a pre-053 brain write none; a failing part clears the watermark);
`test-live.ts` [23] over the real store: dump first — two rows, the part
`derived_from` the ticket, `trace_provenance` walks it, the sync reads both
unchanged with no model call; an edited section — one edit each, no second
part row, the rebuilt dump unchanged; sync first — captured with its part, the
dump `held` for both, the sync again unchanged. `tsc` clean in `db/`. Against
the real corpus dump (879 documents): 74 carry a dated heading and yield 97
parts, 97 distinct identities, the longest 89 characters; the ingester's dry
run counts 976 records.

**Review passes.**

| pass | finding | caught by | fix |
| --- | --- | --- | --- |
| 3 | a part this tool captured whose structure write then failed (two statements, not one transaction) stands without its identity, and the pre-write holder check refuses it on every later visit — the ticket path adopts an unclaimed holder, the derived path has no such rule; "refused each pass until the old row goes" overclaimed (a derived refusal does not hold the ticket stale — it is refused on each pass that VISITS the ticket); the near-twin sentence did not say the ingester reads `skipped` | independent read (the stop signal: nothing above low that pass 2 introduced) | the adoption rule filed as SMD-2075 and named in the comment and the README; the two sentences |
| 2 | the `existed` refusal came AFTER the model calls and the capture: a near-twin section (016's fingerprint folds case and whitespace, the adapter's same-text rule is exact) paid two model calls and merged its facets wholesale onto the holder every pass, the holder's `section` facet ping-ponging; an unclosed fence and the counter-rename's refused part were not said | independent read (probe) | the text's holder is asked BEFORE a model call, as the ticket path asks, and refused there; `existed` stays the race backstop; the words |
| 1 | the section grammar ignored fenced code: a `# ` bash comment inside a fence ended a section (canonical truncated to an unclosed fence), a `## Update …` quoted inside a fence opened one | independent read (probe) | fence state tracked; inside a fence neither regex matches |
| 1 | `2026-13-45` matched the date shape; written as `created_at` the timestamp cast aborted the ingester's whole run midway | independent read + own read | `isCalendarDate` (a `Date.UTC` round-trip); a heading whose date does not exist is not a dated heading |
| 1 | two sections of one ticket with byte-identical text: the sync's `existed` branch took the identity onto the other part's row, re-keying it between the two identities every pass (a thought holds ONE identity), and the ingester's dedupe disagreed on which | independent read (probe) | same-text sections yield one part; `existed` is refused and said, as the ticket path refuses an outside holder — never a take |
| 1 | CRLF descriptions yielded no sections; an ISO timestamp's date was refused by `\b` | independent read | lines split on `\r?\n`; the date may be followed by anything but a digit |
| 1 | a part's edit was gated on the facets alone, the ticket's on the row's metadata under them; `capture undefined` in a self-check expectation; `created_at` differs by writer, a refused ticket and a dry run write no parts, a skipped parent leaves `derived_from` NULL, the `-N` counter is order-dependent — none said; three floating counts | independent read | the row's metadata under the facets; `status=-`; the README and this record say each; the counts named by what they count |

**Not taken.** Splitting Problem / Work / Verify into rows (the ticket is
what people search for and cite). Bold dated paragraphs (prose; a heading is
the author's own signal). Closing a part whose section was edited away or
whose heading was renamed (a renamed heading is a new part; neither writer
removes; while the old row holds the text the renamed part is refused each
pass; a report of orphans is a follow-up). A `created_at` on the sync's
capture (the store takes none; the ingester's part rows carry the heading's
date, the sync's the capture's moment). A valid-from column (SMD-1725):
`observed_at` is the facet until one exists. Comments as parts (the sync
never fetched them).

**Follow-ups.** One `sync-linear.ts --full` pass on the dogfood brain writes
the parts for every ticket; SMD-2075 (adopt an identity-less holder of a
part's text — the sync's own orphan from a failed structure write); a report
of parts whose section is gone; SMD-1949's enum decision reads the new
`observation` count.

**Upstream status:** not sent — the adapter and both writers are the fork's own.
