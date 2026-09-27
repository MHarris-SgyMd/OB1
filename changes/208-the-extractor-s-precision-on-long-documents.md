# 208. The extractor's precision on long documents is now measured against a real labelled set, not the three-document planted one (SMD-1961)

**What changed.**
- **`evals/fixtures/longdoc-grades.json`, new.** 320 graded mentions — thought/entity ids + adjudicated `valid`/`type` + both graders' calls — inter-annotator κ 0.931. Ids and labels only (check 9); the corpus text is never committed.
- **`evals/build-longdoc-corpus.ts`, `build-grading-sheet.ts`, `adjudicate.ts`, `finalize-grades.ts`, new.** The labelling pipeline: select the longest thoughts, sample a blind name+context grading sheet, combine two blind graders + adjudication into the fixture. The sheet and key carry document text and stay out of the repo — the scripts regenerate them from the brain.
- **`evals/decide_entities.py`, `decide_entities_2d.py`, `decide_generative.ts`, `score-comparison.ts`, `analyze-graph.ts`, new.** Score typed-decision (decider-4b) and generative models on the set, on accuracy and time. Eval-only; no server or migration change.
