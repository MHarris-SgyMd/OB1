# 26. Keyword search — `search_thoughts_keyword`, and why not tsvector

Migration 012 (Linear SMD-944). Retrieval in this fork was purely semantic:
`search_thoughts` and the ChatGPT-compat `search` both call `match_thoughts`,
`list_thoughts` filters on `metadata`, `fetch` is a lookup by id. Nothing matched
the literal text of `thoughts.content`, so a caller who knew the exact string —
an error code, a ticket key, a commit SHA, a symbol name — had no way to ask for
it.

**The gap, measured.** `evals/eval-keyword.ts` takes tokens that appear in
exactly one document *by substring* and are identifier-shaped, over 441 real
issues, and asks both instruments where the containing document lands.
Embeddings from `qwen3-embedding:4b` with the server's own query prompt:

| instrument | R@1 | not in top-10 | MRR |
| --- | --- | --- | --- |
| vector (`qwen3-embedding:4b`) | 10% | 37/60 | 0.201 |
| keyword (`search_thoughts_keyword`) | 100% | 0/60 | 1.000 |

The keyword row is 100% **by construction** and proves nothing on its own — every
query is unique to one document, so a correct substring search cannot do worse.
It is there to show that the vector row is not. Sliced by what the token looks
like, because the first run's deepest misses were all slash-joined English words
(`disabled/replaced`, `UI/API`) and letting those carry the headline would have
been flattering:

| shape | n | R@1 | not in top-10 |
| --- | --- | --- | --- |
| digit or underscore — `SMD-506`, `temporal_activity` | 27 | 7% | 16/27 |
| slash or dot — `UI/API`, `db/config.mjs` | 28 | 7% | 19/28 |
| interior capitals — `getUserById` | 5 | 40% | 2/5 |

The first row is the case the issue is actually about, and it is no better than
the weak one. The embedding ranked `additional_notes` 277th of 441.

**Substring, not tsvector — and that is the decision, not an omission.**
`schemas/enhanced-thoughts` answers this with `to_tsvector` plus an ILIKE
fallback. Measured against the queries this feature exists for:

| query | tsvector | ILIKE |
| --- | --- | --- |
| `upsert_thought` | hit | hit |
| `ERR_POSTGRES_SERVER_ERROR` | hit | hit |
| `PGRST202` | hit | hit |
| `SMD-944` | hit | hit |
| `PGRST` inside `PGRST202` | **miss** | hit |
| `9543c29` inside `9543c29ab` | **miss** | hit |

tsvector is better than a first guess suggests: `websearch_to_tsquery` turns an
underscored identifier into a *phrase* query, so "we upsert the thought later" is
correctly not a hit for `upsert_thought`. It handles four of six, with ranking,
boolean operators and a far smaller index.

It is still wrong here, because everything it matches, it matches at token
granularity — and token-granularity word overlap is the closest thing to what the
embedding already does, and does better. The capability keyword search uniquely
adds is exactness and sub-token reach. Choosing tsvector spends a new subsystem,
and a second GIN index with a second per-capture write cost, on the half of the
problem that was already covered.

What that costs, stated rather than left to be discovered: no boolean operators,
a multi-word query means literal adjacency, and no relevance ranking beyond
occurrence count and recency.

**Escaping is a correctness issue, not a detail.** `_` and `%` are ILIKE
wildcards, and `_` is the most common character in the identifiers this exists to
find. Unescaped, `ILIKE '%upsert_thought%'` also matches `upsert-thought` and
`upsertXthought` — a tool whose contract is exactness returning approximate rows
with no signal. That raised a question nothing had answered: can pg_trgm still
extract grams from a pattern containing `\_`? It can — `db/bench-keyword.ts`:

| rows | first call | index used in 12 more | equivalent query |
| --- | --- | --- | --- |
| 1,000 | seq | 12/12 | Seq Scan |
| 10,000 | index | 12/12 | Bitmap Heap Scan |
| 100,000 | index | 12/12 | Bitmap Heap Scan |

The twelve extra calls exist because plpgsql may switch to a **generic plan**
after five executions of the same statement, built without knowing the pattern.
If one ever chose a sequential scan the function would be fast five times and
then far slower for the rest of the session — a regression no single-shot timing
can see. It does not happen. The 1,000-row row disagrees with itself,
reproducibly, and that is fine: below the crossover both plans cost 2.9 ms, so
the planner is entitled to pick either and does.

**Not trimming the query is also a correctness issue,** and the test suite found
it rather than the design. An earlier version trimmed the needle, so searching for
`SMD-944 ` — trailing space deliberate, to exclude the longer key — silently
became a search for `SMD-944` and returned `SMD-9440` too. The needle is now
matched exactly as given; `trim()` appears once, only to reject an all-whitespace
query. The cost is that a pasted string with a stray space finds nothing, so the
tool says so when the query it was handed has one.

**A stable page boundary, and a test that did not test it.** Every `ORDER BY`
feeding `OFFSET`/`LIMIT` needs a unique final key or the sort is not total and
Postgres may order ties differently between the executions that fetch page 1 and
page 2 — duplicating one row and dropping another. Upstream's `ORDER BY rank
DESC, created_at DESC` has no unique key. Ours ends in `id`.

The obvious test for that — page six tied rows two at a time, look for repeats —
**passes with the tiebreak deleted.** At that size Postgres picks one plan and
returns ties in the same physical order every time, so the test confirms what you
hoped rather than excluding the failure. What discriminates is varying the *plan*
between pages: with a total sort order the result is plan-independent, without
one a bitmap heap scan and a sequential scan disagree. Measured over 400 tied
rows with `enable_seqscan` alternating — tiebreak removed: 2 repeats, 398 of 400
covered. With it: 0 and 400.

**`total_count` is the true count**, `count(*) OVER ()`, not upstream's capped
2000+500 reported as if it were a total. It is nearly free *here specifically*
because the ordering already materialises the whole match set: an unordered
`LIMIT` could stop early, a sorted one cannot. That was an argument until
`bench-keyword.ts` priced it — 0.51 ms with the window against 0.51 ms without,
at 100,000 rows.

**The default flip, with the unflattering half first.** `OB1_TRGM_INDEX` now
defaults to **on**, because the sole argument for off was "no core query can reach
it" and 012 is that query. Nothing about the cost changed: below ~10,000 rows the
index does nothing at all, and every capture pays ~70–95 µs and about as much
storage as the table. A small brain now pays that for no read benefit. It stays a
flag for exactly that reason — `OB1_TRGM_INDEX=off` before the first migration run
restores the old behaviour, and keyword search still returns the right rows
without it, by the sequential scan the planner would have chosen at that size
anyway. Above the crossover the trade is not close: 267 ms against 0.20 ms.

Every deployment that applied 011 before this change is now in the mismatched
state by default — the flag wants the index, the ledger says 011 is done, and no
index exists. `preflight.ts` says so on every boot, with the one statement to run.

**One instrument failure worth recording,** since §24 and §25 are both about that.
`bench-keyword.ts` establishes that the *function* uses the index by reading
`pg_stat_user_indexes.idx_scan` before and after the call — `EXPLAIN` of a plpgsql
function shows a Function Scan and nothing about what happens inside it. The first
version read the counter immediately and reported "index not used" at every scale,
while its own timing column said 0.59 ms for a query a sequential scan does in
267 ms. Statistics flush at most once a second. The two columns contradicting each
other is what caught it; a script that printed only the counter would have been
believed.
