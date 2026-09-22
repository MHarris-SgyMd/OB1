# 50. The chunk limit follows the model's window, not a constant — captures over 4096 tokens windowed at 1200 under the default, 1200/1200 for a 2048-token model (SMD-1305)

`server-portable/chunk.ts` split a capture into overlapping windows once its
estimate passed `DEFAULT_MAX_TOKENS = 1200`, one constant for every model. The
constant had a reason — Ollama embeds a request in one batch, the default batch
is 2048 tokens, and the tokenless estimate needs headroom under it — and the
reason did not apply to the default model. `qwen3-embedding:4b` embedded the
longest LongMemEval session, 19,544 estimated tokens, whole (`prompt_eval_count`
18,919; the 0.6b the same), so the load windowed 15,743 of 19,829 sessions the
model would have embedded in one piece: 56,267 chunk rows, 2.12× the tokens,
about seven of the 13.9 hours. At the other end, `granite-embedding`'s window is
512, so its 1200-token windows were being cut silently — the failure the windows
exist to prevent.

**Measured, not asserted** — and without a reload. A load with no windows writes
the same whole vector (the same text under the same model and prompt; checked on
40 random rows per model, cosine 1.000000 to a fresh embedding, alone or batched),
so the store's whole vectors *are* that load. `evals/eval-longmemeval.ts` with
`OB1_EVAL_LME_ARMS=windows` fetches every thought in a question's history with its
whole-vector similarity and its best window's in one exact scan and ranks each
arm as a rule over those two numbers; a `windows` phase embeds windows at another
limit into a side table so a second window size could be scored beside the
shipped one. Strict recall_all@5, 470 questions:

| | no windows | 1200-token windows above 1200 (shipped) | 1200-token windows above 4096 (derived) | 4096-token windows above 4096 | tokens embedded |
| --- | --- | --- | --- | --- | --- |
| qwen3-embedding:4b | 88.7% | **89.6%** | **88.9%** | 88.7% | 1.00× / 2.12× / 1.29× / 1.25× |
| qwen3-embedding:0.6b | 86.6% | 87.9% | 87.4% | 86.8% | |

Every point the windows buy sits above 2048 estimated tokens and most of it
above 4096, where the whole vector alone loses 1.8 (4b) and 3.6 (0.6b); the
windows alone score 85.5%, so the whole vector is the signal and the windows a
complement. And **window size matters where coverage does not**: 4096-token
windows over the same 2,615 long sessions bought nothing. The synthetic tail test
(`eval-longctx.ts`, now with `OB1_EVAL_WINDOWS`) is 4/4 for both models with or
without windows and cannot see any of this.

**The rule.** `db/config.mjs` carries `KNOWN_MODEL_WINDOW` beside
`KNOWN_MODEL_DIMS` — the tokens each model embeds in one request, measured by
`prompt_eval_count`; a hosted model has no entry until it is measured, since a
document states the model's maximum and not the serving provider's — and
`resolveChunkTokens` derives two numbers at the shipped ratio (1200 of 2048):
the estimated length a capture is windowed above, capped at
`MAX_WHOLE_TOKENS = 4096` where the whole vector was measured to stop holding,
and the window size, never above 1200. A 2048-token model gets 1200 and 1200,
exactly what it had. `granite-embedding` gets 300 and 300, with the overlap
scaled to 37 (the review pass found 150 against a 300-token window carried
nothing). The qwen models window
only past 4096, at 1200 a window: under the 4b 88.9% against the shipped 89.6%
(three questions in 470), 94.9% against 94.9% at k=10, for 61% of the tokens and
a quarter of the chunk rows — about five hours of a fourteen-hour import. A model
the table does not know keeps 1200 for both. **Upgrading a store changes nothing
already written**: a row's 1200-token windows stay (022 keeps them while the
label vouches for the vector), an edit through `update_thought` regenerates
them under the rule (none for a 3,000-token thought), and the own-key re-embed
pass skips rows already at the model — so the chunk table does not shrink until
a backfill pass, `bun reembed.ts --url $DATABASE_URL --job reembed:<model>@<dim>:window`,
regenerates every row's windows. A mixed store in the meantime is scored by
`match_thoughts`' best-of as before; the eval's 2049–4096 row puts the cost of
windowed distractors beside an unwindowed gold at one question. `OB1_CHUNK_TOKENS` still sets both,
so the shipped behaviour is one variable away. `chunkContent` takes the threshold
apart from the window size; `embed.ts` resolves the rule through `config.mjs` so
the server, `reembed.ts` and preflight cannot disagree about it; preflight's
`chunk window` line prints the rule and its source, and warns when an explicit
limit is over the model's window or over the headroom under it (the ratio the
constant fixes). Found in passing: `chunkContent`'s segmenter
read the default limit rather than the caller's — invisible at 1200, wrong either
side of it.

The price of the default is two or three questions in 470 on a corpus of
2,600-token sessions, stated as such in `evals/README.md` with the caveats (two
models, one corpus, the cap is one number, 600- and 2,000-token windows
unmeasured). Verified by `test-thoughts` [7] (the rule per model, the override,
the chunker's threshold) and `test-preflight` [3b] (the five lines); all suites
green.

Upstream status: **not applicable** — the windows are the fork's own (change 007
and after). **Unfiled** upstream.
