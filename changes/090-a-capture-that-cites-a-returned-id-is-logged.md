# 90. A capture that cites a returned id is logged as a use of it, and `eval-utilization.ts` reads the query log for the layer every other number here skips — did the caller use what came back (SMD-1719)

Every retrieval number in this file asks whether the right rows came back.
MERIT (arXiv 2609.05441, September 2026) measured the next layer — whether a
retrieved fact changed what the agent did — and found agents ignore 45–53% of
correctly retrieved facts, even under full replay; MemoryArena found models
near-perfect on LoCoMo fall to 40–60% when later subtasks depend on earlier
ones. The evaluation stack the literature now asks for is four layers: evidence
retrieval, evidence use, task outcome, cost. The fork had the first (every
`evals/` harness) and the fourth (tokens priced on every decision), and no
number for the second.

**What the log already had, and what it lacked.** Migration 034 (change 65)
records a `search` row per call with the ids returned and an `action` row when
the same agent fetches, edits or deletes a returned id — click-through
relevance: the caller *looked*. It did not record the one act that says the
fact reached a write: a later capture naming the id as its source. `derived_from`
(025) and `supersedes` on `capture_thought` are exactly that act, and they
were not logged.

**What changed.** No migration. 034's `tool` column is free text and its
`action` shape needs only a target, so a write that names a returned id as its
source now logs one action row per id, target the cited id, tool
`<writer>/<pointer>` — `capture_thought/derived_from`,
`capture_thought/supersedes`, `update_thought/supersedes` — under the same
`OB1_QUERY_LOG=on` flag, best-effort like every log write, the rows for one
call in one `INSERT` (`logActions`, the one writer of action rows — a fetch's
single row, a forty-source synthesis, an edit's opened row beside its cite —
so each store has one INSERT shape to keep right; a single-row twin existed
for two passes and was removed as a parity obligation with no reader), the
batch's contract one function both stores call before anything reaches a
database — `normaliseActionRows`: an absent agent (null, undefined, `""`) is
SQL NULL, a target must be present, any id that is not a uuid is refused by
column name rather than reaching `array_in` or PostgREST as a value the
best-effort caller would swallow with the whole batch (a fifth pass found the
agent column bound through a text sentinel, a sixth the target column trusted
while the agent column was checked, an eighth the PostgREST writer sending
`""` through as an agent id and dropping the batch on the 22P02) — ids
lower-cased before the dedup (`UUID_RE` admits either case; two spellings are
one cite). A cite row is written for every id a write names, whether or not a
search returned it; the link to a search is made when the log is read. **A cite row is a pointer the
database accepted**, which is what makes it a use and not a wish: on a fresh
row `upsert_thought` validated every id (a ghost or a loop threw, and nothing
was logged); on a re-capture 035 wrote no pointer and validated none, so nothing
is logged there either — the reply's note sends the caller to `update_thought`,
and that edit, which writes the pointer, logs the cite under its own writer.
The guard is `existed === false`, the store's affirmative "fresh row" from
035's function: a brain at 034 without 035 reports no flag, and logs no cite,
because there the pointer's fate is unknown (a second pass caught `!== true`
reading the absent flag as fresh). Preflight's `query log` check says so on
such a brain, and reads whether the body is 035's from the verdict the
`atomic capture` check already reached over the sentinel that body declares
— one detector, not a second grep of the same source for the word `existed`
(a seventh pass); over PostgREST it is a skip naming both facts.
(The first cut logged on the *act* of citing and a review pass found it would
have counted a ghost or self-pointer a re-capture never checked.) The tool
column now tells two kinds of use apart by its shape alone:

