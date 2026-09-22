# 31. GraphRAG, measured — and not built

`evals/eval-graphrag.ts` and `evals/graphrag-questions.json` (Linear SMD-948).
No migration, no server change, no new tool: this change is a measurement and
the decision it supports. The ticket asked whether retrieval over change 30's
entity graph beats the vector search the product ships, warned that GraphRAG's
published wins are on corpora unlike ours, that community summaries are a
standing cost, and that a measured "not worth it at our scale" would be a
successful outcome. It is the outcome.

**The question set came first**, as the ticket required, so the graph was
judged on questions written without it: 27 over the 441-issue Linear corpus,
each answered by two or more documents, labelled by hand from the issue bodies
— seventeen multi-hop, seven aggregation, three about the shape of the corpus,
89 expected documents. Only the questions are committed; the corpus is internal
and stays in `/tmp`. The metric is retrieval, did the expected documents come
back in the top K, because any answer is generated from what came back.

**Five arms, no framework.** Vector (`match_thoughts`); a local graph walk
written in one SQL statement over `ob1_entities`, `thought_entities` and
`ob1_entity_edges` — question entities found by the extraction prompt, the
product's resolution rule, trigram similarity and a whole-word literal match
(more generous than the product's rule, on purpose), IDF-weighted, one hop at
0.3 with the same rarity cap on hop targets, thoughts ranked by summed entity
weight; reciprocal-rank fusion of those two;
global mode — label-propagation communities over co-mention weights, one
generated summary each, question matched to summaries, thoughts of the best
two communities vector-ranked; and `search_thoughts_keyword` (change 26) with
the needle a person would type, on the ten questions that have one. The graph
is replayed from a dumped extraction pass, so the eval does not repeat the
two-hour extraction; the pass scored here was re-run after the review pass
below so that the dump's fingerprints verify against the loaded text.

**Vector wins every comparison.** Recall@10 0.98 and 25 of 27 questions
complete, every multi-hop question among them; the local graph 0.51 and 7,
losing on 20 questions and winning on none; fusion 0.92 and 21 — mixing the
graph in makes vector worse on five questions and better on none; global 0.50,
half the baseline and near zero on the corpus-level questions. At K = 5 the
order is the same and the gaps are wider. The reasons are in
`evals/README.md`: the question-side and document-side extractions do not
agree on names; 1,739 of 2,004 entities are mentioned once, so a hop reaches
nothing; common seeds
dominate until removed and removing them leaves recall unchanged; communities
depend on the node visiting order (18, 6 and 17 from the same graph until the
order was pinned to the table's unique key). A review pass found the first
version of the harness generous to its own conclusion in small ways — MRR taken
over the whole returned list, a substring seed match that read "Expo" out of
"exposes", hubs re-entering through the hop, an unordered title list feeding
each community summary — and fixing them moved the graph arm by a point or
two and the global arm from 0.25–0.33 to 0.57 on the first dump (0.50 on the
re-extracted one). The same pass found the corpus loader hashing the wrong
text for its fingerprints — `'\s+'` in a Bun `sql` template literal reaches
Postgres as `'s+'` — in this harness and in the entity eval it was copied
from; both call `content_fingerprint_of()` now, and the corpus was
re-extracted so the dump verifies. The decision did not move.

**The set was too easy for vector, and that is the finding, not a flaw in the
set.** Documents about one feature in a tracker share vocabulary — the backend
issue and the client issue consuming it name the same endpoint and field — so
the documents a multi-hop question combines are already near neighbours of the
question. GraphRAG earns its cost where documents are joined by an entity and
nothing else; on this corpus those questions were hard to find, which is
itself the answer to whether the corpus is the kind that needs a graph.

**Where vector misses, keyword mostly has it.** The only misses are two of the
six `Decision:` records and two of the eight `Promote …` issues, both series
named by a literal string; `search_thoughts_keyword` returns the first set
complete and half of the second, scored by the same rule as every arm. The
headroom that exists is a ranking problem inside a tool that ships, not a case
for a graph.

**Decision: not built.** No graph retrieval mode, no fusion step, no build
ticket. The entity layer stays for what it is for — "what does X connect to",
an entity filter, the UI a graph makes possible — and because a corpus of a
different shape, people and projects across many sources with little shared
wording, could measure differently. That is a re-run of `bun run graphrag`
against that corpus's own question set, and the rule for reading it does not
change: the graph has to beat `match_thoughts` on questions someone actually
asked. SMD-1039 asks that question of a literature corpus with a published
question set, where the failure mode these techniques target does exist; a
win there is a reason to re-ask the product question on a corpus of the
product's shape, not a reason to build.
