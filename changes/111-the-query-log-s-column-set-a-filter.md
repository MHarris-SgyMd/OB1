# 111. The query log's column set: a filter that is finally written, the arm that served a query, and the tier that wrote it — over one search operation (SMD-1490)

034 (SMD-1295) gave `query_log` a `filter jsonb` column and threaded it end to
end, but all three search tools passed `filter: {}` unconditionally — no tool
exposed a filter — so the column was permanently empty, a field nothing wrote.
The root cause was structural: `search`, `search_thoughts` and
`search_thoughts_keyword` each did the same thing by hand — gate the query,
embed it, call the store arm, log the call — and that copy-paste is why the
filter was dropped in three places and why keyword search was never logged at
all.

**One search operation, three adapters.** The handlers now share `runSearch`,
which owns the policy that was duplicated: the egress gate before a query leaves
for its embedding (SMD-1903, on the hybrid arm — a keyword search embeds nothing,
so nothing leaves the box), the arm dispatch, the metadata filter, and the
query-log write with the filter, the arm and the tier on it. Each tool is a thin
adapter that maps its external interface in and renders its own output:
`search_thoughts` keeps its needle facts and superseded labels,
`search_thoughts_keyword` its occurrence counts and paging, and the ChatGPT-compat
`search` stays a fixed query-only shape (it pins every knob and exposes none —
the shape ChatGPT connectors match on). A shallow filter argument — top-level
keys to a scalar or an array of scalars, bounded by `parseFilter` — keeps
`metadata @> filter` GIN-indexable and the row-level-security cost of exposing it
(SMD-1625) bounded rather than open-ended; a nested object is refused at the
boundary, not handed to jsonb.

**The column set (migration 045).** `filter` is now populated from the tools'
argument. `arm` records which retrieval path served a search row — `hybrid`
(the vector arm fused with the exact-literal arm, 017) or `keyword` (exact
substring, 012); `tool` names the MCP tool, `arm` names the path, so a per-arm
report (SMD-1735/1737) can group across tools and tell two arms of one tool
apart. `tier` records which pipeline tier's server wrote the row — `stable`,
`canary` or `working`, from `OB1_TIER`, NULL for a plain brain — the column
SMD-1806's canary tier needs to tell a stable-written row from its own; the
server (not just the ingester) now declares `OB1_TIER`, forwarded by
`deploy/compose.yaml` (check 14). Keyword searches are logged from here on —
034 logged only the semantic path — so the log covers all retrieval. Additive
and idempotent: two nullable columns with enumerated CHECKs, no change to 034's
or 043's comments or constraints, no index (the log's hot-path work is SMD-1492).

**Upstream status:** not sent — upstream ships no query log, no tiers and no
egress gate; the filter, the arm and the tier are the fork's.
