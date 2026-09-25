# 136. The extractor's hedge, graded blind — does the model know when it is wrong, before any prompt is changed (SMD-1982)

**What changed.** `evals/fixtures/entity-grades.json`: a hand grade per
extractor claim (1 = a specific named thing the text holds, of a defensible type, and for an edge a relation the text states or clearly implies; 0 otherwise) keyed the way the live report
keys a claim (thought and entity id; thought, from, to and relation), ids and
numbers only as check 9 admits: the kind is which list a row is in, the
relation its index into `server-portable/entities.ts`'s `RELATIONS`, and the
confidence at the grade sits beside the outcome. `evals/eval-calibration.ts`
reads and validates it (`readGrades`, `validateGrades`: ids, [0, 1], 0/1, an
index on the vocabulary, no claim twice), joins it in `mentionRows` so a graded
mention or edge resolves by "hand grade" and an ungraded one stays unresolved as
before, and counts in a note any graded claim the brain's rows no longer hold.
The grade is of the claim, not of the run: a later prompt version that writes
the same mention or edge is resolved by the same row. `--self-check` pins the
rules and the join and reads the committed file; the CI step that runs it is
unchanged. `evals/README.md` gains the subsection under SMD-1809's.

**Why.** SMD-1809 found the extractor's confidence one value short of a
constant and could not score it: nothing in a brain resolves a mention. The
ticket's Work asks for elicitation arms or for the column to go, and its Update
named the experiment that decides between them without touching the prompt:
when the model does say something other than 1.00, is it right to? On
2026-09-23 the windowed prompt (`extract:qwen2.5:7b@p2`) had 9,583 rows on the
dogfood brain at migration 050 — 32 below 1.00 (the ticket's 34 had moved: the
re-extraction re-runs an edited thought) — so the whole hedged stratum could be
read by hand, with a control of the same size.

**Measured.** 64 rows over 37 thoughts, graded blind to the value (the rows
shuffled by a hash of the claim, the confidence withheld until the grades were
written), then joined:

| bin | mentions | edges | all |
| --- | --- | --- | --- |
| 1.00 (the control, by md5 of the claim) | 12/15 (80%) | 5/17 (29%) | 17/32 (53%) |
| below 1.00 (every such row, as graded) | 1/15 (7%) | 12/17 (71%) | 13/32 (41%) |

By value: 0.50 held 0 of 2 (the parser's default, both mentions), 0.80 5 of 19
(mentions 1 of 13, edges 4 of 6), 0.90 8 of 11 (edges only), 1.00 17 of 32.
The report over the graded rows: Brier 0.425, ECE 0.439, base rate 0.469,
skill −0.705 — a stratified sample, so its base rate is not the brain's. On the
live brain (393 thoughts) the extractor's `@p2` row now reads 64 resolved of
9,583, and no graded claim was missing.

*Mentions:* the hedge is a signal. Twelve of the thirteen 0.80 mentions were
wrong: six type-vocabulary words (`person`, `topic`, `place`, `tool`,
`organization`, `project`) minted from a ticket body that quotes the prompt's
type list; two `PostgreSQL` mentions in thoughts whose text never says Postgres;
four fragments and example tokens. The two 0.50 defaults were `PostgreSQL` too —
four in all, each a different thought, each below 1.00. The control's three
failures at 1.00 (an identifier typed as a topic, a URL fragment, a glob typed
as a place) were not hedged. "Below 1.00" is the column as stored, the two
0.50 defaults included — whether an omitted value is a hedge is the reader's
call, so the numbers are given both ways. Fisher's exact test of that bin
against the control gives p = 0.0001 (0.80 alone 1 of 13, p = 0.0002), but ten
of the fifteen are one thought's (SMD-1937's body), so the rows are not
independent: without it the bin is 1 of 5 against 11 of 14 (p = 0.038), or 1
of 3 (p = 0.19) with the defaults set aside; by thought, held in a bin only if
every graded mention of that bin in it held, 1 of 6 against 12 of 15 (p =
0.014), or 1 of 4 (p = 0.07) without the defaults; inside it the one control
mention at 1.00 held while its ten at 0.80 failed. A signal thin outside one
thought, worth an arm and not proven; 016 keeps every row at or above 0.50 and
sorts by the value, so what the model knows of its own false positives is
recorded and never read.

