# 32. Hybrid ranking — one fused search behind `search` and `search_thoughts`

Migration 017 (Linear SMD-958). Since change 26, retrieval was two disjoint
tools: `search_thoughts` and the ChatGPT-compat `search` called `match_thoughts`,
and `search_thoughts_keyword` was exact substring. 012 chose that deliberately
and left two things open. A query that is partly a literal and partly a
description — "the scheduler timeout around `ERR_POSTGRES_SERVER_ERROR`" — was
served badly by both, and nothing routed. And the compat `search` could never
reach keyword search at all: ChatGPT matches on the exact `search`/`fetch`
shapes, so that tool cannot grow a `mode` parameter, and for an identifier it
got what 012 measured — 37 of 60 not in the top ten. A third tool fixes
neither; fusing behind the tools that exist does. `search_thoughts_hybrid` is
what both now call; `search_thoughts_keyword` stays as the exact tool with its
paging and its true `total_count`.

**The fusion is asymmetric, and each half has a reason.** Reciprocal rank
fusion on the vector arm — `1/(60 + rank)`, the conventional constant — because
a cosine similarity and an occurrence count are not commensurable and score
blending would need a normalisation nobody can justify. But not RRF on the
keyword arm: `search_thoughts_keyword` orders by occurrences then recency, which
is a stable page order and not a relevance order, and RRF would read its rank
positions as evidence. So the keyword arm contributes *presence*: each literal
a row contains is worth exactly a rank-1 hit, `1/61`, and two literals beat one.
Among rows the keyword arm found, the order is the vector's judgement — each
hit's own cosine similarity, computed directly (a primary-key probe, best of
the thought's vector and its chunks, the rule `match_thoughts` uses), as the
tiebreak. A row both arms return therefore outranks any row only one returns,
and **a query with no identifier in it returns `match_thoughts`' rows in
`match_thoughts`' order** — up to ties in similarity, which `match_thoughts`
leaves to the plan and this function breaks by id — asserted in
`db/test-schema.ts` at three thresholds.

**The needles come from one rule, in SQL.** `extract_search_needles` takes
quoted or backticked spans as written, then identifier-shaped tokens — a digit
or underscore but not a bare number, an interior slash or dot, an interior
capital — three to 64 characters, de-duplicated, at most eight. Ordinary words
are left to the vector arm: `harpsichord` has an embedding, `PGRST202` does
not. A needle found in more than 100 thoughts is reported as common and not
used: 100 is the keyword page cap, so within it the presence boost lands on
every row containing the literal, and above it on an arbitrary hundred.

**The gate.** Embedding `SMD-506` alone is noise — 012 measured the containing
thought at rank 150. When the query minus its needles has nothing the English
text-search parser keeps as a lexeme, the vector arm's rank term is dropped;
exact hits come first and the rest follow by similarity. With a content word
left, the arms are peers. Without the gate an identifier query ties its exact
hit against the vector's meaningless top row and the similarity tiebreak hands
first place to the noise: measured, MRR 0.925 at ten results and 0.850 at a
hundred, against 1.000 with it.

**The eval came before the ranker, because the existing one could not judge
it.** `evals/eval-keyword.ts` selects tokens unique to one document, so any
fusion containing the keyword arm scores ~100% there, good blend or bad.
`evals/eval-hybrid.ts` builds four sets from the 441-issue corpus, each
mechanically and each stated: **identifier** (eval-keyword's 60, the token
alone), **semantic** (eval-real's 441, title → body), **mixed** (38: documents
vector misses at rank 1 on their title, plus an identifier from the body found
in 2–30 documents and absent from the document vector wrongly ranked first),
**decoy** (60: documents vector gets right at rank 1, plus a token unique to a
*different* document). Every arm and six variants answer the same 599 queries;
a control asserts the shipped function's order equals the harness's fusion on
every one, and that every identifier query is hapax to the SQL function. At
the tools' own setting — ten results, threshold 0.5:

| set | n | arm | R@1 | R@5 | not in top-10 | MRR |
| --- | ---: | --- | ---: | ---: | ---: | ---: |
| identifier | 60 | vector | 10% | 15% | 51 | 0.116 |
| | | keyword | 100% | 100% | 0 | 1.000 |
| | | **hybrid** | **100%** | **100%** | **0** | **1.000** |
| semantic | 441 | vector | 83% | 97% | 8 | 0.894 |
| | | keyword | 10% | 13% | 376 | 0.111 |
| | | **hybrid** | **83%** | **97%** | **9** | **0.895** |
| mixed | 38 | vector | 47% | 89% | 1 | 0.656 |
| | | keyword | 26% | 84% | 0 | 0.503 |
| | | **hybrid** | **95%** | **100%** | **0** | **0.974** |
| decoy | 60 | vector | 88% | 98% | 0 | 0.930 |
| | | keyword | 7% | 7% | 56 | 0.067 |
| | | **hybrid** | **75%** | **98%** | **0** | **0.850** |