- **cited** — `<writer>/<pointer>`: a write named the id as a source and the
  pointer was written (MERIT's memory-utilization signal). A new writer that
  cites names itself the same way and is counted without a code change.
- **opened** — a plain tool name, `fetch`, `update_thought`, `delete_thought`:
  the caller went and looked at, or touched, the row (034's click-through).

One consequence for change 65: the export's `relevant` label is every action
row, so a cite now counts as click-through relevance too — the stronger label,
and the export's note says so. 034's table `COMMENT` still described an action
as a fetch, edit or delete; a migration's text is not edited after the fact
(the ledger would read it as drift), so the server, store, preflight and README
carried the new shape and the `COMMENT` predated it until change 98
re-commented the table and the column through migration 043.

`evals/utilization.ts` is the pure part: 034's attribution rule (most recent
prior search by the same agent, within the window, whose results held the id; a
NULL agent its own bucket — the export's join in TypeScript, and since a ninth
pass the export's own implementation too: `export-queries.ts` reads the same
two row sets and calls `attribute()`, so the fixture's labels and the report's
uses are one rule by construction rather than two kept in step by hand;
compared at the
log's own microsecond grain when read from the log, since a JS `Date` is
milliseconds and two rows under a millisecond apart would order differently in
the two; a fixture in whole minutes is unaffected), then per arm (the search tool and its
recorded arguments), per agent when the log holds more than one — named from the registry (`ob1_agents.label`, 010) with the id's prefix beside it — and overall: distinct ids returned, ids used
(distinct per search), **utilization** = used / returned, **use rate** =
searches with at least one use, the cited / opened **partition** of used (an
id that reached a write is cited even if it was also fetched; opened is what
was only looked at; the two sum to used, so cited / used is the share of use
that reached a write — a fourth pass found the first cut counted an id in
both), and **tokens per used
id** — approximate, the returned ids' content as stored *now* at four
characters a token, over the searches that carry an estimate — MERIT's
cost-adjusted marginal utility in this fork's units. With a gold map (a
hand-labelled fixture in `export-queries.ts`'s shape), the **ignore rate**:
searches whose results held a relevant id the caller never used.
`evals/eval-utilization.ts` reads the log from `DATABASE_URL` and prints it.

**What the report refuses to print.** With no action rows at all it says `n/a`
and asks whether the log is on, rather than 0% over an empty join — the mutant
[39] runs: drop the cite rows and cited reads 0 and utilization falls to the
opened-only share, so the number is measuring the cites and not something that
would survive their absence. Actions that attribute to no search (a touch
outside the window, an id no search returned) are counted and shown, not
dropped. Nothing changes ranking: the number first. On a brain the log
table is not on (034 not applied) both readers refuse in their own words —
"query_log is not present", apply 034, turn the log on — exit 2, where a sixth
pass found each dying in the driver on its first query (`relation "query_log"
does not exist`, a stack trace) while preflight's own check says it plainly;
the check is one shared helper, `evals/query-log.ts`'s `requireQueryLog`.

**Not done here.** A typed `pointer` column on `query_log` in place of the
`<writer>/<pointer>` convention in the free-text `tool` (a second review pass
proposed it): declined. MCP tool names cannot contain a slash, so the
convention cannot collide with a tool; the typed field for *what a write
cited* belongs on the event itself, which is SMD-1730's event shape (Phase 1
of SMD-1729), not a column bolted onto 034 now. The column's own `COMMENT`
still described three plain names; re-commenting it through a new migration,
as 028 did for the claim table, was **SMD-1749** (a third pass proposed it;
a second mechanism for this PR) and is change 98.

An `update_thought` that re-sends the pointer
the row already holds logs a cite although nothing changed (a third pass):
kept. `used` is a set per search, so a retry inside one search's window counts
once; a re-send after a *new* search that returned the id is that search's
result reaching a write, which is what the number asks; and telling a
confirmed pointer from a written one needs 032's function to return the prior
value, a migration, and would undercount the confirmations SMD-1736 wants to
see.

A `supersedes` cite labels the *superseded* row as relevant in the
export's fixture (a sixth pass): kept. That row is what the searcher needed in
order to correct it, so the search that surfaced it did its job; the fork
labels superseded rows at read time and does not demote them (SMD-1720, change 88), and
a click-through label is bound to the corpus at export time in any case —
`eval-replay.ts` reads `baseline` beside `relevant` for that reason. Labelling
the superseder too would need the fixture to follow `thoughts.supersedes` at
export, a different fixture; the README says which row the label names.

