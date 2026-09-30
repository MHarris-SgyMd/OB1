# 227. The propose→decide spike: a deterministic entity proposer and the three-shape comparison — the hybrid (generative proposes, decider decides) wins (SMD-2017)

**What it adds (eval-only; no schema, contract or default change).**

- **`server-portable/propose.ts`** — a pure proposer (no LLM): channels for identifier/quoted-literal tokens (migration 017's `extract_search_needles` rules), capitalised proper-noun runs, citation author-refs (`X et al., YEAR`), organisation-suffix runs, and an n-gram gazetteer of known names; every candidate pre-filtered through the entity name gate's `refusalOf()`.
- **`evals/eval-propose-recall.ts`**, **`eval-propose-coverage.ts`**, **`eval-hybrid.ts`** — the proposer's recall ceiling against the labelled gold, its coverage of the extractor's entities on fork content (leave-one-out gazetteer), and the 7B-proposes-decider-decides comparison.

**What it measured.** The proposer *sees* ~9 in 10 entities (containment ~89%) but exactly reproduces 67–78% (the gap is span boundaries). The hybrid keeps the generative model's recall and gains the decider's typing/validity; pure propose→decide sacrifices recall. Verdict: build the hybrid in the write path (follow-up), which also puts the decider's calibrated confidence where a tri-state admission gate can read it.
