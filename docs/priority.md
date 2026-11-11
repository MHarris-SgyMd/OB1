# What matters: priority as a statement any key makes about any item, composed into an order a read can explain (SMD-3661)

An architecture decision record. **Proposed and accepted by the maintainer on 2026-11-02.** Two rows were changed from the draft: row 3's scale gained a sixth point, 5 critical, and row 8 retires the vendored `importance` rather than mapping it. A review the same day corrected three rules inside rows 2 and 5, and the maintainer confirmed them: the maker is the key, inheritance only raises, and a level-0 item takes no urgency. The maintainer also made overdue a +3 urgency term in place of a group of its own. It answers the questions SMD-3660's pieces share: what a priority is, which items carry one, one scale for every source, whose statement wins, and how a declared level, a deadline and an item's dependencies combine into one order. Nothing here is built. "Order" maps each decision to the ticket that builds it.

## Terms

- **Item:** anything a priority can be stated about. In this record that is a thought, a ticket, an entity or an open item (decision 1).
- **Assertion:** one statement that an item matters at some level, optionally with a due time, a start time and a reason, made by one key at one time (decision 2).
- **Level:** a point on the brain's one scale (decision 3). **Unknown:** no assertion counts for the item. That is not the same as Low.
- **Tier:** the rank of an assertion's maker when assertions disagree (decision 4).
- **Effective priority:** the order a read uses. It combines the winning level with the item's urgency and its structure, and every term is named (decision 5).
- **Source:** a system whose own priority field reaches the brain: Linear through board-sync, a plugin's table, a markdown note's frontmatter.

## Why

Asked "what is the highest-value unstarted issue?" on 2026-11-02, stable and canary both answered SMD-1853. It's a tracking parent with no code of its own, and it ranked first because its title matched the question's words. The live board's answer was SMD-2908 (High, and a v2.0.0 rider due before the 11-03 cut). Neither brain surfaced it. On 2026-10-14 the same question got SMD-2540 when the board said SMD-2888. Search ranks by meaning, and "what matters" isn't a meaning.

The brain has priority data, in four shapes, and no read ranks by any of them:

