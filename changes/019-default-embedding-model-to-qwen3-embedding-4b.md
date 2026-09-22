# 19. Default embedding model → `qwen3-embedding:4b` at 1024 dimensions

Measured best on a real corpus: **0.903 MRR against `embeddinggemma`'s 0.873 over
441** real issues with full descriptions and comment threads, and the only local
model that embeds a long capture whole. Costs ~5x the embedding latency and 2.5 GB.

Those figures replace 0.933/0.914 and "~3x", measured over 97 issues that had been
silently truncated to ~500 characters at ingestion. The ranking survived and the
ranking survived; the latency multiple did not — see fix 25.

**This is a breaking change for an existing install.** The width moves from 768 to
1024, so it needs a schema migration and a re-embed of every row. `preflight.ts`
refuses to serve against a mismatch rather than letting search quietly degrade, so
an install that skips this fails loudly. Staying put is a supported choice — set
`OB1_EMBEDDING_MODEL` and `OB1_EMBEDDING_DIM` explicitly and nothing changes.

Two things had to be built first, and the second is why this was not a one-line
change:

- **Truncation is now automatic for known-MRL models.** `qwen3-embedding:4b` is
  2560 dimensions natively, above pgvector's 2000 HNSW ceiling, so the default
  would otherwise refuse every capture. `OB1_EMBEDDING_DIMENSIONS` still defaults
  to off for anything not in `MRL_MODELS` or of unknown native width — the opt-in
  exists to stop silent truncation of models never trained for it, and that
  property is unchanged.
- **Asymmetric prompting.** Qwen3-Embedding is trained to see queries and
  documents differently, and the server had one code path for both. Prompted it
  scores 0.933; bare, **0.860** — worse than the model it replaces. Switching the
  default without this would have been a regression dressed as an upgrade.
  Both numbers are from the 97-issue corpus and this pair has not been re-run on
  the rebuilt one; the ordering is not in question, the absolute values are old.
  Templates live in `db/config.mjs` keyed by model, so changing model changes
  prompt and preflight's existing model-change check already covers it.
  `embeddinggemma` gains 0.002 from its own format and nomic's prefixes measurably
  hurt, so neither is listed — the table is per-model, not global.

`scripts/check-fork-consistency.mjs` now fails if `deploy/compose.yaml`'s
`${VAR:-fallback}` values drift from `db/config.mjs`. Compose substitutes those
before the process starts, so a stale fallback silently overrides the code default
rather than deferring to it.

## Considered and not built: a second retrieval tier

An LLM reranker over the embedding search's top-5, escalated only when the cosine
margin says tier 1 is unsure. Measured well when tier 1 was `embeddinggemma`:
86% → 91% Recall@1 on 97 real issues, five queries fixed, **none broken**.

Re-measured after the default moved to `qwen3-embedding:4b@1024`, it no longer
justifies itself. Tier 1 alone now reaches 90%, the reranker adds three points
rather than five, and it is no longer regression-free — against a stronger embedder
it demotes a correct answer, because it sometimes knows less than the embedder
does. Worse, `qwen2.5:7b` in that role takes Recall@1 *down* two points, so the
feature is only correct with an 18 GB model resident alongside the embedder.

Three points for a 15x latency increase and a footgun is not a default. The
harnesses stay (`evals/eval-cascade.ts`), so a corpus that behaves differently can
re-derive it. Full numbers in `evals/README.md`.
