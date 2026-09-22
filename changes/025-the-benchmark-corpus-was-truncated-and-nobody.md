# 25. The benchmark corpus was truncated, and nobody knew

Every retrieval number this fork published came from `/tmp/linear-corpus.json`, a
file built ad hoc in a session nobody kept. Inspecting it turned up two defects.

**Truncated at ~500 characters.** Documents topped out at 483, 80 of 97 sat in the
400–490 band, and **78 of 97 did not end on sentence punctuation** — SMD-775 cuts
off mid-clause at "More importantly, the". A cap had been applied at ingestion and
nothing recorded it.

**No comments.** Fields were `id`, `title`, `text`, `labels`. On a real tracker
the decision and the pushback live in the thread, not the description.

Both narrowed the conclusions more than they looked. `qwen3-embedding:4b` was
chosen partly as "the only local model that embeds a long capture whole" — on
inputs where that cannot show. And nothing reached the 1200-token chunking
threshold, so migration 007's `thought_chunks` had no real documents to work on:
an artifact of the truncation, not a property of Linear issues.

`evals/build-linear-corpus.ts` replaces it, fetching full descriptions plus
comment threads over Linear's GraphQL API:

| | old | new |
| --- | ---: | ---: |
| documents | 97 | 441 |
| chars p50 / p90 / max | 446 / 447 / 483 | 810 / 2,789 / **15,812** |
| with comments | 0 | 131 (318 total) |
| over the 1200-token chunk threshold | **0** | **15** |

Re-running the head-to-head changed one number that mattered and confirmed
another:

| | old (97, truncated) | rebuilt (441) | rebuilt, ≥120 chars (423) |
| --- | ---: | ---: | ---: |
| qwen3-embedding:4b | 0.933 | 0.903 | **0.914** |
| embeddinggemma | 0.914 | 0.873 | **0.894** |
| gap | 0.019 | 0.030 | **0.020** |
| latency | "~3x" | ~5x | **~5x** (106.8s vs 20.5s) |

The ranking survived, so the default stands. The latency claim did not: "~3x" was
measured on 500-character stubs and the real multiple on full documents is about
five. Corrected in `db/config.mjs`, `SETUP.md` and above.

**The third column is the interesting one, and it cost me a conclusion.** On the
441-document build the gap looks like it doubled, 0.019 → 0.030, and the obvious
reading is that the long-capture advantage finally showed up. It did not.
Eighteen documents are under 120 characters — three of them 3, 15 and 21 — and a
body that short cannot encode its own title, so those queries are unanswerable by
construction. They were the top three misses for **both** models. Excluding them
gives a gap of 0.020, indistinguishable from the truncated corpus's 0.019:
`embeddinggemma` simply handles degenerate rows worse, and that read as a margin.

So the honest summary is duller than the first draft of this section. Fixing the
corpus did **not** reveal a hidden advantage for the bigger model. It confirmed
the ranking, corrected the latency claim by a factor of nearly two, and left the
"embeds a long capture whole" argument exactly where it was: an argument from
architecture, unsupported by measurement. Which is worth writing down, because
the exciting version was live in three files for about an hour.

Both absolute scores fell, and that is arithmetic rather than regression: ranking
one document first out of 441 is harder than out of 97. **The two sets are not
comparable in either direction.**

Only that head-to-head was re-run. The prompted-vs-bare finding (0.933 against
0.860) and every extraction number are still old-corpus and are now labelled as
such where they appear — kept because those gaps are far too large to be
artifacts, flagged because the absolute values are stale.

Three things the builder does deliberately:

- **Keeps the title out of the document text.** `eval-real.ts` uses the title as
  the query, so including it would place the query verbatim inside its own answer
  and inflate every score. The old corpus got this right; it would have been easy
  to lose.
- **Refuses to write inside the repository**, independently of `.gitignore`. This
  repo is public and the corpus is internal healthcare-company engineering data.
  `.gitignore` only protects patterns someone remembered to add, and a committed
  corpus is not a mistake you undo in the next commit.
- **Never prints a credential.** `evals/env.ts` loads keys from a gitignored
  `.env` and reports which files it read and which key *names* each supplied. A
  loader that echoes values puts secrets in a scrollback, then a CI log, then a
  screenshot.

One caveat carried into the new numbers: `eval-real.ts` embeds whole documents and
Ollama's default batch is 2048 tokens, so the 15 documents above it are silently
cut at embed time. Both models suffer it equally so the comparison holds, but the
long-document tail is under-measured — the exact failure `chunk.ts` exists to fix,
appearing inside the benchmark that measures it.