- **Linear's priority**, copied into `metadata.priority` as Linear's label by board-sync (`db/ingest-linear.ts:111`). Linear's due date isn't fetched (`ISSUE_FIELDS`, `:75`).
- **Upstream's `importance`**, a native column that `schemas/enhanced-thoughts` adds (`SMALLINT DEFAULT 3`, 1–5) or a metadata key. Vendored code writes it: the consolidation workers' model on 0–6 (`integrations/consolidation-workers/_shared/config.ts:106-108`), smart-ingest's and thought-enrichment's models on 1–5, and constants in two importers (x-twitter's 2, grok's 3). In Daemonic Brain, `db/weekly-digest.ts` reads it, from any row, whoever wrote it (SMD-2653). Vendored recipes read it too: lint-sweep (`recipes/lint-sweep/lint-sweep.js:427`, its views, and `db/config.mjs:2718`'s grant) and brain-health-monitoring (`ops-views.sql:41`). Nothing in Daemonic Brain's core writes it.
- **home-maintenance's own columns**, `priority` (low/medium/high/urgent) and `next_due` (`plugins/home-maintenance/migrations/001_home_maintenance.sql:29-30`). Nothing outside the plugin reads them. family-calendar keeps its deadlines the same way.
- **Action items**, `metadata.action_items`, a list of strings the metadata extractor writes (`server-portable/metadata.ts`). An action item has no identity or status, so none of them ever closes.

What the brain does rank by is lifecycle: `node_state` (058, 068) knows, per thought, whether it or the ticket it carries is open, blocked or superseded. SMD-2074 built it for ranking thoughts and left "which ticket do I start" to Linear: "partly duplicative of what Linear already does natively". That holds for one team's backlog. It doesn't hold for a brain's general case: a bill due Friday, a passport renewal, a commitment from a meeting, something the operator said matters. No tracker holds those items. Different makers at different trust state them, and they matter by date and by what depends on them.

## Measured

### Stable, 2026-11-02 (read-only counts on `open-brain-postgres-1`)

| What | Count |
| --- | --- |
| Thoughts | 2,928 |
| Ticket rows carrying `metadata.priority` (one per issue; = `ob1_ticket_head` rows) | 975 |
| ... unstarted (backlog, unstarted, triage): High / Medium / Low / Urgent | 4 / 150 / 248 / 0 |
| ... started: High / Medium / Low | 1 / 32 / 10 |
| ... closed (completed, canceled, duplicate) | 530 (3 of them "No priority") |
| Thoughts carrying `metadata.importance` | 0 |
| Thoughts carrying action items / action items in all | 1,282 / 5,067 |
| ... not from Linear: thoughts / action items | 595 / 2,461 |
| Thoughts carrying `dates_mentioned` | 2,453 |

So on the dogfood brain the only stated priorities are Linear's. `importance` is absent: stable runs none of the vendored code that writes it. Outside Linear, the general case's open work is 2,461 action items in 595 thoughts, none of which can close (the other 2,610 sit on ticket rows Linear already tracks), and 2,453 thoughts name dates that nothing reads as deadlines.

### The filter that works today

`search_thoughts` with `filter: {"status_type":"backlog","priority":"High"}` on board-sync's rows returned exactly the four High Backlog Open Brain tickets on 2026-11-02. It narrows the set, and inside it the order is still by meaning: SMD-2908 came 4th of 4, at 28% similarity.

### Defaults that look like statements

- **The vendored workers** store the first value present: the caller's number, else 4 for a structured capture, else the model's 0–5, else the default 3 (`integrations/consolidation-workers/_shared/helpers.ts:679`; `config.ts:42`, `:62`). A stored 3 or 4 can't be told apart from a default.
- **home-maintenance's** `priority` defaults to `medium` (`001_home_maintenance.sql:30`).
- **`schemas/enhanced-thoughts`'** `importance` column defaults to 3, and two importers write a constant (x-twitter 2, grok 3), so every row they write carries the same value whatever its content.

A source's default says nothing about the item, so decision 3 treats it as unknown.

## The decision

| # | Decision | Status | Instead of |
| --- | --- | --- | --- |
| 1 | **An item is a typed reference, `(kind, key)`**, with kinds `thought` (its id), `ticket` (its issue key, normalised as `work_claims.issue` is, 115), `entity` (its `ob1_entities` id) and `item` (an open item's id, SMD-3665). The write function checks that the item exists. There is no registry table and no foreign key. A plugin's row is not a kind: the plugin's item enters as an open item that names its row (decision 8). | Accepted (2026-11-02) | A node registry every item must enter first; a priority column on each table |
| 2 | **An assertion is an event:** kind and key, level, `due_at`, `not_before`, `due_ref` (another item whose due time it takes), reason, an `inferred` flag, the maker (stamped from `ob1.actor`, never from the call), and a valid window. **The maker is the key** (its agent id, else its name). The key's kind and trust are stamped on each assertion as they stood when it was written, and they set that assertion's tier, but they don't make a different maker. It is kept in an append-only table whose rows never change except to close their window. A new assertion by the same key on the same item closes that key's earlier one, whatever tier either was written at (a key reclassified since can still replace its own statement), and a clear closes it with none after. A projection holds each item's open assertions and its winner, kept current in the write's own transaction, with a drift check and a rebuild (068's pattern). | Accepted (2026-11-02) | Rows in `thought_audit` (the items aren't all thoughts); a mutable column; one current value with no maker |
| 3 | **One scale of six points plus unknown:** 0 none ("doesn't matter"), 1 low, 2 medium, 3 high, 4 urgent, 5 critical. **Unknown** (no assertion counts) is not low. **A source's default is not a statement:** a mapped value equal to the source's default, where the source can't tell a choice from a default, maps to unknown. The mapping table is below. | Decided (maintainer, 2026-11-02): six points, 5 critical, against the draft's five | The draft's five points (0–4, urgent at the top); upstream's 0–6 as the scale; Linear's five labels with "No priority" as low; a continuous score |
| 4 | **Whose statement wins, by tier, then newest within a tier:** (1) **operator**, an assertion at operator trust; (2) **source**, a key the operator has declared a priority source; (3) **agent**, an assertion at agent trust; (4) **inferred**, any assertion flagged inferred, and any assertion at ingested trust from an undeclared key. Every read lists the assertions it didn't pick. A maker may lower its own tier (flag `inferred`), never raise it, as 046's trust is a ceiling. | Decided (maintainer, 2026-11-02) | Newest wins whoever made it; the source of record always wins; an average |
| 5 | **The effective priority adds named terms in level units:** the winning level (unknown counts as 2 for ordering and is shown as unknown), or an **inherited** level, plus **urgency** from the due time, plus **unblocks**. **Overdue** is the largest urgency term, shown as a state of its own, not a group sorted ahead of the rest (+3 as decided on 11-02; +0.6 since SMD-4177's amendment, below). An item whose winning level is 0 takes no urgency term at all: a due time can't make it matter. An item whose `not_before` is in the future isn't startable. Inferred assertions count only once SMD-3670's agreement clears its bar. The weights are settings with defaults (below), tuned by SMD-3662's eval. Every read reports each item's terms. There is no model call in any read. **Amended (SMD-4177): level first.** The terms after the level are scaled to add at most 0.8 under the default weights (soon 0.4, week 0.2, overdue 0.6, unblocks 0.1 or 0.2), so they order items of one level and never lift an item past the next. A read's own weights may still make them cross a level. | Decided (maintainer, 2026-11-02), unknown as medium for ordering included; review corrections confirmed and overdue made a +3 term the same day. Amended by the maintainer on 2026-11-09 (SMD-4177, migration 127): level first, after both priority reads stopped at top-1 on 2 of 7 with an overdue unknown above an Urgent ticket | A lexicographic order (level, then due, then unblocks), where a Medium due tomorrow never passes a High with no date (declined 11-02; SMD-4177 adopts it in effect, keeping the terms as numbers); overdue items as a group ahead of the rest (the draft), where an overdue Low passed a Critical; one opaque score; a model ranking the list |
| 6 | **The brain never sets a priority by itself.** The extractor (SMD-3670) and sleep (SMD-3671) write tier-4 inferred assertions or findings. Accepting a finding makes the operator's own assertion. | Accepted (2026-11-02): follows SMD-2682's gate (the brain notices and tells; a person acts) | Sleep adjusting levels it judges stale |
| 7 | **A received thought's priority never ranks a local item.** A federated channel's assertion is stored at most at tier 4, and only about the received item itself. | Accepted (2026-11-02): follows SMD-3274 | Priorities shared across federated brains |
| 8 | **The old shapes:** `metadata.priority` stays as data that board-sync keeps writing, so today's filter keeps working, and reads use assertions. board-sync also asserts Linear's priority and due date at the source tier. **The vendored `importance` is retired.** No read uses it and nothing maps it. `weekly-digest.ts` stops reading it (the native column and the metadata key), which closes SMD-2653, and once SMD-3667 lands the digest reads the effective priority (SMD-3667 added the read; since SMD-4112 the digest takes each day and writer's share what matters most first). The vendored workers may still write the key, as data no read trusts. **A plugin keeps its own table** (SMD-1920's decision): it states a priority through `ctx.call("set_priority", …)` as its caller, on the open item its row is represented by. | Decided (maintainer, 2026-11-02): `importance` retired, against the draft | Mapping `importance` at tier 4 with its defaults as unknown (the draft); retiring `metadata.priority`; plugins writing assertions into the core's tables |
| 9 | **SMD-2074's scope is widened:** ranking tickets is in scope, as one kind of item among four. Linear stays the record of its own tickets' priority, and the brain never writes a priority back to Linear. An operator's assertion that differs from Linear's is the brain's own statement, and sleep reports the disagreement (SMD-3671). | Decided (maintainer, 2026-11-02) | Leaving tickets to Linear (SMD-2074 as written); syncing priorities both ways |
| 10 | **Who may assert:** a read key may not. A capture-only key may assert only on items it wrote, and never on a ticket, as it may not state a ticket's status (SMD-2617, change record 272). A write key may assert on any item. A key whose kind is `ingested` asserts at tier 4 unless declared a source. Declaring a key a priority source is operator-only, beside `set_agent_kind`. | Accepted (2026-11-02) | Priority as a free metadata key any writer sets (today) |

### The scale's mapping

| Source | 0 none | 1 low | 2 medium | 3 high | 4 urgent | 5 critical | Unknown |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Linear (`priorityLabel`) | – | Low | Medium | High | Urgent | – | No priority |
| home-maintenance `priority` | – | low | medium, when chosen | high | urgent | – | medium, the column's default, unless the plugin records that someone chose it |
| GitHub-style labels | – | P3 | P2 | P1 | – | P0 | none |
| Frontmatter `priority:` | `none` | `low` | `medium` | `high` | `urgent` | `critical` | absent; any other value (kept raw in the item) |

A source added later states its mapping and its default in SMD-3666's table, with a test row each: `server-portable/priority-scale.ts`, read by the ingestion pipeline, board-sync and the plugins, and held row by row by `bun db/ingest-records.ts --self-check`. Upstream's `importance` has no row: it is retired (decision 8). The draft would have mapped it, with a stored 3 or 4 as unknown, since either can be a default ("Defaults that look like statements").

### The composition's starting weights

| Term | Rule | Default |
| --- | --- | --- |
| Level | The winning assertion's level; unknown counts as 2 for ordering | 0–5 |
| From its open items | A thought that is no ticket's row, with no level of its own: the highest level counted on the open items opened from it, with no hop discount, since the item is its own to-do; and with no due time of its own, the soonest of theirs, an item at level 0 passing none. Only an open item counts (a proposed, done or dropped one gives nothing), and only its own counted level and due time, never what it inherits from the thought. Named `from_items`, with the item (SMD-4149, the maintainer, 2026-11-09; migration 125). It comes before Inherited: a level stated on what the note serves is one hop off, its items' is not. | no discount |
| Inherited | With no level of its own: the highest effective level among the items it serves (its parent ticket, the ticket a thought is about, an open item's origin thought; the spec it names once SMD-2683 adds one), minus 1 a hop, at most 2 hops. A served item's effective level is its stated level when it states one, so the walk goes past it only when it states none, and a settled served item passes nothing down (SMD-3667's review, maintainer 2026-11-06). It counts only where it is above unknown's 2, so linking an item to what it serves never lowers it. A stated level always beats it. A ticket and its own rows are one item: a row, read as a thought, reads as its ticket, and the statements on the ticket and its rows compete as one pool by decision 4's rule, each maker's newest alone (116's writers closing across them is SMD-4127). | −1 per hop |
| Urgency | From the winning `due_at`, or else `due_ref`'s: the referenced item's own winning `due_at` (else, for an open item, its own `due_at`; a referenced item since settled keeps its date), one hop only (its `due_ref` is not followed, and an item may not name itself); with neither, an open item's own `due_at`. Due by the end of tomorrow, or by the end of the seventh day, counted in calendar days in UTC: since SMD-3778 a bare date is due by the end of that day, so "tomorrow" is 24 to 48 hours away and a window in hours would miss it. Not for an item at level 0, nor a settled one. | +0.4, +0.2 (+2, +1 before SMD-4177) |
| Overdue | Its due time come, still open: in place of the urgency term above, and shown as overdue. Not for an item at level 0. | +0.6 (+3 before SMD-4177) |
| Unblocks | Open items it blocks through active `blocks` / `blocked_by` links, transitively to depth 3: at least 1, or at least 3. A blocker that is closed blocks nothing, and a closed item is neither counted nor walked through. | +0.1, +0.2 (+0.5, +1 before SMD-4177) |
| Inferred | A tier-4 statement (decision 4's inferred tier) isn't counted until SMD-3670's agreement clears its bar: the read lists it as passed over. Since SMD-3670 PR 1, a capture on a brain with `OB1_INFER_PRIORITY` on states one from its text: on the items the capture proposed, else on the thought, at most High, each half resting on a phrase the text holds. | off |
| Not before | Before `not_before` the item isn't startable: the agenda leaves it out, and search doesn't change | – |

SMD-3667 built this table as `effective_priority`'s weights (migration 122; SMD-4149 added From its open items in 125; since migration 128 the defaults are one function, `ob1_priority_defaults()`, and their largest sum `ob1_priority_span()`, SMD-4194; since migration 132 the brain's own are `ob1_priority_builtin()`, under the operator's setting, SMD-4193), each a setting a read overrides by name (`unknown`, `hop`, `hops`, `soon`, `soon_days`, `week`, `week_days`, `overdue`, `unblocks_one`, `unblocks_many`, `unblocks_many_at`, `depth`, `cap`, `count_inferred`).

**Level first (SMD-4177, the maintainer, 2026-11-09; migration 127).** An item's level decides its place: stated, read from its open items, inherited, or unknown's 2. Urgency, overdue and what it unblocks order items of one level and never lift an item past the next. They are 122's terms scaled by 0.2, so together they add at most 0.8 (overdue 0.6 + unblocks_many 0.2), and items of one level keep 122's order. A read can still pass 122's full-level weights by name. Since SMD-4193 PR 1 (the maintainer, 2026-11-10; migration 131) that is any caller of the agenda (MCP `agenda`'s `weights`, `GET /v1/agenda`'s `weights[name]=value`) or of `search_thoughts` beside `priority_weight` or `min_priority`, whose blend then divides by the span of those weights (`ob1_priority_span(weights)`), as well as SQL and the store. The weights hold for that call alone, and the answer names them. Since SMD-4193 PR 2 (the maintainer, 2026-11-11; migration 132) the operator sets the defaults every read takes, overriding the built-in weights by name: an operator key alone, through `set_priority_weights` (MCP, or `POST /v1/priority-weights`), `{}` clearing them; a call's own weights still override them. A setting is checked when written, kept as history when replaced, and shown by `brain_info`. One stored anyway that the check refuses fails the agenda and every ranked search, naming it, rather than order them by other weights; a search's priority labels and `plan_context`'s board then say only that they were not read. The built-in weights change only by a migration.

Why: under 122's weights an overdue note with no stated level (2 + 3 = 5) outranked an Urgent ticket that unblocks another (4 + 0.5), and an open item left overdue and never closed outranked every stated level below Critical for good. On SMD-3662's seeded set the operator's gold puts the Urgent ticket first, and both priority reads stopped at top-1 on 2 of 7.

On 2026-11-02's board SMD-2908 still comes first among the four Highs: 3 for High, plus 0.4 for urgency, if its `due_ref` names the v2.0.0 release and the release's due date is 11-03. A Medium bill due tomorrow (2.4) now stays below a High project with no date (3); under 122's weights (2 + 2) it passed it. An overdue Low (1.6) and an overdue Medium (2.6) both stay below a High with no date, and an overdue Medium no longer ties a Critical.

## The shape

### A statement over MCP

An operator in Claude Desktop says "the passport renewal is urgent, it's due March 1". The client calls `set_priority({kind: "item", key: <the renewal's id>}, 4, due_at: "2027-03-01")` (SMD-3664). The write function stamps the maker from the key and writes the assertion. The tier follows decision 4: source if the operator declared the key a priority source, else operator or agent from the key's trust, the same rule as `said_by` everywhere (SMD-1726). The function then closes this maker's earlier assertion on the item, if any, and updates the projection. `priority_history` returns both rows.

### A source

board-sync reads `priorityLabel` and `dueDate` for each ticket and asserts on `{kind: "ticket", key: "SMD-2908"}` at the source tier, because the operator declared board-sync a priority source. When the label changes in Linear, the next pass's assertion closes the last one. `metadata.priority` is still written as before.

### A plugin

home-maintenance's `maintenance_tasks` row becomes an open item when it's created (SMD-3665). A priority set through the plugin's own tool calls `ctx.call("set_priority", …)` as the tool's caller, so the tier is the caller's. A plugin hook runs as `hook:<plugin>`, a capture-scoped principal, so it may assert only on items it wrote.

### A read

`effective_priority(items, weights, now)` (SMD-3667, migration 122) returns, for each item, `effective`, its terms, `urgency`, `overdue`, `unblocks` and `inherited_from`. It is a read of its own beside `priority_of`, not new columns on `node_state` (the maintainer's call of 2026-11-05: `node_state` covers thoughts alone, and reshaping it would drop and recreate it under the reads built on it). Every term is computed when it's read. Search blends it in through `priority_weight` and filters through `min_priority` (SMD-3668). It does so over a window of the hybrid's matches, min(100, 4 × limit) as `prefer_current`'s is, with one read of the window's own thoughts. Each match reads its own effective priority, by the weights table's inheritance, never a ticket it only mentions. Every search, list and fetch result also carries a label: the known priorities of itself and of the tickets it is filed under or names, with their terms, from one read of the page (a ranked search's reusing its window's answers); a mention is labelled though it never ranks, and a settled item keeps its level and is said settled. `agenda` orders open, startable, unclaimed items by it (SMD-3669), leaving started tickets out unless asked (SMD-4162, migration 124). Each of these names the terms, the winning assertion and the ones it passed over. The weekly digest (`db/weekly-digest.ts`, SMD-4112) reads its window's thoughts and takes each day and writer's share what matters most first, a turn at a time, so a key stating Urgent on all its own captures still gets one row per day per turn (the maintainer, 2026-11-11). It lists its picks what matters most first, each prompt row saying why it matters; a brain before 122, or a read that fails, leaves the share by recency.

## What this reverses or amends

- **SMD-2074's scope note.** Ticket ranking was left to Linear. It is now in scope as one of four kinds of item (decision 9). The priority terms go in a read of their own, `effective_priority`, which takes all four kinds; `node_state`, which reads thoughts and the tickets they carry, is unchanged (SMD-3667, amended 2026-11-05).
- **SMD-2653's options.** Decision 8 settles it: the digest stops reading `importance` altogether, so no key's value of it steers the digest. That is close to the ticket's option 2, with nothing left to filter by key.
- **SMD-1920's "value/priority" field.** The plugin keeps its column, and the brain's reads see only what the plugin states through the core (decision 8).
- **SMD-2684's board section.** It takes the agenda's order (SMD-3669).
- **The agenda's one order.** SMD-4192 lets the client choose it (migration 129). `priority`, the default, is SMD-3669's. `due` lists the items with a due time first, soonest first, then the undated ones by priority, a stated None among them, for a question about deadlines. The board section keeps `priority`.

- **`operator-surface-tiers.md`'s "Not decided here"** listed the importance scale as non-core schema whose adoption is "a migration decision of its own", and **`operator-gui-dashboards-analysis.md`'s** open question 5 asked whether to drop importance or define one scale in core. This record answers both: the core gets this scale (SMD-3663's migration), and `importance` is retired. Each doc carries a note pointing here.
- **Vendored readers of `importance`.** Retiring it means no core read and no priority read uses it. lint-sweep and brain-health-monitoring keep their own reads until each is ported or retired (lint-sweep is on SMD-3216's shim list), and neither port may carry the read into the core.

## Order

1. **SMD-3662**, the eval and its baseline on today's main, can start now. It pre-registers the bar before any priority read is measured. **SMD-2653** can also land now: `weekly-digest.ts` stops reading `importance` and ranks by recency until the effective priority exists (decision 8).
2. **SMD-3663**, decisions 1, 2, 4 and 10 as a migration: the assertion table, the projection, `assert_priority`, `clear_priority`, `priority_of`, `priority_history` (every assertion on an item, closed ones included), and the source declaration.
3. **SMD-3665**, the open item, the fourth kind. It is decided by decision 1 and needed by decision 8's plugin path.
4. **SMD-3664**, the operations over REST and MCP.
5. **SMD-3666**, the sources: board-sync with due dates, the ingestion contract, frontmatter and plugins (decisions 3 and 8).
6. **SMD-3667**, decision 5 as `effective_priority` (built as a read of its own; see "A read").
7. **SMD-3668** (search) and **SMD-3669** (agenda), each measured by SMD-3662 before any default changes.
8. **SMD-3670** (inferred), **SMD-3671** (sleep's review) and **SMD-3672** (the GUI).

## Not decided here

- **A holder other than the maker.** Every caller holds a key or a sign-in the operator provisioned (`MCP_ACCESS_KEYS`, the authorization server's clients), so "whose priority" is the maker's, at the maker's tier. Priorities held for a team, or by one agent for another, wait for a case.
- **Inheritance through mentions.** A thought that only mentions an urgent project doesn't inherit from it. Only explicit links do (parent, spec, the ticket a thought is about). Whether mentions should count waits for SMD-3662's numbers.
- **The weights' final values.** The table above is a starting point. SMD-3662 tunes it, and SMD-3667 holds it as settings.
- **Recurrence.** A recurring task's next due time (home-maintenance's `frequency_days`) belongs to the open item (SMD-3665), not to the assertion.
- **Forgetting.** An assertion's reason is text and may hold personal data. `forget_thought` (SMD-1723) has to reach the assertions on a forgotten item. SMD-3663 names the rows, and SMD-1723 builds the reach.

## Related

- SMD-3660 (the program) and its children SMD-3662 to SMD-3672.
- SMD-2074, SMD-2061 and SMD-1994 (`node_state`); SMD-2271 (transitive freshness, the pattern for inheritance).
- SMD-3596 and SMD-3597 (work claims: held work isn't startable); SMD-2684 (`plan_context`).
- SMD-1726 and SMD-1724 (`said_by` and trust); 046 (the trust ceiling); SMD-1997 (`docs/event-log-as-truth.md`).
- SMD-2682 (the self-steering gate); SMD-3274 (federated trust); SMD-1920 and SMD-2311 (plugins).
