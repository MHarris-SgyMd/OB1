# Session Summary Skill Pack

> Teaches an agent to end a work session with one summary thought — asked, decided, shipped, open — captured through `capture_thought` with the thoughts it retrieved as `derived_from` and the harness as `source`.

## What It Does

The agent's half of session-end capture (SMD-1298). At wrap-up, or when a PR merges or a ticket closes, the agent gathers the `ID:` lines of the thoughts it read, writes a summary a stranger can use later, and captures it with provenance. The [`session-capture-hook`](../../recipes/session-capture-hook/) recipe is the floor under this skill: a hook that captures a mechanical summary whether or not the agent wrote one, under a capture-only key. Install both.

## Prerequisites

- Working Open Brain setup ([guide](../../docs/01-getting-started.md)) with the portable server at or after SMD-1298 (`capture_thought` takes `source`)
- A client that supports skills and has the brain's **write** tools connected (Claude Code, Codex, Cursor, or a ChatGPT connector on a write key) — a capture-scoped key has no search and cannot run this skill

## Installation

Claude Code:

```bash
mkdir -p ~/.claude/skills/session-summary
cp skills/session-summary/SKILL.md ~/.claude/skills/session-summary/SKILL.md
```

Codex and other clients: paste the body of `SKILL.md` into the client's skills or system-prompt location.

## Usage

Say "wrap up" or "capture this session" at the end of a piece of work. The agent replies with one line — the thought's id, how many sources it names, whether it supersedes an earlier summary — and nothing else.

Against the database, `SELECT * FROM trace_provenance('<id>')` shows the thoughts the session read and `find_derivatives` on one of those shows every session that used it — SQL functions from migration 025, not MCP tools; a search result marks a superseded hit.

## Files

- `SKILL.md` — the skill
- `metadata.json` — contribution metadata
