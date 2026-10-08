---
name: updating-thoughts
description: |
  Use when editing, correcting, rewriting, re-tagging, re-classifying, or
  annotating an existing Open Brain thought — "update that note", "fix the
  thought about X", "add a status/tag to it", "mark it superseded". Uses the
  update_thought MCP tool (on the core Open Brain connector, for a write key). Not for
  creating a new thought (that is capture) or removing one (see
  deleting-thoughts).
author: Ezana Azene
version: 1.0.0
---

# Updating Thoughts

## Overview

`update_thought` is one of the core Open Brain MCP server's tools, listed for a
write-scoped key. Choosing *how* to update is the non-obvious part: tagging and rewriting
behave and cost differently, and the tool acts on a thought's **UUID**, which
it will not look up for you.

## When to Use

- Correcting or rewriting a thought's text
- Re-classifying or tagging it (status, review flags, cross-references)
- Annotating it without touching the wording

Not for: creating a thought (use capture), or removing one — if the thought is
outdated or wrong, prefer updating or tagging it `superseded` over deleting
(see the **deleting-thoughts** skill).

## Process

1. **Resolve the id first.** `update_thought` takes a UUID, not a description.
   Use `search_thoughts` / `list_thoughts` to find the target and confirm it is
   the right one. Never guess a UUID.
   - **Inspect before editing.** Before you overwrite anything, read the target's
     full content with the connector's `fetch` tool, and search for what it
     relates to — so you don't clobber context other thoughts depend on. Tool names may carry a connector prefix; use
     whatever the environment exposes.
2. **Pick the mode:**
   - Tag / re-classify only → pass `metadata_patch` (shallow-merges keys; leaves
     content and unmentioned keys alone; **no re-embedding**).
   - Change the wording → pass `content` (replaces the text **and re-embeds** so
     semantic search stays accurate).
   - Both → pass both; they compose in one call.
3. **Guard read-modify-write (optional).** If you read the thought, reasoned,
   then write back — and other writers may exist — pass `if_unchanged_since` set
   to the `updated_at` you read. If the row changed underneath you the write is
   refused — the reply begins `Refused:` and says the thought changed after the
   `if_unchanged_since` you passed (the REST core's code is
   `REFUSED_STALE_READ`); re-fetch and retry.

## Quick Reference

| Goal | Field | Re-embeds? |
|------|-------|-----------|
| Add/change tags, status, links | `metadata_patch` | No |
| Rewrite the note text | `content` | Yes |
| Prevent a lost update | `if_unchanged_since` | — |

`metadata_patch` is a **merge, not a replace**: `{"status":"done"}` adds or
overwrites only `status` and leaves everything else in the metadata intact.

## Output

A confirmation naming the thought id, what changed (content replaced and
re-embedded, and/or metadata merged), and the new `updated_at`.

## Common Mistakes

- Using `content` just to add a tag — wastes an embedding call; use
  `metadata_patch`.
- Expecting `metadata_patch` to replace the whole metadata object — it merges.
- Skipping the search step and passing a half-remembered UUID.

## Notes

- New text that is already another thought's is refused (`Refused: that text already exists as another thought`; `REFUSED_DUPLICATE_CONTENT`): edit one of the two, or delete the other first.
- Connector: the core Open Brain connector, with a write-scoped key (a read or
  capture key does not see `update_thought`). The standalone
  `update-thought-mcp` server retired with SMD-1931.