Hybrid matches keyword on the identifier set, matches vector on the semantic
set (one more miss in 441 at ten results, one more at a hundred), and on the
mixed set — the case the ticket was about — takes R@1 from 47% to 95%, above
either arm on twelve queries and below neither on any.

**The decoy set is the cost, and it is stated rather than tuned away.** A
strong semantic match with a wrong identifier appended loses first place 15
times in 60, to the document that contains the identifier *and* is among the
ten nearest by meaning — "both arms" beating "one" as designed. R@5 does not
move. Whether that is wrong depends on which half the person meant, and the
function cannot know; what it can do is say so, and every row carries the
needles it matched.

**The window is N, and the eval chose it.** The first draft over-fetched the
vector arm to `least(100, greatest(4N, 40))`, the usual RRF precaution against
cutting a winner before fusion. The precaution does not apply here — keyword
hits carry their own similarity, so nothing outside the window is lost — and it
had a cost: "both arms" at F = 40 meant "contains the literal and is among the
9% nearest", which promoted the decoy 19 times in 60 and put one more semantic
query out of the top ten. At F = N it means "contains the literal and the
semantic tool would have returned it". Every other set was unchanged or better.
Plain RRF over both lists, the fusion the ticket named as the one not to
inherit, was measured beside it: 0.867 on semantic against 0.894, 0.947 on
mixed against 0.974, 0.925 on identifier against 1.000. Rarity-weighted
presence (`ln(T/df)/ln(T)`) was measured too: one semantic miss fewer in 441
and nothing else. It is not shipped.

**No paging, on purpose.** 012's `total_count` is exact and cheap because its
ordering already materialises the whole match set; a fused result's total is
the size of a union neither arm knows without running unbounded. Rather than
report a number that is not a count, the shape has no total and no offset; the
tool description says so and points at the exact tool for paging. Fixed top-N,
N clamped to 1–100.

**Both indexes are reached through the wrapper, and the bench found the one
thing reading could not.** `db/bench-hybrid.ts`, 10,000 rows, reads
`pg_stat_user_indexes.idx_scan` for the HNSW and trigram indexes before and
after thirteen calls (the generic-plan probe from change 26): both counters
advance by thirteen. A control plants a decoy only an unescaped pattern would
match and refuses to time a wrong result. Its first run then showed the fused
call at **15 ms where its two arms cost 1.3 ms together.** Neither arm was
slow. The planner cannot see into a plpgsql function and estimates 1,000 rows
from each function scan; the first draft joined `thoughts` at the end for the
row's columns, so the estimate was a ~6,000-row hash join over the whole table,
and its cost — 216,000 against a real few hundred — crossed `jit_above_cost`.
PostgreSQL JIT-compiled 112 expressions on every call; `auto_explain` with
nested statements showed "Functions: 112", and nothing at the SQL level did.
Two changes, both kept: the function no longer joins `thoughts` (both arms
already return the row, so only a keyword hit outside the vector window touches
the table, by primary key), and it runs with `jit = off`, scoped to the call
like 014's hnsw setting — nothing in it has enough rows for compilation to pay.
After: fused with one needle 1.08 ms against 0.47 + 0.28 for the arms
separately; a query with no needle 0.75 ms against 0.41 for `match_thoughts`
alone, so every ordinary semantic search pays about a third of a millisecond
for the needle rule, the stopword test and the wrapper. A needle in a tenth of
the rows is probed as common and never paged: 1.11 ms, against the 5.12 ms
keyword page it no longer fetches. The trigram counter advances twice per call
with a needle — once for the probe, once for the page.

**What changed for callers.** `search` and `search_thoughts` are hybrid; their
descriptions say what is matched literally. `search_thoughts` renders
`Contains: …` on a matched row, reports `exact match, no vector` for a keyword
hit that has no embedding yet, and leads with the literals it searched for
exactly, the ones no thought contains, the ones too common to use, and whether
the query was literal-only. A third store type,
`ThoughtHybridMatch`, with `similarity` nullable — a shared normaliser keeps
both stores from turning "no vector" into "orthogonal" (`Number(null)` is 0).
`preflight.ts` fails on a database that stops at 016, because the two most-used
tools now need 017. SMD-945 (recency) landed in change 37, in `match_thoughts`
as planned; the fused function ranks its vector arm on `match_thoughts`' `score`,
so rows in the window inherit the blend through their rank — the keyword arm is
boolean here, so age is never counted twice. One
place must be mirrored: a keyword hit outside the window is scored by 017's own
copy of the best-of-vector-and-chunks rule, and the header marks it.

