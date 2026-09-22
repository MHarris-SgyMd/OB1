# 37. `match_thoughts` blends recency into its ranking — opt-in, after the candidate scan, and measured to cost something here

Migration 020, `evals/eval-recency.ts`, and `recency_weight` on
`search_thoughts` (Linear SMD-945; the recency half of upstream
[#469](https://github.com/NateBJones-Projects/OB1/issues/469)). `match_thoughts`
ranked on cosine similarity alone, so two thoughts of equal fit ranked
identically whether one was captured yesterday or two years ago — right for a
reference brain, wrong for a working one, and quiet either way. Upstream's
`schemas/recency-boosted-match-thoughts` has the formula — `score = similarity ·
(1 − w) + 0.5^(age_days / half_life) · w`, `w` defaulting to 0 (upstream writes
`exp(−age / half_life)`, an e-folding time under a parameter named half-life;
here the name is true) — and, as written, two regressions against this fork's
function: it reads `thoughts` alone (change
18's chunk retrieval gone) and puts the threshold and the blend into the scan
(no `ORDER BY <=> LIMIT`, so no HNSW index — the cost change 36 measured). So
the blend is grafted onto the body changes 28 and 36 built, and the access path
does not move: the three candidate CTEs are 019's byte for byte (`test-schema`
[20] compares them against a re-applied 014), only each branch's final SELECT
orders by the blended score, the threshold still gates the raw similarity, and
the exact branch — every matching row scored — makes a thin filter's blend
exact. The plan is held where change 36 holds it: `test-live` [5c] explains the
statement with `recency_weight = 0.3` and finds both HNSW indexes and a
candidate window of 160.

**Two facts found while planning shaped the work more than the formula did.**
The signature had to change, and a second overload beside the 4-argument
function is the ambiguity change 5's migration (004) warns about: with both
present, every 4-argument call — both stores, 017's fused function, every
PostgREST caller — fails with `function is not unique`. So 020 **drops** the
4-argument function and defines the 6-argument one (`recency_weight float
DEFAULT 0`, `half_life_days float DEFAULT 90`), and does the same to
`search_thoughts_hybrid`, which passes the weight through; every place that
spelled the old signatures (`dropSchema`'s list, `extractBody`, preflight's
catalog reads, the fixtures' `ALTER FUNCTION`) now reads one constant in
`db/config.mjs`, and `extractBody` resolves the function by name so the
benches' before arms still read 014's. And 017 re-ranked the vector arm by
`similarity` *inside* the fused function, which would have undone the blend for
every first-party search. So `match_thoughts` returns the blended value as a new
**`score`** column — equal to `similarity` at weight 0 — `similarity` stays the
raw cosine (the threshold's quantity, the tools' "% match", and what 017's
keyword-hit probe computes, so nothing has to be mirrored), and the hybrid
ranks on `score`.

**The window.** The blend can only reorder the candidates the scan produced,
and no fixed window is exact: a recent row of similarity *s* just outside the
nearest 4N enters the top *k* when *s(1−w)+w* beats the *k*-th blended score,
which depends on the data. Under a weight the over-fetch widens fourfold (16N,
at least 80), and the factor is measured rather than assumed: `eval-recency.ts`
compares the function's top N against an exact blended ranking of the whole
table, and against the top N the un-widened window would have given. On 486
queries at every weight and half-life the function matched the oracle in
every cell, where the 4N window fell to 96% at 0.2 over 30 days, 93% at 0.3
and 85% at weight 1. Read with the corpus's size: at 10 results the widened
window is a third of the 486-row table, and at 100 results it *is* the table,
so that cell can only agree with the oracle. What the corpus shows is that 4N
loses rows the formula ranks first and 16N did not, at its size; on a brain of
tens of thousands the window is a fraction of a percent of the table, and the
contract is a re-ranking of the nearest candidates, not an exact blended
ranking of the table — the header says so. The exact/walk threshold does not
widen with the window: `v_exact` is sized from the unweighted 4N, so a filter
routes the same way at every weight. The adaptive alternative
(fetch, check the bound, widen, fetch again) was declined: it either runs the
index scan twice or moves the candidate CTEs out of the `RETURN QUERY` blocks
that [5c] and both benches read from the catalog. What a weighted call costs
is in `bench-plan.ts`'s new arm: at the default count and 10,000 rows,
both candidate CTEs stay Index Scans and the call goes from 1.8 ms and 3,434
buffers to 5.1 ms and 9,558; at count 50 from 6.3 to 16.9 ms; at the ceiling
from 33 to 79 ms; at 100,000 rows, 2–3 ms become 8 at the default count, 12–14
become 84 at count 50 and 170 become 365 at the ceiling, every cell still two
`Index Scan`s.

**Measured, and left off by default.** The corpus was rebuilt with each
issue's creation date (`build-linear-corpus.ts` records it; the `/tmp` copy had
gone), 486 issues, 0–183 days old, median 82. The task is `eval-real`'s — title
finds body — so the right answer is the issue whatever its age, and the number
is what a weight *costs* on a relevance task; this corpus has no ground truth
for "what was I doing about X" and cannot show a weight helping. At the tools'
setting (10 results, threshold 0.5) every weight lowered MRR: 0.899 at 0 →
0.894 at 0.1 over 365 days, 0.879 at 0.1 over 90, 0.811 at 0.2 over 90 (8
answers moved up, 88 down), 0.667 at 0.3, 0.158 at 1. The ticket said what to
do with that result, and it is done: the default stays 0, `search_thoughts`
takes `recency_weight` (0–1; the half-life stays 90 days for the tool) for a
caller who knows their brain is a working log, and the ChatGPT `search`, which
cannot take a parameter, sends a fixed 0 with the measurement as the reason.
The control ran before any table was printed: at weight 0 the shipped
function returned 019's rows in 019's order, and `score` equalled `similarity`,
on every query at both settings.

**Held, in the ticket's words.** `test-schema` [21]: backward compatibility
*exactly* — 019's own function installed from its file under another name, and
on a fixed corpus reaching the unfiltered and the exact branch the new one
returns the same rows, ids and similarities, over eighteen calls, with `score`
equal to `similarity`; chunks still found through the recency path; the blend
does something — two rows swap as the weight crosses the formula's *w** =
δ / (δ + r₂ − r₁), asserted on both sides, and a 30-day half-life moves *w**
where the formula says, so one weight gives opposite orders under the two
half-lives; the threshold gates raw similarity (a brand-new orthogonal row is
not surfaced at weight 1); weights clamped, a non-positive half-life refused, a
NULL `created_at` infinitely old (the first draft's `GREATEST` swallowed the
NULL and called the row brand new — the test caught it); the widened window
observable, a recent row ranked 61st by similarity coming first under a
weight; the hybrid following the weighted order with its `similarity` still
the cosine; infinite timestamps scored at both ends and never subtracted at
weight 0; ties broken by id through a LIMIT; the fused search under a weight
and a threshold returning the newest row *above* the threshold; a literal-only
query ordered by the blend; and the ACL replayed across the DROP. [20] keeps
019's expectations for the keyword function and adds
the new trap: re-applying 014 puts the 4-argument form back beside 020's, and a
4-argument call is then `function is not unique`. Preflight gains a `search
signatures` check that fails a database whose functions predate 020 (the
server sends the new arguments) and one with an earlier form re-created beside
020's, with the `DROP` as the remedy; its 014 and 019 checks read whichever
form is there and name it in their `ALTER FUNCTION`. Both stores send all the
arguments on every call and map `score`; `test-store-sql`, `test-store-postgrest`
and the e2e suite each age a row and watch it drop. Suites: schema 423 (both
widths), live 230, preflight 101, sql 56, e2e 62.

**A first pass, triaged: eight fixes and two corrections to what the docs
claimed.** The parameter was named `half_life_days` and the formula was
`exp(−age / half_life)` — an e-folding time, 0.37 at the half-life, upstream's
mistake carried over; it is `0.5^(age / half_life)` now, the tool text ("halves
every 90 days") is true, and every number above was re-measured (the slower
decay costs a little less: 0.811 rather than 0.775 at 0.2 over 90 days). The
formula was inlined three times in the body and twice more in the harnesses;
`recency_score()` — a SQL function the planner inlines — is the one copy, called
by `match_thoughts`, by the hybrid for the keyword hits it scores itself, and by
the eval's oracle (which therefore measures the window, not the arithmetic;
[21] holds the arithmetic against the formula written out in TypeScript). It
also carries the fix for a row with an infinite `created_at`: the first draft
computed `now() − created_at` for every candidate at every weight, which
PostgreSQL 16 — the pinned server, though not PGlite — refuses for `±infinity`,
so a hand-written row would have broken `match_thoughts` at weight 0 where 019
answered fine; the CASE now never evaluates the age at weight 0. Three more in
the hybrid: under a weight it passes the caller's threshold to `match_thoughts`
instead of −1, because recent sub-threshold rows could fill the N slots and be
dropped by the threshold below, leaving older above-threshold rows that never
entered the window — `search_thoughts` answering "nothing" for a query the
unweighted call answers; its tiebreak among equal fused scores is the blended
value rather than the raw similarity, which for a literal-only query (the gate
gives the vector arm no vote) was the whole order, so the weight chose the rows
and then did not order them; and `match_thoughts`' own `ORDER BY` gained `id`
as a second key, since rows sharing a `created_at` tie exactly at weight 1 and
019 left which survive the LIMIT to the plan. Two on the deployment path: a
`DROP FUNCTION` loses the function's ACL, so an operator's `REVOKE EXECUTE
FROM anon` on the old form would have been silently undone on Supabase — 020
reads each old ACL before its DROP and replays it after the CREATE, and [21]
proves it; and the `search signatures` check ran only on the SQL store, so on
the default PostgREST store two overloads went undetected while every
4-argument caller failed — preflight now probes PostgREST as such a caller
would, with four named arguments, which only two overloads make ambiguous. The
e2e assertion that the aged row still shows "100.0% match" had an operator
precedence that made it always true; it reads the row's own header line now.
And the window claim above was stated as support at both settings when at 100
results the window was the whole 486-row table; it is stated for what it is.
And one thing the pass did not find but the run did: `db/with-postgres.sh`
removed its container and not the anonymous volume the postgres image declares,
so 776 of them — 79 GB — had accumulated and the podman VM ran out of disk
mid-bench; it removes both now.

**A second pass, and the stop.** Every one of its ten findings was about the
first pass's own additions, which is the signal this fork stops reviewing on;
all ten were fixed. The ACL replay revoked only PUBLIC before re-granting, so
the grants `ALTER DEFAULT PRIVILEGES` puts on a fresh function — on Supabase,
anon, authenticated, service_role — survived, and an operator's `REVOKE` on
anon came back: the regression the block exists to prevent. It revokes every
grantee the CREATE handed out now, then grants exactly the old ACL, grant
option included; and it runs only on the run that *creates* the new form,
because a re-run over the two-form state read the 4-argument form's ACL and
stamped it over a hardened 6-argument one. [21] holds four cases with a test
role and default privileges (PGlite has both). Under a weight the hybrid passes
the threshold, so a keyword hit below it left the window at any rank, tied a
rank-1 vector-only row at exactly 1/(k+1) and lost on similarity — "exact hits
first" broken by the threshold; such a hit now carries the rank just past the
window, ahead of every vector-only row and behind a hit the window holds, and
nothing changes at weight 0. A hit with no vector and no chunks had a NULL
blended tiebreak and sorted last at every weight, so at weight 1 a thought
captured today through the 2-arg fallback ranked below a three-year-old hit;
under a weight it is scored by age alone. The PostgREST signature probe said ok
on a database whose only `match_thoughts` predated 020 (a 4-argument call
resolves against the old form too); it probes with 020's arguments first.
`v_exact` inherited the fourfold widening — 32,000 parents scored exactly at
the ceiling under a weight, and the exact/walk boundary moving with the weight
— and is sized from the unweighted window now. The rest: [21]'s second ACL
assertion observed the test's own grant; the eval's narrow-window arm
re-implemented the blend in TypeScript and is the same `recency_score()` over
the nearest 4N in SQL; a cache variant outside its helper's type; the bench's
"after (019)" arms measure the deployed function and are named so; the tool
comment's pre-half-life numbers; a hedged preflight assertion. Then the
tidy-ups the passes had cut for space, while the files were open: preflight's
020 remedy was one sentence written five times and its PostgREST `missing()`
test was defined inside one block and needed by another — both live once now,
and the filtered-search probe's skip line names the `search signatures` check
when the function cannot be resolved at the shape the store sends, rather than
the catalog hint; the two stores each wrote the function's defaults (0 and 90)
twice — `RECENCY_DEFAULTS` in `store.ts` is the one copy; and `bench-plan.ts`
had its own by-name lookup of `match_thoughts` beside `test-support.ts`'s, which
is exported and used instead.

**Not done here.** A default weight for the ChatGPT `search` other than 0 —
the measurement above is the reason, and an operator who wants one has no knob;
if one is wanted it is an environment default, not a constant. `ROWS` on
`search_thoughts_hybrid` (change 36's note stands). A recency eval with ground
truth for "what was I doing about X", which this corpus cannot supply.