Gating the cite on 035's flag rather than on
"a pointer was written" (a seventh pass): on a brain at 025–034 a fresh
3-argument capture does validate and write `derived_from`, and logs no cite
here. Kept: before 035 the function wrote pointers on a re-capture too (the
NULL fill 035 removed) and answered nothing about which path it took, so the
store cannot tell a written pointer from a filled or ignored one there; the
shipped schema is 035's (the `atomic capture` check warns on every earlier
body and names the file), and the gap is said twice — by preflight and by
the report.

Per-*model* arms: the log does
not record the embedding model a search ran under, and 034's `filter` column
is dead on `search_thoughts` (SMD-1490) — whether to carry the arm there or in
a column is that ticket's call. A read whose use ends in prose to the user, with no write and no fetch,
is invisible to this log, so utilization here is a **lower bound** on use and
the ignore rate an upper bound; the write-path eval (SMD-1713) is where a
planted fact's survival becomes observable. A fixture exported from this log's
own touches is circular as gold (its `relevant` IS the touches); the honest gold
is a hand-labelled set. SMD-1737's four-layer report consumes this as layer 2.

**Verified.** `db/test-schema.ts` [39] drives the pure module over hand-made
rows: attribution by agent, window and recency; the cited/opened split; the
rates; tokens per used id over searches with an estimate; the no-cites mutant;
the gold ignore rate; the `n/a` rule; the rendered table.
`server-portable/test-e2e-sql.ts` [10] extends 034's section: a capture with
`derived_from` after a search writes one `capture_thought/derived_from` row for
the id it named and a plain capture writes none; the join attributes the cite
to the search that returned the id; a re-capture naming a pointer logs no cite
(the pointer was not written); the `update_thought` that then writes it logs
the edited id as opened and the superseded id as cited. A run with the cite
logging removed fails exactly those assertions and nothing else. The bucketed
attribution was checked against a naive reading of the rule on 400 random logs
(distinct timestamps, three agents including NULL, five tools, three windows):
no mismatch.

