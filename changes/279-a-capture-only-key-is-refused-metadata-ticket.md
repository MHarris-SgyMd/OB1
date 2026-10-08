# 279. A capture-only key is refused `metadata.ticket` (SMD-2657)

**What changed.**
- **The refusal.** `ticket` joins `TICKET_META_KEYS` in `core/refusal.ts`, after `issue`, so a key that cannot read is refused it as it is the other four (SMD-2617): `REFUSED_METADATA_SHAPE`, problem `ticket_key`, the key named, before either model call, at both doors.
- **The words.** The refusal's text and the tool's description of `metadata` name the five keys from the same constant. They now call them the keys "a ticket's lifecycle is read from", not keys that state it, since `ticket` files a thought under a ticket rather than stating its status. The text changes for all five keys.
- **The Chrome capture extension** (`integrations/chrome-capture-extension/lib/api-client.js`) drops `ticket` from a capture's metadata with the other keys the server refuses, so a platform's own `ticket` is left out rather than refusing the capture. `test-rest` holds its list to the server's.

**Why.** 068's `node_lifecycle` joins a thought to its ticket head on `coalesce(metadata->>'ticket', metadata->>'issue')`. 071's dependency read and 079's pairing exclusion read the same `coalesce`. SMD-2617 refused `issue` but left `ticket`, reading it as harmless on the key's own row. It was not: a write key's capture of text that is already a thought merges onto that row (`old || new`), and the key's `ticket` survived the merge. SMD-2638's review pass 1 showed it on the real server. The capture key captured a live ticket's text with `ticket` naming a done ticket. A write key then captured the same text stating the live ticket. The row became the live ticket's head, but read the done ticket's status, and `prefer_current` ranked it ×0.25. Without the `issue` facet, the writer's plain thought read done the same way. `db/ingest-items.ts`' `CROSS_SOURCE_FACETS` already refused `ticket`, because `node_state` reads a row carrying it as that ticket's.

**The other keys, checked.** Every metadata key `node_lifecycle`, `ob1_ticket_heads_of`, 071's dependencies, 077's `ticket_references_settled`, 079's pairing, board-sync's grouping and watermark, and `brain_info` read, at their latest definitions:
- `issue`, `status`, `status_type` and `linear_updated_at` were already refused, and now `ticket` is too.
- `source` is set only through the `source` argument, and its one lifecycle reader, 071's `source_thought`, reads it only beside `issue`.
- `topics` and `action_items` are reserved: the extractor sets them from the text, which the "Ticket keys in the text" bullet below covers.
- `project` and `labels` are read by board-sync only on the row holding a group's newest watermark. A capture-only key cannot set one. A write key's later watermark on its row only makes the next pass refetch the ticket and patch those keys over.
- No metadata key holds a dependency: the links come from `thought_facets` and `thought_sources`.

**Before upgrading.** Nothing to apply; the server alone. The session-capture hook sends no `ticket`. A capture-only caller that sets `metadata.ticket` is refused: drop or rename the key, or give it a write key.

**Held.**
- `test-e2e-sql` [13d], on the real server:
  - a capture key's `ticket` is refused like the other four, the key and the five named in the text, the key in the structured reply;
  - the ticket's repro: the key's squat on a done ticket is refused, and once a write key's capture of the same text, stating the live ticket, has merged onto the key's row, that row is the live ticket's head and reads started and open, and the done ticket still reads done;
  - without the `issue` facet: the key's squat on a plain text is refused, and a writer's plain capture of the key's text, landing on the key's row, reads no ticket's status.
- `test-rest-sql` [6]: a capture key's `ticket` is a 400 naming `ticket_key` and the key.
- `test-rest` [2]: the description names each key, read from the constant.
- The drop-the-mechanism mutant (`ticket` out of the list): the refusal cells and both repro legs fail, the merged row and the writer's plain thought reading the done ticket's `completed`. The check inverted to apply to keys that can read, and the repro without the writer's merge, fail too.

**Review passes.**

| Pass | Finding | Caught | Fix |
|---|---|---|---|
| 1 | the repro's plain-thought leg never tried `ticket` on its text, so it passed with the fix removed | run-it | the key's squat on it first, refused; its own assert |
| 1 | the record called `source` reserved, said 071 and 079 join the head, gave `ingest-items.ts` a reason it does not give, said a capture key's row can never hold the watermark and that nothing else changed for any key; the refusal's "read through" fitted two keys of five | cold read | reworded |
| tidy | the repro's two squats checked unevenly (one without the problem), an ambiguous "key of its own", a run-on comment in `core/writes.ts` | cold read | one helper for both; reworded |

**Not taken.**
- **Rows that already carry a capture key's `ticket`.** No migration clears them. A row from before SMD-2638's scope mark does not say which key's scope wrote it, and a write key may have set the same value since. Newer rows could be told apart, but no client sent `ticket` through a capture-only key; the session hook never did.
- **Ticket keys in the text.** 077 also reads ticket keys from a thought's content, and a session header makes one central. A capture-only key can still name a ticket in its text. This is not a metadata key, and the session hook's own summaries rely on it.
- **`text_refused_by`.** Board-sync writes it on a ticket's head when another thought holds Linear's text, and clears it once the head holds the text. A caller's value naming that holder only spares the write. It does not touch the lifecycle.

**The version.** PATCH: a capture-only key's `metadata.ticket`, accepted before, is refused now, and the refusal's text for the other four keys reads "one of the keys a ticket's lifecycle is read from". Nothing else changes.