*Edges:* the hedge marks nothing useful. As graded the hedged edges held more
often than the control (12/17 against 5/17), but 15 of the 17 are one thought's
— SMD-1731's body: eleven "SMD-1731 `uses` <component>" edges at 0.90, eight
held and three not (`Mutant`, `linear.app`, and `preflight check`, 0 where
`test-schema` in the same list is 1), and four `related_to` at 0.80, all held —
and the other two held 0 of 2.
The eight rest on reading "the ticket `uses` a component it changes" as held;
strictly they are 0 and the hedged bin is 4/17, level with the control. Either
way no signal. The finding on edges is the control: 1.00 edges hold 29% of the
time (Wilson 95% 13–53%; the mention control's 80% is 55–93%).

*Pooled,* the two-bin table is flat (p = 0.45) because the kinds run opposite
ways; the ticket's pooled question would have answered "noise".

**Limits.** 64 rows; one grader, blind to the value but not to the fork; the
hedged strata clustered on six thoughts (mentions) and three (edges); a strict
rule on type. The grades stand as given blind; re-grading the calls the
grader marked borderline — `migration 021` and `Edge0` read as held, the
control's `Jev per-type gates` and `PR #119` as failed — leaves the mention
finding at 3 of 15 against 10 of 15 (p = 0.025); `actor_name` read as held
would strengthen it; two more control calls a strict reader might question
(`check-fork-consistency check 20`, `canary`) take it to 3 of 15 against 8 of
15 (p = 0.13). The control's held rate is the 1.00 stratum's precision with
the interval fifteen or seventeen rows give. Another prompt version or model
is another experiment — the fixture is that run's rows, and a brain that
lacks them says so in a note.

**Held.** `bun eval-calibration.ts --self-check`: a sound grades fixture has no
problems; the grades key a claim as the live report does, the edge by relation
name; a graded mention and edge resolve by the hand grade and an ungraded one
stays unresolved; with no grades nothing resolves, as before; a missing label,
a bad id, an upper-case id, a row that is not an object, a stated value out of
range or not a number, an outcome that is not 0/1, a mention or an edge graded
twice, a bad edge end and a relation off the vocabulary or not an integer are
each refused by name, once, and a fixture that is not an object is a problem,
not a throw; a graded mention in
the brain is resolved and scored on the extractor's row with an ungraded one
beside it; a graded claim the brain lacks is counted in a note that an ungraded
claim does not offset, and with every claim present or no grades at all there
is none; the committed file holds 64 rows, 30 mentions and 34 edges, 15 and 17
of them below 1.00. Mutants that each fail it: the join dropped (2 probes), the
edge keyed by index instead of name (3), the missing-claims note dropped (1),
the count as a subtraction (1), an edge's `to` unchecked (1), a numeric string
(1) or a negative (1) accepted as stated, upper-case ids admitted (1), the
labels unchecked (2), the non-object guard dropped (the self-check throws,
exit 1), and the duplicate check skipped for edges (1). `tsc` clean; check 9
passes the fixture; the live report on the dogfood brain reproduces the table
above.

**Not taken.** An elicitation arm — a prompt change is the ticket's item 1
proper and its own measurement, on the windowed prompt SMD-1879 merged to main
the same day (PR #113), now that this grade says which kind it is worth on.
Dropping the column —
the grade says the mention value carries a signal. A `reason` per grade in the
fixture — check 9 admits no free string but the three labels, so the reasons
are in this record and on the ticket. Grading the 1.00 stratum whole — 9,551
rows; the control estimates it. A second grader.

**Review passes.**

| pass | finding | caught by | fix |
| --- | --- | --- | --- |
| 4 | the merge of main (683c4ce5): the five files preserved line for line (diff-of-diffs and an independent merge-tree replay; the one conflict FORK.md's index), the index a fixed point, `RELATIONS` and the parser's 0.50 default unchanged by SMD-1879's landing, the two sections placed once, every touched CI step green on the merged tree with commitlint (two warn-level `caught-tag`s on review-pass "not taken" bullets) and actionlint 1.7.7; the dogfood brain's `@p1` and `@p2` rows sum to the 9,835 SMD-1879's section counts | diff-of-diffs + run-it (independent reviewer) | nothing to change |
| 3 | "hedged" stood for the whole below-1.00 bin with the parser's two 0.50 defaults inside it, unsaid, while the robustness numbers leaned on those rows (leave-one-out 1/5 is 1/3, p = 0.19, without them); "the re-grade that cuts hardest" was a superlative two more control calls disprove (3/15 against 8/15, p = 0.13); the grading rule was stated three ways, the code docblock's loosest | definitions pass over pass 2's hunks + recomputation (independent reviewer) | the bin defined as stored and the numbers given with and without the defaults, the claim softened to "worth an arm"; the borderline criterion named and the further flips given; one rule verbatim in the fixture, the code, the README and here |
| 2 | pass 1's re-grade bound (3/15 against 10/15) did not follow from the calls the sentence named — `preflight check` is an edge, and `actor_name` read as held moves the control the other way — and its by-thought rule as written gives 11/15, not 12/15 (the dominant thought counts once per bin); the record called SMD-1879 unmerged after it merged to main the same day; a duplicate edge in the fixture was unprobed; a row that is a string was read as an empty object; the probe's "not an index" was met by one of its two cases | cold read of pass 1's hunks + recomputation + mutants (independent reviewer; the stop signal) | the bound's flips named and the rule stated per bin; `preflight check` moved to the edges; the 1879 sentences corrected; a duplicate-edge and a string-row probe, every expectation naming its line |
| 1 | the record's arithmetic for the 0.80 mention failures summed to 14 (the two 0.50 `PostgreSQL` rows counted twice); the dominant thought's hedged edges were called "a 0.90 list" (11 at 0.90 and 4 at 0.80) and the edges' "other way" p rested on a lenient `uses`; the mention headline's Fisher p treated ten rows of one thought as independent; the mutant counts in the record were one high (the FAILED summary line counted); a `missing = size − size` mutant, an unchecked edge `to`, a numeric string and a negative stated value and unchecked labels all survived the self-check; a fixture that is not an object threw; an upper-case id would validate and never join; the opening docblock still counted three resolvers | cold read + recomputation from the graded rows + mutants (independent reviewer) | the breakdown corrected; the edges' p dropped and the strict reading given (4/17); leave-one-out, by-thought and within-thought numbers added, and the borderline calls named with the re-grade bound; the counts corrected; the probes widened (an ungraded mention beside the graded, every rule refused by name, null and non-object inputs); ids lower-case only; the sentence corrected |

**Follow-ups.** SMD-1982's Work item 1, for mentions, on SMD-1879's prompt:
first the arm that asks for a reason below 1, scored by this fixture and the
labelled captures. The 29% held rate of 1.00 edges is SMD-1925 and SMD-1937's
finding, not a confidence one. SMD-1873 is the judge's side of the same question.

**Upstream status.** Not upstream: upstream has no entity confidence to grade.
