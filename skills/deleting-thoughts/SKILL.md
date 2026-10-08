---
name: deleting-thoughts
description: |
  Use when asked to delete, remove, purge, wipe, or "get rid of" an Open Brain
  thought, or before calling delete_thought (a tool of the core Open Brain
  connector, registered for a write key), which deletes with no undo tool. Also use when tempted to delete a
  thought that is merely outdated or wrong. To edit or deprecate instead of
  removing, see updating-thoughts.
author: Ezana Azene
version: 1.1.0
---

# Deleting Thoughts

## Overview

`delete_thought` (on the core Open Brain connector, for a write key) performs a
**permanent delete** — the row and its search chunks are gone the moment it
returns, with no soft-delete and no restore tool. The audit trail keeps the
previous content, so an operator can reconstruct a thought removed in error;
nothing you can call undoes it. The
Open Brain maintainer's stance is **"deprecate and version rather than
delete."** So deletion is a last resort, and every delete must target an id you
verified this session.

**Violating the letter of these rules is violating their spirit.**

## When to Use

Delete only when **both** hold:
- The thought is genuinely disposable — a test/throwaway, an exact duplicate, or
  an accidental capture, **and**
- Editing or tagging it is not good enough.

If the thought is merely outdated, wrong, or superseded, **update it or tag it**
`superseded` instead — see the **updating-thoughts** skill.

## Process

1. **Resolve the id via `search_thoughts` / `list_thoughts`.** `delete_thought`
   takes a UUID; never delete an id you typed from memory.
2. **Show the target and confirm.** Surface the thought's content to the user
   and get explicit confirmation that this specific thought should be removed.
   - **Check for derivatives first.** Before deleting, run `find_derivatives`
     on the thought where the provenance-chains recipe's tools are connected.
     (The delete itself refuses only a thought whose statements other thoughts
     cite; it does not look at `derived_from`, so derivatives are yours to check.) If other thoughts were derived
     from it, deleting orphans their provenance chain — those derivatives lose
     the source they point back to. Prefer deprecating over deleting in that
     case. Tool names may carry a connector prefix; use whatever the environment
     exposes.
3. **Delete only after confirmation.** Call `delete_thought(id)` and report its
   reply to the user. If it refuses because statements in other thoughts cite
   this one as their source, tell the user which (the reply names them) and ask
   again before calling it with `detach_citations: true`.

## This Is Irreversible — No Exceptions

- No undo, no trash, no restore tool. The audit trail is for an operator, not a way back.
- Don't batch-delete "to clean up" without confirming **each** id.
- Don't delete when the user said "update", "fix", "archive", or "deprecate" —
  those are updates, not deletes.
- Don't guess a UUID; a wrong guess deletes the wrong memory permanently.

## Red Flags — STOP

- About to call `delete_thought` on an id you did **not** get from a search this
  session.
- Deleting more than one thought from a single vague instruction.
- The user's word was "clean up / tidy / archive / outdated" — not an explicit
  "delete".
- You have not shown the actual content to the user and gotten confirmation.

**All of these mean: pause, search, show the thought, and confirm first.**

## Rationalizations — and Reality

| Excuse | Reality |
|--------|---------|
| "It's obviously junk." | Show it and confirm anyway — "obvious" is exactly where wrong deletes happen. |
| "Faster to delete than to tag." | Speed never justifies an irreversible loss. Tag or deprecate instead. |
| "The user probably meant this one." | Probably ≠ confirmed. Resolve the id and show it. |
| "I'll just re-capture if it was wrong." | Re-capture loses the original metadata, embedding history, and provenance links. |

## Output

The core's reply names the deleted id and says its previous content is kept in
the audit trail (and, with `detach_citations`, what was detached). Always report
it, with the content you showed at confirmation, so there is a record of what
was removed.

## Notes

- Connector: the core Open Brain connector. It lists `delete_thought` only for
  a write-scoped key; a read or capture key does not see the tool at all. (The
  standalone `delete-thought-mcp` server retired with SMD-1931.)
- Every delete is recorded in the brain's audit trail with the previous
  content, and the delete refuses a cited source unless `detach_citations` is
  true.