**One review pass, triaged.** Ten confirmed findings; eleven fixes, two tickets,
three declined. The one that mattered most was not in the new code: four
comment lines added to migration 012's header changed its hash, and
`migrate.ts` reports an applied migration whose file changed as drift and exits
1 — every deployed database would have failed its next migrator run while fresh
CI containers passed. 012 is byte-identical to `main` again. The rest: the
hybrid presence check lived only on the SQL branch of preflight while
PostgREST is the default store, so it now probes the function over PostgREST
with an RPC; the literal-only gate stripped needles case-sensitively and
shortest-first, so `SMD-944 smd-944` or `ERR_TIMEOUT ERR_TIMEOUT_LONG` left
lexemes behind and opened the gate — needles are now removed longest-first on
lower-cased text; `e.g.` and `i.e.` passed the identifier test after their
trailing dot was stripped — a dotted or slashed token now needs two characters
together somewhere; the tool header said "Matched exactly on" for a literal no
thought contained — it says "Searched exactly for" and names the absent ones;
`test-support.ts`'s drop list lacked the two new functions; the `threshold`
parameter's narrowed meaning is described; a NULL threshold is coalesced like
the other parameters; the common-needle rule is written as the completeness
test (rows fetched = `total_count`) rather than the constant 100; the eval's
decoy builder guards an empty identifier set; the vector-cache override is a
prefix so two text rules cannot share one file; and the stride sampler has one
definition. Tickets: SMD-1040 (`PostgrestStore.matchThoughts` is still a bare
cast, so `created_at` differs in format between stores on the vector path;
done in change 52) and
SMD-1041 (declare `ROWS` on `match_thoughts` and `search_thoughts_keyword` in
their own migrations — a hint set from 017 would be reset by the next
re-apply of 014; done in change 36). Declined: rewriting the CTEs as a FULL OUTER JOIN, moving
`eval-graphrag.ts` onto the shared vector cache in this PR, and de-duplicating
the standalone benches' helpers. The numbers above did not move.

**A second pass, triaged: ten fixes, none ticketed.** The tool's header
derived "no thought contains X" from the page it had, so a literal whose only
hit was cut by `limit` was reported absent — the function now returns
`needle_counts` beside `needles`, and the tool tells absent from "outside the
top N" by the count. The tool descriptions promised an exact hit "whatever its
similarity"; they now state the real contract (rare enough to match, within
the limit) and no longer hard-code the page size. A quoted span over 64
characters was rejected as a needle and also blanked before the identifier
pass, so a pasted error message in quotes lost its `ERR_*` code — only an
accepted span is blanked now. An empty result said nothing about why; the tool
makes one more call at no threshold to report an absent or too-common literal.
An only-common literal-only query printed two contradictory notes. The eval
harness's copy of the needle rule and the gate had drifted from the SQL
without the control noticing, because no query exercised the difference — it
reads `needles`, `common_needles` and `literal_only` from the function now. A
non-numeric cap emptied the sets instead of meaning no cap. `eval-graphrag.ts`
moved onto the shared vector cache after all (verified against its dump; same
numbers). The dead quote-stripping line in the gate is gone. And the PostgREST
store gained the `hybridThoughts` conformance test it lacked — which
immediately found that the SQL-backed compat client hands an `int[]` back as a
typed array, for which `Array.isArray` is false, so `needleCounts` was empty
on that path until the normaliser accepted array-likes. Declined: `ALTER
FUNCTION … ROWS` inside 017 (SMD-1041; a re-apply of 014 would reset it — done
in change 36),
and three cosmetic duplications.

**A third pass, triaged: ten fixes, and the stop.** Three were behaviour.
Ordinals and units — `1st`, `3pm`, `24h`, `10x` — passed the digit rule, and as
substrings sat in every `21st`; reproduced, six junk rows pushed the right
answer from second to eighth. They are excluded. A common needle was paged and
then discarded, and 012's page materialises its whole match set to count it,
so a quoted `"the"` on a large brain would have paid 012's worst case for
nothing; a probe for a 101st matching row now runs first, and a quoted span the
English parser keeps nothing of is not a needle at all. Preflight blamed 017
for a missing 012, because the error text is the same and the PostgREST branch
never checked 012; it probes the keyword function first and names the right
migration, and the 017 check has the test the 012 check always had. The rest
was wording made true — an exact hit is ranked *with* the strongest semantic
results, not ahead of them; "row for row" holds up to similarity ties, which
`match_thoughts` leaves to the plan and this function breaks by id; recency
from SMD-945 is inherited only inside the vector window, and the probe that
scores a keyword hit outside it is marked as the copy that must be mirrored —
plus two harness controls that could report the wrong thing, the mixed set's
appended token now checked against the product's rule, and stale numbers in
this file and `db/README.md`. Nothing in this pass touched the fusion itself,
which is the signal to stop reviewing and open the PR.