The report script was run against a throwaway Postgres with a
seeded log: the anonymous fetch of an id its search never returned is the one
unattributed action, tokens per used id came out at exactly what the seeded
content lengths predict, and the gold arm read 0% ignored where the relevant
id was cited and n/a where it was never returned. The SQL writer was probed
against Postgres with an empty batch, a NULL agent, a tool name carrying a
quote and a backslash, and forty rows; a mutant that keeps only the first row
of a batch fails exactly the assertion that reads the second and nothing else.
`test-store-sql.ts` [11] drives the SQL writer's own contract: a batch of three
in one statement, an undefined and an empty-string agent landing as SQL NULL,
and a malformed agent, a malformed target and an absent target each refused by
column before the statement with nothing written (a fifth pass found the
agent column bound through a text sentinel; a sixth found the target column
trusted while the agent column was checked).
`test-store-postgrest.ts` [11] drives the PostgREST writer — the hosted
deployment's path — through the shim: an empty batch, a batch of one and of
three, a NULL agent, the cite tool through the array insert, and 034's join
over what it wrote. Writing that section found a pre-existing shim gap: the
PostgREST store's `logSearch` fails through `compat/supabase-sql` when
`result_scores` carries a null element, which the server sends for a
score-less hit — so a shim-backed deployment can log no search row for such a
call, silently. Filed on SMD-1602; [11] seeds its search row by SQL and says
why. Two searches seeded 400 µs apart both
returning one id, then a fetch: the export's SQL join (as it then was) and the
report both credit the later search; the millisecond fallback credits the
earlier one, which is the disagreement `at_us` exists to close. The
database-row coercions the report relies on (bigint as string, the uuid
literal, a partly deleted result set, `at_us`, a `real`'s float noise) are
driven in [39] without a database, since no CI job runs the report itself.
The number's definition was checked as invariants over 600 random logs with
duplicate ids, retried actions, an unknown tool, partial token estimates and
gold on some queries: cited + opened = used at every grain, utilization in
[0, 1], the per-arm and per-agent tables sum to the overall row, the estimate
is null exactly when its stated condition holds, and the rendered `all` row
carries the overall numbers.

The operator's path was walked end to end as a
separate process — the Dockerfile's entrypoint (`bun preflight.ts && exec bun
index.ts`) against a throwaway Postgres with a stub provider on a port and
`OB1_QUERY_LOG=on`, tool calls over HTTP (three captures, a search, a capture
citing two returned ids, a second search, a fetch, an edit that supersedes, a
re-capture naming a pointer), then both readers: the report's used set per
search equals the export's `relevant` per query, the counts match a hand tally
of the log rows (7 distinct returned, 4 used, 3 cited, 1 opened), preflight
reads the log as present and on before and after, and the same walk on an
empty log prints `n/a`, on an opens-only log the 035 warning, and with the
table absent the refusal above.

The hosted path was walked the same way (a
seventh pass): the server with `OB1_STORE=postgrest` — the default store —
and its real supabase-js client, through a prefix-stripping proxy to a real
PostgREST 12.2 container over the lane's Postgres, the same calls; the log
rows, the report and the export came out identical to the SQL walk. That walk
found preflight printing no `query log` line at all over PostgREST — the
check lived only in the direct-connection branch, so the hosted operator got
neither the presence verdict nor the 035 warning; it is now a skip there
naming both facts, like its siblings. The same pass moved the tool column of
an action batch onto the driver's own `sql.array` after probing that it
carries a quote, a backslash, a comma and a brace through `unnest` intact;
the uuid columns keep the by-hand literal because `sql.array` renders a null
element as the text `null`, which `uuid[]` refuses, and the agent column is
nullable — probed, not assumed. Two fixture-side guards were added and held
in [39]: a row whose instant does not parse is never credited and never
attributed (NaN passes both window tests and would have taken the agent's
newest search), and a gold id spelled upper-case matches the lower-case id
the log holds. `test-preflight.ts`'s pre-035 run asserts the `query log`
warning and its absence once 035 is back.

An eighth pass walked two named
agents (`MCP_ACCESS_KEYS`, alice and bob) over the SQL-store server process:
bob's fetch of an id only alice's search returned and bob's cite of an id his
own search did not return are the two unattributed actions, bob's cite of an
id his later search did return is attributed to that search, alice's delete of
a returned id is her search's one use and strips the token estimate from both
searches that had returned it while the third keeps its own; the by-agent
table split the two as the log rows say. That table printed bare uuids, with
the registry that names them one table away — the report now reads
`ob1_agents.label` when 010 is present and prints `label (id prefix)`, held
in [39]. A capture whose embedding the provider refuses fails before any
write and logs nothing, which is the rule (no pointer was accepted). The same
pass's cold read moved the distinct-returned count to one definition — the
reader's, from the parsed ids, where a `count(DISTINCT)` subquery per search
row had duplicated it under a comment that called it a cardinality — and the
035 verdict preflight carries between two checks into the block those checks
share, so a second run in one process starts unset.

A ninth pass fired forty
captures at once at the live server, each citing the two ids one search had
returned: forty succeeded, eighty cite rows landed, none dropped, nothing on
the server's stderr, and the report read 2 used of 2 returned; and it seeded
the window's exact edge at microsecond precision — three agents, each a
search at T and a fetch of its id at T + 30 min exactly, one microsecond
inside and one outside — and both readers agreed: the edge and the inside
fetch attributed, the outside one not, and at a 29-minute window none. That
parity check was the last one needed by hand: the same pass's cold read made
the export call `attribute()` instead of running its own SQL join, cast the
epoch arithmetic to `numeric` so `at_us` is exact on any server, guarded the
registry read so a role without SELECT on `ob1_agents` gets bare ids and a
line rather than a stack trace, made preflight's 035 verdict a plain boolean
(the "could not read" branch was unreachable), and folded the two `uuid[]`
renderers into one. Recounting a search's distinct ids in `summarise()` after
`attribute()` built the same set was raised again and declined: a seventh
pass removed the field that carried it at a reviewer's request, the recount is
one `Set` per search row, and one code path beats a threaded-out map. `bunx tsc --noEmit` in `server-portable/` covers
the server files; `evals/utilization.ts`, `query-log.ts` and
`eval-utilization.ts` have no tsconfig and are **runtime-checked only**,
through [39] under Bun — the same standing as every other `evals/` file.
The measurement itself — the operator's first week of real use with the log on
— is the ticket's Verify, not this section's: the number exists when the log
has rows.

**Upstream status:** not sent — the query log is this fork's (change 65).
