---
name: session-summary
description: |
  At the end of a work session with Open Brain connected, write ONE summary
  thought — what was asked, what was decided, what changed, and the ids of
  the thoughts the session retrieved as its provenance — through
  capture_thought with derived_from and source. Fires when the user wraps up
  ("wrap up", "we're done", "capture this session", "summarise the session"),
  when a PR is merged or a task is closed, or when the conversation is about
  to end and a decision or a shipped change has not been written down.
author: Michael Harris
version: 1.0.0
---

# Session Summary

## Problem

Capture in Open Brain happens one thought at a time, when an agent chooses to
call `capture_thought`. A session that searched the brain six times, made a
decision and shipped a change leaves nothing behind unless someone says "write
it down". The next session starts from search results, not from the conclusion.

This skill is the agent's half of the fix: one considered summary at wrap-up,
with the retrieved thoughts named as its sources. The
[`session-capture-hook`](../../recipes/session-capture-hook/) recipe is the
floor under it — a hook that derives a mechanical summary whether or not the
agent wrote one. Install both: the hook never misses, the skill says more.

## Trigger Conditions

- The user wraps up: "wrap up", "we're done", "park this", "capture this
  session", "summarise the session", "what did we decide".
- A milestone closes: a PR is merged, a ticket moves to Done, a release is cut.
- The conversation is ending and a decision, a measurement or a shipped change
  made in it is not yet in the brain.

Do not fire on a session with nothing to record (a question answered from the
brain and nothing decided), or when the user has said not to capture.

## Process

1. **Collect the ids.** Every Open Brain search result printed an `ID:` line;
   every capture answered with `id <uuid>`. Gather the ids of the thoughts you
   actually read or built on — not every result that scrolled past. If you
   captured thoughts during the session, include their ids too.
2. **Write the summary** as one thought, in prose a stranger can use later:
   - **Asked** — what the user wanted, in one or two sentences.
   - **Decided** — each decision and the reason; what was declined and why.
   - **Shipped** — what changed: PR or commit, ticket, the rule or number that
     moved. Name files only when the reader must go there.
   - **Open** — follow-ups filed, questions left.
   Lead with the decision. Keep it under about 300 words. No transcript, no
   tool output, no file contents, no secrets — if a credential appeared in the
   conversation, it does not appear here.
3. **Capture it** with `capture_thought`:
   - `content` — the summary.
   - `derived_from` — the ids from step 1. The server validates each; an id it
     does not know refuses the capture, so pass only ids you saw printed.
   - `source` — the harness: `claude-code`, `codex`, `cursor`, or the client's
     name in that shape (lower-case, digits, hyphens).
   If a summary for this session already exists (you captured one earlier and
   the session went on), pass its id as `supersedes` instead of writing a
   second one.
4. **Confirm** in one line: the id, how many sources it names, and that it
   supersedes an earlier summary if it does. Do not paraphrase the summary back.

## Output

One thought in the brain per session, retrievable by what the session did,
whose `metadata.source` names the harness and whose `derived_from` names the
thoughts the session read — so the `trace_provenance` SQL function (migration
025) walks from it to them, and `find_derivatives` from any of them answers
"which sessions used this". Both are database functions, not MCP tools; a
search result marks a superseded hit.

## Notes

- **Provenance is the point.** A summary without `derived_from` is a note; with
  it, it is a record of how the brain was used, which is what a later
  consolidation pass and the memory-utilization report read.
- **The hook and the skill coexist.** When both run, the session has two
  summaries: the agent's considered one and the hook's mechanical one, each
  naming the same sources. That is fine — they are different kinds of thought,
  and the hook's `source` lets a reader weigh them apart. If you want one,
  YOUR summary can `supersede` the hook's (your key can read and write); the
  hook's capture-only key may supersede only what it wrote itself, so it
  cannot replace yours. Pass the hook's id as `supersedes` only when you are
  sure of it.
- **A capture-scoped key cannot run this skill** — it has no search. The skill
  runs under the session's own key; the hook runs under its capture key.
- **Other clients.** Cursor, Windsurf or a ChatGPT connector with the write
  tools can use this skill as written; set `source` to the client's name.
