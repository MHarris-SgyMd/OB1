# 465. Priority operations over REST and MCP: set_priority, clear_priority and priority_history in the shared contract (SMD-3664)

**Why.** Migration 116 (SMD-3663) gave the brain priority assertions in SQL, but no client could reach them. An operator who tells Claude Desktop "the passport renewal is urgent, due March 1" had no tool to record it. Every client reaches the brain through the REST core or `/mcp`, so the operations belong in the shared contract (SMD-2133's rule).

**What changed.**
- **Three tools** in the manifest (`tools.ts`), with their specs (`core/schemas.ts`), the operations (`core/priority.ts`), the calls, the routes and the MCP words. `tools.json`, the OpenAPI document and the rest-client are regenerated. Each tool addresses an item by `kind` (thought, ticket, entity, or item for an open item) and `key`, in the REST path.
  - `set_priority`: `POST /v1/priorities/{kind}/{key}`, capture scope. It takes a level and optionally `due_at`, `not_before`, `due_ref`, `reason` and `inferred`. A date alone is the start of that day in UTC. It answers `{outcome: asserted|unchanged, assertion, replaced, winner, winnerShown}`.
  - `clear_priority`: `DELETE /v1/priorities/{kind}/{key}`, capture scope. It answers `{outcome: cleared|nothing_to_clear, assertion, winner, winnerShown}`.
  - `priority_history`: `GET /v1/priorities/{kind}/{key}`, read scope. It answers `{item, exists, level, winner, history}`, read in one statement.
- **The scope rule.** The two writers are in the capture group, so both a write key and a capture-only key reach them. That follows docs/priority.md's decision 10: a capture-only key may state a priority on a thought it captured, and 116 refuses it anything else. The store states the key's scope in the envelope it passes (`write` or `capture`), which 116 requires and the server's actor carried only for a capture key. A capture-only key is never shown the winner (`winnerShown: false`, and no word of one), and gets no read tool.
- **Refusals are values:**
  - `ITEM_NOT_FOUND` (404) names the item as 116 keys it, and whether it was the item or the due reference. `priority_history` gives it for an item the brain doesn't hold and nobody stated a priority on.
  - `ITEM_NOT_YOURS` (403) is a capture-only key on another key's item. It is answered alike whether the item exists or not.
  - `REFUSED_PRIORITY_INPUT` (400) is an argument 116 refuses by its rule, with the rule's `problem`.
  - `READ_ONLY_KEY` (403) is a read key's principal reaching a writer through a caller of the core's own.
- **Store:** `assertPriority`, `clearPriority` and `priorityRecord`. Each is one bind-parameter statement. A 22023 is `PriorityRefused`, and any other raise is a fault. The normalisers throw on an outcome, code, tier or kind 116 doesn't give.
- **Preflight:** a `priority` row. It checks 116's five functions under their signatures (a fail when one is missing) and the server role's priority grants (a soft warning naming each write it lacks), and skips before 116.
- **The capture surface grows.** A capture-only key's tools are `capture_thought`, `set_priority` and `clear_priority`.
  - test-auth and test-e2e-sql pin those three, still with no read tool.
  - The session-capture hook's `--check` takes them as a capture key's, rather than warning that the key "can also" use them. Its suite holds a capture key with the priority writers, and the drop-the-fix mutant fails there.
- **Docs:** server-portable/README.md gets a Priority assertions section, and db/README.md's 116 paragraph names the operations.

**Narrowed from the ticket.**
- **No `holder` argument.** docs/priority.md's "Not decided here" leaves a holder other than the maker waiting for a case: the maker is the key.
- **The writers are in the capture group, not the write group.** The ticket's own Verify has a capture-only key's set refused on a writer's thought, which decision 10 and 116 make a rule of the database rather than of the tool list.
- **No plugin row's key.** Decision 8 has a plugin state a priority on the open item its row is represented by, so it waits on SMD-3665, as `kind: "item"` does.

**Held.**
- test-rest-sql [11], through both doors on Postgres:
  - **The ticket's three Verify cases:**
    - a set over MCP and the history over REST name the same assertion, maker, trust and tier;
    - a read key's set is refused (403 FORBIDDEN, and no such tool over MCP), and so is a capture-only key's set on a writer's thought (403 ITEM_NOT_YOURS), with the same answer for a thought that isn't there;
    - the history's MCP reply is the REST answer rendered, and an `unchanged` set and a `nothing_to_clear` clear are one reply through both doors.
  - **And beyond them:**
    - a capture-only key's own thought, with no winner shown;
    - an agent's statement outranked and kept;
    - a replace and a clear in the history;
    - 116's argument rules, by `problem`;
    - an unknown thought, ticket, due reference and open item, and an unknown item's history.
- test-server [35]:
  - each reply's and refusal's words;
  - another key's reason held to one quoted line;
  - a refusal's value keeping the item's key;
  - the normalisers' faults, and `priorityProblemOf`'s mapping.
- test-preflight: the row's ok and missing-function cases, and the soft grant warning for a role without the group.
- test-mcp: the tools' order. test-client: each tool's input through the generated client.
- **Eight mutants**, each failing on the check that names its mechanism:
  - the envelope stating no scope;
  - a capture-only key stated as a write key;
  - `set_priority` in the write group;
  - the history answering an unknown item;
  - `winnerShown` always true;
  - a ticket key not upper-cased;
  - the guard dropping an item's key;
  - the due reference not told apart.

  A date read as the start of its day in UTC is not one: the test database's time zone is UTC, where the cast agrees.

**Review pass 1** (10 findings, 9 fixed, one in part):
- A capture-only key whose agent id the registry couldn't give was told its own thought was another's (`ITEM_NOT_YOURS`, final), and clearing found nothing. 116 proves a capture key's thought by that id alone. Both writers now answer `PRIORITY_UNATTRIBUTED` (503) before the call: retryable with Retry-After when the registry is away, and final when it is set up wrong, as the claims tools' `CLAIM_UNATTRIBUTED` is.
- A malformed `due_ref.key` was blamed on the item's key: 116 raises the same words for both. With a due reference given and an item 116 can key, the refusal's `problem` is `due_ref`.
- Whether `ITEM_NOT_FOUND` meant the item or the due reference was read from 116's wording. It is read from the brain now: a held item means the due reference was the one missing.
- The item a refusal named was normalised in TypeScript, a copy of 116's that drifted: a zero-width space 116 strips was kept. It is keyed by 116's own `ob1_priority_item`, read on the refusal's path alone (a new store call, `priorityItem`).
- keygen's output, `auth.ts`'s header and the hook's README still said a capture key gets `capture_thought` and nothing else, and that a leaked one cannot alter anything. They say what it gets now.
- Preflight's grant query guarded `has_table_privilege` with an `OR`, whose order Postgres doesn't keep. It is a `CASE` now, as the write-privileges row's is.
- Preflight's list of the group's grants was a copy of `db/config.mjs`'s. It reads `ROLE_GRANTS.priority` now.
- The schema capped a reason at 1000 UTF-16 units, below 116's 1000 characters for an astral text. It caps the request at 4000 units, and 116 holds the characters.
- The guard's ticket-key branch was dead: a ticket key is a token already.
- In part: `priority_history` aggregated an item's open statements twice, through `priority_of`'s list. It reads the winner by the rule's own function (`ob1_priority_winner`) beside one aggregation, and preflight checks the helpers it calls.

Held:
- test-rest-sql [11]: the registry set up wrong and unreachable; a zero-width space; a missing item beside a due reference; a malformed due reference.
- test-server [35]: the new refusal's words.
- Five mutants, one per fix, each fail on their own check.

**Review pass 2** (10 findings, all fixed):
- A due time the schema takes and Postgres can't cast (a year 0000) was a 500. The store reads the cast's SQLSTATEs as `REFUSED_PRIORITY_INPUT`, problem `time`.
- Pass 1's "which was missing" read the item's existence after the call, so an item written in between turned the item's absence into the due reference's. Both are read now: it is the due reference only when it isn't held and the item is.
- A plugin hook's principal (`hook:<plugin>`, capture scope, no agent id by design) was always refused `PRIORITY_UNATTRIBUTED`, with words telling an operator to fix the registry. Only a key whose registry lookup failed is refused so; a hook is 116's to answer.
- `clear_priority` refused a capture key without its envelope id. But 116 finds a key's statements by the registry's id for its name, so the clear works, and the refusal is gone.
- The refusal path read the item, and the due reference one after the other, before looking at the code. Each branch now reads what it names, at once.
- The hook's `CAPTURE_SURFACE` sat between `BRAIN_TOOLS` and its doc comment. It goes above.
- Pass 1's fallback for an unreadable item key was a copy of 116's normalising. A failed read is the call's fault now.
- The item kinds were two lists, store.ts's and the schema's. One module, `priority-kinds.ts`, holds them.
- store-sql.ts: a missing space in its import line, and `toVector`'s doc comment, which had drifted above another function, moved back.
- The local `scopeOf` shared `tools.ts`'s name for another question. It is `writerScope`.

Held:
- test-rest-sql [11]: a year 0000; a capture key's clear with the registry set up wrong; a plugin hook's principal answered `ITEM_NOT_YOURS`.
- Three mutants, each failing on its own check.
- Not held by a test: the ordering race, which needs a write between two statements.

**Review pass 3** (10 findings, 8 fixed, 2 declined):
- Pass 2 let a capture key's clear run without its envelope id, and 116 finds the key's statements by the registry's id for its name. A key renamed since the registry last saw it is found by neither id, though, and the clear answered "nothing to clear" for a statement still open. A clear that closes nothing while the registry lookup failed now answers `PRIORITY_UNATTRIBUTED`; one that closes a statement stands.
- Preflight's grant warning said `priority_history` fails for a missing write. It names the calls each missing grant breaks.
- A NUL character in `reason` or `key` reached Postgres, whose 22021 was a 500. The schema refuses it.
- The row reader let a missing `asserted_at` through as a null, and a malformed due reference as none. Both throw, and the tier's name is 116's own `tier_name`, held to the four.
- SETUP.md, the GUI's sign-in page and the OAuth consent page (`brain:capture`) still said a capture key gets `capture_thought` alone. They say it may rank its own thoughts too.
- The two refusal branches each spelled out the same lookup. It is written once, and run when one of them needs it.
- Preflight named `ob1_priority_json`'s argument type unqualified, resolved through the role's search_path. It is `public.priority_assertions`.

Declined:
- Reading which argument 116 found missing from its words again, or changing 116 to return it. Pass 1 moved off its words on purpose. A change to 116 is a migration of its own. And the reads it would save are on the refusal path alone.

Held:
- test-rest-sql [11]: a clear that closes nothing while the registry is set up wrong; a NUL character.
- test-server [35]: the reader's three new refusals.
- test-preflight: the warning's calls.
- Three mutants, each failing on its own check.

**Tidied while the files were open.** The two refusals core/priority.ts built in several places are a helper each, its own `asked` replaces a hand-rolled catch, the clear's reading of an unattributed key sits beside the clear, `historyLine` beside its siblings, and two of store.ts's doc comments are brought level with pass 1 and 2.
