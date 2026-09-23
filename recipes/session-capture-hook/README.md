# Session Capture Hook

> A session-end hook for Claude Code and Codex that captures **one summary thought** into Open Brain — what was asked, what came out, what changed — with the thoughts the session retrieved as its provenance. Through a capture-only key, after a secret scan. Off until you paste the hook it prints.

## What It Does

Capture in Open Brain is one thought at a time, when an agent chooses to call `capture_thought`. That under-collects: a two-hour session that searched the brain six times, made a decision and shipped a change leaves nothing behind unless the agent was told to write it down — and on the day this recipe was written, a session whose MCP connection failed at start-up had no capture tool at all and nothing reminded anyone (SMD-1298).

This hook runs when a session ends, whether or not the session ever connected to the brain. It reads the transcript the harness hands it, derives a summary, and posts that summary through the brain's MCP endpoint as one thought:

- **`derived_from`** — the ids of every thought the session read from the brain (the `ID:` lines of its search results) and every thought it captured. Only the brain's tool results are read: its own tool names under any server prefix, and the generic `search`/`fetch` pair every connector has only under a server named with `brain` as a word — `open-brain`, `my_brain` — not a `brainstorm` (a Notion or Linear `search` prints uuid-shaped ids too). The `trace_provenance` SQL function (migration 025) walks from the summary to them; `find_derivatives` from any of them answers "which sessions used this thought". Neither is an MCP tool — run them against the database.
- **`source`** — `claude-code` or `codex`, recorded as `metadata.source`, so a per-source weight can rank a session summary below a considered note.
- **`supersedes`** — when the same session ends again (a resume, a Stop hook on an interval), the new summary replaces the old one. A session is one current thought however many times it ends.

The transcript itself is never sent. Nothing is read from the brain. The key the hook holds can add a thought and do nothing else.

## What Is Sent — Exactly

One text, built deterministically from the transcript, capped at 6,000 characters:

```text
Session summary — claude-code — OB1 (michaelharris/smd-1298-session-end-capture) — 2026-09-22

Title: Session-end capture hook

Asked (4 prompts):
- create a new branch to plan and implement smd-1298
- review for issues
- push and open pr
- merge pr

Outcome (the assistant's last message):
Merged as 8541cec. Twelve checks green. …

Changed: 9 files — server-portable/auth.ts, server-portable/index.ts, …; 3 commits, pushed; PR https://github.com/o/r/pull/102.

Brain: retrieved 6 thoughts, captured 2 (recorded as this summary's provenance).

Session 8de5e1e1-…, 2026-09-22 12:34 → 2026-09-22 15:10.
```

| Section | Source in the transcript | What is left out |
| --- | --- | --- |
| Head, title | The harness, the project directory's name, the git branch, the day; Claude Code's session title | — |
| Asked | The human's prompts, first 200 characters each, at most 12 listed | Harness-injected frames (system reminders, slash-command wrappers, pasted-content frames, Codex's environment context), compaction summaries, bare slash commands, subagent turns, retried duplicates |
| Outcome | The assistant's last message, first 1,500 characters | Everything before it |
| Changed | Paths of files the session edited or wrote, relative to the project, at most 20; a count of `git commit`s and whether it pushed; PR links | Files outside the project are counted, not named; no diff, no file content |
| Brain | Counts of thoughts retrieved and captured | The ids are in `derived_from`, not in the text |
| Session | The session id and the time span | — |

Never sent: the transcript, tool outputs, file contents, commands, anything from a subagent, the machine's paths outside the project, the key. What the assistant quoted in its last message is in the summary — that is what the scan is for.

