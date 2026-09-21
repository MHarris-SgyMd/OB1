# 44. The read tools print the thought id, so `update_thought` and `delete_thought` can reach what a search found (SMD-1248)

`search_thoughts` and `list_thoughts` rendered human-readable prose with no id
in it — `search_thoughts` a `--- Result N (x% match) ---` block, `list_thoughts`
a `N. [date] (type - tags)` line and the content. The id was on every row (the
store selects it, and the ChatGPT-compat `search` tool returns `{id, title,
url}`), but the two tools an agent actually reaches for to find a thought never
emitted it. Upstream files this as
[#457](https://github.com/NateBJones-Projects/OB1/issues/457), where it is only a
citation annoyance because upstream has no edit or delete. **Here it disables two
of our own tools:** we added `update_thought` and `delete_thought` in migration
009 and both take an id, so a thought found by search could not be edited or
deleted at all — the caller had to fall back to the compatibility tool meant for
ChatGPT citations. `capture_thought` was already given its id back for exactly
this reason; the comment there says so in as many words. The reasoning was
applied to the write path and not the read path.

**An `ID: <uuid>` line per hit**, in both renderings — a prose line, the smaller
of the two shapes the ticket weighed (JSON, as `search` uses, would rewrite the
whole output and the prose assertions in `test-e2e-sql.ts`), costing ~40
characters against a budget `search_thoughts` already manages with its `limit`
and truncation note. The label and placement follow the tree's own precedent:
**`search_thoughts_keyword` already prints `ID: <uuid>` in its result header**,
and it shares `search_thoughts`'s exact `--- Result N ---` block — so
`search_thoughts` prints the id the same way, in the header group, and the three
read tools now read alike. `list_thoughts`'s compact format has no header group,
so its `ID:` line trails the item. `list_thoughts` did not carry the id at all
(`listThoughts` selected `content, metadata, created_at` in both stores and
`ThoughtListItem` had no `id`), so the column was added to the two `SELECT`s and
the shared type; `search_thoughts` already had `t.id` from the hybrid match.
`update_thought` and `delete_thought` descriptions (and their `id` argument) now
name where the id comes from — before this they described an id with no reachable
source. (The ticket suggested a *trailing* `id:` line; a first review pass moved
it to the header and cased it `ID:` to match `search_thoughts_keyword`, since the
divergence between three sibling read tools was a worse cost than the ticket's
literal wording.)

**Verified.** `test-e2e-sql.ts` gains a walk that could not be written before:
capture a thought, find it through `search_thoughts`, `update_thought` aimed at
the id the search printed, then a search that shows the edit; then `list_thoughts`
→ `delete_thought` for the other read tool, asserting the id is the same one
search returned. The existing prose assertions — zero-hit, absent-literal,
truncation, the compat pair — all still hold (69 assertions pass). Store
conformance (`test-store-sql`, 62) and the server unit suite (71) stay green;
`tsc --noEmit` is clean.

Upstream status: #457 open; a citation-only issue there, a disabled-tool issue
here. **Unfiled.**
