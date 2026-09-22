# 18. Long captures stay searchable — `thought_chunks`

A capture longer than the provider's per-request batch was embedded only in part.
The text was stored whole and `fetch` returned it whole, but `search_thoughts`
could not find the note by anything said in its second half — silently, with no
error on either the write or the search. Measured: a 4000-token note whose
conclusion is in its final sentence was retrieved at chance.

Migration 007 adds `thought_chunks`, and `capture_thought` now splits content
above `OB1_CHUNK_TOKENS` (1200) into overlapping windows and embeds each. Notes:

- **`thoughts` is untouched** — no new columns, so the core guard rail holds — and
  existing rows keep working with no re-embedding. Chunks are extra evidence, never
  a replacement.
- **Short thoughts write no chunk rows at all.** Both corpora measured in `evals/`
  average under 500 tokens, so the common case pays nothing.
- For chunked content `thoughts.embedding` became the *first chunk's* vector, not
  the whole content's, because embedding the whole thing would be an over-batch
  request that Ollama answers by silently truncating. **Superseded by change 27**,
  which measured the ceiling instead of assuming it and found the configured
  default reads a 15,812-character document whole. It is the whole-content vector
  again, best-effort, with the head window as the fallback.
- `match_thoughts` searches both tables and deduplicates to one row per thought,
  scored by its best evidence. Each side takes its own indexed top-K rather than
  scoring every row, because the obvious formulation cannot use an HNSW index.
- `ON DELETE CASCADE`, so a deleted thought cannot leave orphan vectors still
  answering searches.

`server-portable/test-chunking.ts` asserts the case that used to fail, with a stub
provider that *refuses* over-batch input rather than truncating it, so removing
chunking fails loudly instead of quietly regressing. Measured for real in
`evals/eval-chunking-e2e.ts` — the actual server against actual Ollama and
Postgres — where documents of ~4.6K and ~9.2K tokens go from 1/4 (chance) to 4/4.

Two gaps this closed on the way. The PostgREST store had **no test at all**, so
its RPC argument shapes were unverified until chunking added a fourth one;
`test-store-postgrest.ts` now covers it using `compat/supabase-sql` as the
fixture. That immediately found a real bug in the shim: a numeric array bound to a
`vector` parameter became a Postgres array literal, which pgvector rejects, so
**every** `.rpc()` call passing an embedding through the shim was broken.