**The secret scan runs before anything leaves.** The summary text — and the prompts, outcome and title whole, before their clips — is checked for the common key shapes (Anthropic, OpenAI, AWS, GitHub, Slack, Google, Stripe, SendGrid, Linear, Hugging Face, npm, JWTs, private-key blocks), credential assignments (`x-brain-key: …`, `MCP_ACCESS_KEY=…`, `AWS_SECRET_ACCESS_KEY=…`, `<ANY>_API_KEY=…`, `<ANY>_TOKEN=…`, `--api-key <value>`, a bearer token — a value that is a reference, `${VAR}`, `%VAR%` or `process.env.X`, or that carries no digit, a placeholder or a name, is not one), password assignments of six characters or more (`POSTGRES_PASSWORD=hunter2`), URLs carrying a password, a bare 64-hex run with or without `0x` (this fork's own keys are 64 hex; a digest after `name:scope:` or `sha256:` is not one), a key in a URL's query (`?key=…`, the connector form), and 32-character-plus mixed-case high-entropy tokens. Not tokens: a uuid, a git sha, a digest in its context, paths, a URL's path or query, base64 data URIs, file names, and word-shaped identifiers. A hit **refuses the whole capture**: the reason and the character offset are printed, never the match; the exit code is 1; nothing is written. The session ends as it would have — exit 1 blocks nothing in either harness.

## Prerequisites

- A running Open Brain with the portable server at or after SMD-1298 (the `capture` key scope and `capture_thought`'s `source` argument; migration 049) — [`SETUP.md`](../../SETUP.md)
- Claude Code, or Codex CLI 0.151 or later (hooks)
- Bun 1.4+ or Node.js 18+ on the machine that runs the sessions
- The [`session-summary`](../../skills/session-summary/) skill, if you also want the agent to write a considered summary at wrap-up (this hook is the floor under that: it runs whether or not the agent did)

## Credential Tracker

```text
SESSION CAPTURE HOOK -- CREDENTIAL TRACKER
--------------------------------------------

FROM YOUR OPEN BRAIN SETUP
  Endpoint URL (the MCP endpoint, e.g. http://127.0.0.1:8010/):  ____________

GENERATED DURING SETUP
  Capture-scoped key (step 1; shown once by keygen):              ____________
  Config file (step 2):   ~/.config/open-brain/session-capture.json
  State directory:        ~/.local/state/open-brain/session-capture/

--------------------------------------------
```

## Steps

### 1. Mint a capture-only key

On the machine that runs the server:

```bash
cd server-portable && bun keygen.ts --name session-hook --scope capture
```

Add the printed `session-hook:capture:<sha256>` line to `MCP_ACCESS_KEYS` in `deploy/.env` and restart the server (`podman compose -f compose.yaml up -d` from `deploy/`). Copy the raw key — it is shown once.

A capture-scoped key sees `capture_thought` and nothing else: no search, no update, no delete. If this file leaks, the leak can add a thought to your brain; it cannot read one, alter one or remove one. Preflight lists the key as `session-hook(capture)`.

Since migration 046 (SMD-1730) every audit row records who holds the key that wrote it — `operator`, `agent` or `ingested` — from the key's classification in the registry. The hook's summaries are agent-written, so classify the key right after minting, before the hook's first request (046 upserts the label; `resolve_agent` attaches the digest when the key is first seen) — else its first summaries land with no kind and preflight's `audit events` row names the key until they are backfilled:

```sql
SELECT set_agent_kind('session-hook', 'agent');
```

### 2. Write the config file

```bash
mkdir -p ~/.config/open-brain
cat > ~/.config/open-brain/session-capture.json <<'EOF'
{ "url": "http://127.0.0.1:8010/", "key": "<the raw capture key>" }
EOF
chmod 600 ~/.config/open-brain/session-capture.json
```

The key lives here and nowhere else — not in the hook's command line, which sits in a settings file every tool on the machine can read. (`"key_file": "/path"` is accepted in place of `"key"`.)

### 3. Check it

```bash
bun recipes/session-capture-hook/session-capture.mjs --check
```

`ok: http://127.0.0.1:8010/ answers, and the key sees capture_thought alone (capture scope)`. With a write key it warns — the hook would work, and a leak would read your brain. With a read key it exits 1: the key cannot capture.

Then see what a session of yours would send, without sending it:

```bash
bun recipes/session-capture-hook/session-capture.mjs --dry-run ~/.claude/projects/<project>/<session>.jsonl
bun recipes/session-capture-hook/session-capture.mjs --dry-run ~/.codex/sessions/2026/09/22/rollout-<…>.jsonl
```

### 4. Print the hook and paste it

The recipe installs nothing. It prints the JSON; you paste it.

```bash
bun recipes/session-capture-hook/session-capture.mjs --print-hook claude-code
```

```json
{
  "hooks": {
    "SessionEnd": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/absolute/path/to/bun /absolute/path/to/recipes/session-capture-hook/session-capture.mjs",  // the runtime that printed it, by path — re-print after upgrading or moving it
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

Paste it into `~/.claude/settings.json` (every project) or `.claude/settings.json` (one project). For Codex, `--print-hook codex` prints the same shape with `"timeout": 3` — paste it into `~/.codex/hooks.json`. Both harnesses hand a hook the same JSON on stdin (`session_id`, `transcript_path`, `cwd`, `hook_event_name`), so one script serves both; it tells the transcripts apart by their first line.

**SessionEnd, not Stop, by default.** Claude Code fires `Stop` every time the assistant finishes a turn; `SessionEnd` fires once, when the session ends (`/exit`, `/clear`, terminal close, resume, logout). A capture per turn would be a thought per turn. If you want protection against a session that never ends cleanly, print a Stop hook with a floor between captures — each new one supersedes the last:

```bash
bun recipes/session-capture-hook/session-capture.mjs --print-hook claude-code --event Stop --min-interval 20
```

**The time budget.** Claude Code gives SessionEnd hooks 1.5 seconds between them by default and raises that to the hook's own `timeout` (at most 60); Codex allows 1 second, at most 3. The hook does its local work — read, summarise, scan — in the foreground (about 50 ms on a 20 MB transcript) and hands the network call to a detached child, then exits 0. The child posts, records the new thought's id, and writes one line to the log.

### 5. End a session and look

```bash
tail -3 ~/.local/state/open-brain/session-capture/log
```

```text
2026-09-22T15:10:02.114Z prepared: session 8de5e1e1-…, 4 prompt(s), 8 source id(s) → posting in pid 48122
2026-09-22T15:10:09.870Z captured session=8de5e1e1-… harness=claude-code id=54f612f5-… sources=8
```

Then, from any client with a read key, `search_thoughts` for something the session did — and against the database, `SELECT * FROM trace_provenance('<the new id>')` lists the thoughts the session read (a SQL function from migration 025, not an MCP tool).

## Expected Outcome

- One thought per session, type chosen by the metadata model, `metadata.source` = `claude-code` or `codex`, `derived_from` = the session's retrieved and captured thoughts.
- `~/.local/state/open-brain/session-capture/<session_id>.json` holds the thought id and the summary's fingerprint; the same summary is never sent twice; a changed one supersedes.
- A session with no human prompt, or no transcript, is skipped with exit 0 and a `skip:` line in the log.
- A summary that carries a secret is refused with exit 1, a `refused —` line naming the shape and the offset, and nothing sent.
- A post that fails (the server down, its database down, a timeout, the server's own `Error:` such as a grant it lacks or its agent registry being away — anything that is not a `Refused:`) keeps its payload under `pending/`; the next run of the hook, for any session, posts what is pending oldest first and its own summary last (five per run). Of two payloads of one session only the newest is posted — a summary is cumulative — and the older goes to `dead/` unposted. Each run claims the files it posts by moving them into `inflight/<pid>/`, so two sessions ending together never post each other's payload; a run that dies leaves its claims for the next run to sweep back, as does any claim older than fifteen minutes. A wrong URL (a 4xx answer) is given up at once and named in the log. A refusal — an unauthorized key, a request the server says no to as shaped — gives up at once, into `dead/`. A payload the server keeps failing to take is never given up for the count of tries; after a week under `pending/` it goes to `dead/`, and `dead/` is pruned after thirty days.
- A `derived_from` id the server does not know (a thought since deleted) is dropped by the server, which records the live sources and tells a key that cannot read nothing of it — not which, not how many (the row's `derived_from` says what landed). A `supersedes` the server refuses is dropped by the hook and the capture retried; one the server could not check (a grant its role lacks, its agent registry away) is the server's `Error:` and the payload waits. The log's `note=` says what was dropped.

## Troubleshooting

**Issue: `session-capture: no endpoint or key`**
Solution: write the config file from step 2. `OB1_BRAIN_URL` and `OB1_CAPTURE_KEY` in the environment override it (a container, a test); `OB1_SESSION_CAPTURE_CONFIG` names another file.

**Issue: `--check` says the key cannot capture**
Solution: the key is read-scoped. Mint one with `--scope capture` (step 1), or use a write key and accept the warning.

**Issue: `pending/` fills up, the log says `pending … error="fetch failed"`**
Solution: the endpoint is not reachable from this machine. Check the URL in the config and that the server is up (`curl http://127.0.0.1:8010/health` → `ok`). The payloads deliver on the next run once it is.

**Issue: the log says `refused — … high-entropy token at char N`**
Solution: something in a prompt or in the assistant's last message looks like a token — `--dry-run` the transcript to see the text at that offset. Take the value out of the conversation before ending the session (or capture a summary by hand with the `session-summary` skill). The scan is deliberately conservative: a refused capture costs one summary; a leaked credential costs more.

**Issue: nothing happens at all**
Solution: is the hook in the settings file the harness reads (`~/.claude/settings.json`, or `.claude/settings.json` in the project you were in)? Run the hook by hand: `echo '{"session_id":"x","transcript_path":"<path>","hook_event_name":"SessionEnd"}' | bun session-capture.mjs` prints what it decided on stderr.

**Issue: Codex says the hook timed out**
Solution: Codex allows SessionEnd hooks at most 3 seconds; the foreground finishes in well under one. If a transcript is enormous (hundreds of MB), print a `--event Stop` hook instead — the printed Stop hook sets no timeout, so the harness's 600-second default stands.

## Relationship to the vendored auto-capture skill

[`skills/auto-capture-claude-code/`](../../skills/auto-capture-claude-code/) (vendored from upstream) ships a Stop hook that POSTs the **formatted transcript** to a Supabase REST ingest endpoint with a full-access key — the shape this recipe declines: the transcript is a privacy problem at rest and a retrieval problem at query time (twenty chatty chunks); a summary is one thought with provenance. Its parser also reads a `Human:`/`Assistant:` text format Claude Code does not write. This recipe is the replacement; that skill's fate belongs with the Supabase retirement (SMD-1795 / SMD-1802).

## Testing

```bash
bun recipes/session-capture-hook/test-session-capture.mjs   # no brain, no model: synthetic transcripts and a fake MCP endpoint
```

Both parsers, the summary's shape and caps, every secret pattern's probe and the clean probes (uuids, digests in their spellings, paths, URLs, data URIs, identifiers, prose) with each threshold pinned alone, the refusal — a key past a prompt's clip included — the payload, posting, supersession, refused and unreachable pointers, the queue under two children and after a dead one, obsolete and landed payloads, wrong urls and busy endpoints, the SSE shapes, the detached hand-off inside the budget against a slow endpoint, `--check`, `--dry-run`, `--print-hook`. It runs in CI's repo-consistency job.
