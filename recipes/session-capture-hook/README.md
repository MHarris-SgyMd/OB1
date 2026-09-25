# Session Capture Hook

> A session hook for Claude Code and Codex that captures **one summary thought per episode of a session** into Open Brain — a piece of work: the asks between a compaction, a move to another branch or checkout, or a new ticket — at each compaction and at session end: what was asked, what came out, what changed, with the thoughts that piece of the session retrieved as its provenance. Through a capture-only key, after a secret scan. Off until you paste the hooks it prints.

## What It Does

Capture in Open Brain is one thought at a time, when an agent chooses to call `capture_thought`. That under-collects: a two-hour session that searched the brain six times, made a decision and shipped a change leaves nothing behind unless the agent was told to write it down — and on the day this recipe was written, a session whose MCP connection failed at start-up had no capture tool at all and nothing reminded anyone (SMD-1298).

This hook runs at a session's checkpoints — before each compaction (Claude Code's `PreCompact`, manual or automatic) and when the session ends — whether or not the session ever connected to the brain. It reads the transcript the harness hands it, cuts it into **episodes**, derives one summary per episode, and posts each through the brain's MCP endpoint as one thought:

- **`derived_from`** — the ids of every thought the session read from the brain (the `ID:` lines of its search results) and every thought it captured. Only the brain's tool results are read: its own tool names under any server prefix, and the generic `search`/`fetch` pair every connector has only under a server named with `brain` as a word — `open-brain`, `my_brain` — not a `brainstorm` (a Notion or Linear `search` prints uuid-shaped ids too). The `trace_provenance` SQL function (migration 025) walks from the summary to them; `find_derivatives` from any of them answers "which sessions used this thought". Neither is an MCP tool — run them against the database.
- **`source`** — `claude-code` or `codex`, recorded as `metadata.source`, so a per-source weight can rank a session summary below a considered note.
- **`supersedes`** — when the same episode reaches another checkpoint (a compaction, the session's end, a resume ending again, a Stop hook on an interval) with its summary changed, the new summary replaces the old one. An episode is one current thought however many times it is captured, and an episode already captured and unchanged is skipped; a summary of an episode still running carries a `Checkpoint:` line, which its end — or the compaction that closes it — drops (SMD-2012).

**An episode is a piece of the session's work (SMD-2013).** A two-day session moves through several tickets, and one summary of all of them named the first task, mixed every task's sources and answered no search well. So an episode ends, and the next begins at the next ask, at a compaction (the harness's summary line), when the session is on another branch at that ask — or, with no branch to go by, in a directory inside none the episode ran in — or at an ask naming a ticket none of the episode's asks, its branch or its directory named (on a branch that names a ticket, a mention does not end the episode; only an ask followed by the move to the new ticket's branch does). Not a move: a `cd` within the checkout, or out of it with the branch unchanged (the harness records the shell's directory per command), a move the session came back from before the next ask, a detached `HEAD` mid-rebase, and a move to a branch or directory that names a ticket the episode is about — its opening ask's, its first ask's, its home's — since the branch is made a few lines after the ask that names its ticket. A ticket key in an ask is one of the teams the session's branches or directories have named so far, in any case — `smd-1234` under an `smd-` branch — so `node-22` and `AES-256` are no tickets; before any team is known, a key in capitals counts. Work between a boundary and the next ask — the assistant finishing after a compaction, or after the move — belongs to the ask that caused it; the move itself is the next episode's, so an ended episode keeps its branch, directory and ticket. Boundaries are fixed once written: appending to the transcript never moves an earlier one, so an episode's ordinal, text and fingerprint stand. Each episode chains under its own key — the first under the session's id, so a session of one episode is captured exactly as before — and a re-ending supersedes only the episode that changed. A run's child posts every episode the run prepared; the five per run bound what waited from before. `--dry-run` prints the segmentation before the texts, so you can see where the boundaries fall before installing anything. A Stop hook's interval counts the session's last capture across its episodes, so a new episode inside the interval is not captured at once.

The transcript itself is never sent. Nothing is read from the brain. The key the hook holds can add a thought and do nothing else.

## What Is Sent — Exactly

One text, built deterministically from the transcript, capped at 6,000 characters:

```text
Session summary — SMD-1298 — claude-code — OB1 (michaelharris/smd-1298-session-end-capture) — 2026-09-22

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
| Head, title | The tickets the episode's asks name (else the one its branch or directory names), the harness, the project directory's name, the git branch, the day; Claude Code's session title (the first episode's; a later episode is titled by its first ask) | — |
| Asked | The human's prompts, first 200 characters each, at most 12 listed | Harness-injected frames (system reminders, slash-command wrappers, pasted-content frames, Codex's environment context), compaction summaries, bare slash commands, subagent turns, retried duplicates |
| Outcome | The assistant's last message, first 1,500 characters | Everything before it |
| Changed | Paths of files the session edited or wrote, relative to the project, at most 20; a count of `git commit`s and whether it pushed; PR links | Files outside the project are counted, not named; no diff, no file content |
| Brain | Counts of thoughts retrieved and captured | The ids are in `derived_from`, not in the text |
| Episode | Only when the session has more than one, or the episode is over: `Episode 2 of the session, begun after a compaction with SMD-2013, ended when the session moved to branch …` — its ordinal, what began it (a compaction, a move to a branch or directory, a ticket; a compaction and a move both, when both fell between two asks) and what ended it | Nothing of the other episodes: an episode's text depends on nothing after it |
| Checkpoint | Only while the session runs: `compacted at <time> (auto or manual), continuing` from a PreCompact hook, `turn ended at <time>, continuing` from a Stop hook; the time is the transcript's last | Absent at session end — that summary supersedes the checkpoint's |
| Session | The session id and the time span | — |

Never sent: the transcript, tool outputs, file contents, commands, anything from a subagent, the machine's paths outside the project, the key. What the assistant quoted in its last message is in the summary — that is what the scan is for.

**The secret scan runs before anything leaves.** The summary text — and the prompts, outcome and title whole, before their clips — is checked for the common key shapes (Anthropic, OpenAI, AWS, GitHub, Slack, Google, Stripe, SendGrid, Linear, Hugging Face, npm, JWTs, private-key blocks), credential assignments (`x-brain-key: …`, `MCP_ACCESS_KEY=…`, `AWS_SECRET_ACCESS_KEY=…`, `<ANY>_API_KEY=…`, `<ANY>_TOKEN=…`, `--api-key <value>`, a bearer token — a value that is a reference, `${VAR}`, `%VAR%` or `process.env.X`, or that carries no digit, a placeholder or a name, is not one), password assignments of six characters or more (`POSTGRES_PASSWORD=hunter2`), URLs carrying a password, a bare 64-hex run with or without `0x` (this fork's own keys are 64 hex; a digest after `name:scope:` or `sha256:` is not one), a key in a URL's query (`?key=…`, the connector form), and 32-character-plus mixed-case high-entropy tokens. Not tokens: a uuid, a git sha, a digest in its context, paths, a URL's path or query, base64 data URIs, file names, and word-shaped identifiers. A hit **refuses the whole capture**: the reason and the character offset are printed, never the match; the exit code is 1; nothing is written. The session ends as it would have — exit 1 blocks nothing in either harness.

## An Optional Model Summary

The derived summary is a log entry: deterministic, free, never wrong about what happened — and unable to say what was **decided** or why. With a local model on the box, an opt-in `summary: "model"` has one rewrite each episode's summary into decisions taken and their reasons, what was left open, and what changed. It is off by default; nothing about the derived summary changes unless you turn it on (SMD-2014).

- **Where it runs.** In the detached child that posts, never in the foreground — the hook's budget is 1.5 seconds, a model call is seconds. The model is shown the **derived summary and the episode's assistant messages only** — never the raw transcript, never tool results. It is asked to name no ids and quote no secrets, under a token cap.
- **The fallback is the derived summary.** A missing endpoint, an egress refusal, a slow, failed or empty call, or **a secret in the model's own words** (the scan runs on its output too) all fall back to the derived text the payload already carries — a well-formed memory beats none — and the log line says why. `derived_from` stays the derived summary's provenance whichever text is sent; the model names no ids.
- **The egress gate.** The hook carries its **own** policy, because it is a client on another machine from the server whose gate SMD-1903 defines. `egress` (or `OB1_EGRESS_POLICY`) is `deny` by default and fails closed; under deny only an endpoint **declared** local — `"model_local": true` — may be called. "Local" is declared, never guessed from the address, exactly as the server declares it: a loopback URL behind a forwarding proxy is not local, and a LAN model a box vouches for is. `allow` and `off` permit any endpoint.
- **How a reader tells the two apart.** `metadata.source` stays the harness (`claude-code` / `codex`). A `summary_model` metadata key records which model wrote it, so a reader — and a per-source weight (SMD-1297) — can tell a model summary from the derived one. The wire contract is otherwise unchanged.

The config keys (each also an env var, which wins, for a container or a test): `summary` (`derived` | `model`, `OB1_SESSION_CAPTURE_SUMMARY`), `model_url` (`OB1_SESSION_CAPTURE_MODEL_URL`, falling back to `OB1_CHAT_BASE_URL` / `OB1_LLM_BASE_URL` — the OpenAI `/chat/completions` shape), `model` (`OB1_SESSION_CAPTURE_MODEL`, falling back to `OB1_METADATA_MODEL`), `model_key` (`OB1_SESSION_CAPTURE_MODEL_KEY`, for an endpoint that needs one), `model_local` (or `OB1_CHAT_LOCAL` / `OB1_LLM_LOCAL`), `egress` (`OB1_EGRESS_POLICY`), and `model_timeout` (`OB1_SESSION_CAPTURE_MODEL_TIMEOUT`, milliseconds; 30 s by default). `--check` and `--dry-run` print the mode and, when a model is configured, whether egress would let it run — without calling it. **`capture_thought` gained an optional `metadata` argument** (SMD-2014): a small object of caller keys, stored beside the server's own; a key the server owns (`source`, the extractor's tags) is refused, not overruled.

## Prerequisites

- A running Open Brain at release 1.1.0 or later — the portable server at or after SMD-1298 (the `capture` key scope and `capture_thought`'s `source` argument; migration 049) — [`SETUP.md`](../../SETUP.md)
- Claude Code, or Codex CLI 0.151 or later (hooks; `PreCompact` is Claude Code's — Codex has no compaction hook)
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

To have a local model write the summary instead of the derived one, add the model keys (all optional; see [An optional model summary](#an-optional-model-summary) below):

```json
{
  "url": "http://127.0.0.1:8010/", "key": "<the raw capture key>",
  "summary": "model",
  "model_url": "http://127.0.0.1:11434/v1", "model": "llama3.1:8b",
  "model_local": true
}
```

### 3. Check it

```bash
bun recipes/session-capture-hook/session-capture.mjs --check
```

`ok: http://127.0.0.1:8010/ answers, and the key sees capture_thought alone (capture scope). State: ~/.local/state/open-brain/session-capture`. With a write key it warns — the hook would work, and a leak would read your brain. With a read key it exits 1: the key cannot capture.

Then see what a session of yours would send, without sending it:

```bash
bun recipes/session-capture-hook/session-capture.mjs --dry-run ~/.claude/projects/<project>/<session>.jsonl
bun recipes/session-capture-hook/session-capture.mjs --dry-run ~/.codex/sessions/2026/09/22/rollout-<…>.jsonl
bun recipes/session-capture-hook/session-capture.mjs --dry-run <transcript> --event PreCompact --trigger auto   # what a compaction checkpoint would say
```

A session of several episodes prints the segmentation first — one line per episode with its tickets, branch, asks, span and what began and ended it — then each episode's text and what it would send.

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
    ],
    "PreCompact": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/absolute/path/to/bun /absolute/path/to/recipes/session-capture-hook/session-capture.mjs",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

Paste it into `~/.claude/settings.json` (every project) or `.claude/settings.json` (one project); `--event SessionEnd` or `--event PreCompact` prints one of the two alone. For Codex, `--print-hook codex` prints SessionEnd alone with `"timeout": 3` — paste it into `~/.codex/hooks.json`. Both harnesses hand a hook the same JSON on stdin (`session_id`, `transcript_path`, `cwd`, `hook_event_name`), so one script serves both; it tells the transcripts apart by their first line.

**SessionEnd and PreCompact by default; Stop as the alternative.** `SessionEnd` fires once, when the session ends (`/exit`, `/clear`, terminal close, resume, logout). `PreCompact` fires before each compaction, manual (`/compact`) or automatic — the checkpoint a long session already has: the context is about to be squashed, and the transcript up to there is a coherent episode. A session that runs for days across several compactions leaves a summary at each, every one superseding the last, so the sessions running beside it read what it knows without waiting for its end (SMD-2012). A summary captured at a checkpoint carries a `Checkpoint:` line — `compacted at 2026-09-23 11:49 (auto), continuing` — which the session's end drops. Claude Code fires `Stop` every time the assistant finishes a turn, and a capture per turn would be a thought per turn; where there is no compaction hook, or against a session that never ends cleanly, print a Stop hook with a floor between captures — each new one supersedes the last, and its checkpoint line says `turn ended at <time>, continuing`:

```bash
bun recipes/session-capture-hook/session-capture.mjs --print-hook claude-code --event Stop --min-interval 20
```

Codex has no compaction hook: `--print-hook codex` prints SessionEnd alone, `--event PreCompact` for it is refused, and a Stop hook on an interval is its checkpoint. An event the hook does not know (`--event precompact`) is refused too — a misspelt one would install a hook that never fires. And the command pasted by hand under any other event (`SubagentStop`, `UserPromptSubmit`) skips with a `skip:` line in the log: those fire mid-session, and a summary captured there would look final.

**The time budget.** Claude Code gives SessionEnd hooks 1.5 seconds between them by default and raises that to the hook's own `timeout` (at most 60); Codex allows 1 second, at most 3. PreCompact shares no budget — a command hook's default of 600 seconds stands — but a compaction waits on the hook, so it is printed with the same `"timeout": 10`. The transcript file is written asynchronously and may lag the conversation by a message or two when a checkpoint fires; the session's end has them all. The hook does its local work — read, summarise, scan — in the foreground (about 50 ms on a 20 MB transcript) and hands the network call to a detached child, then exits 0. The child posts, records the new thought's id, and writes one line to the log.

### 5. End a session and look

```bash
tail -3 ~/.local/state/open-brain/session-capture/log
```

```text
2026-09-22T14:02:40.318Z prepared: session 8de5e1e1-… (PreCompact auto), 3 prompt(s), 6 source id(s) → posting in pid 47210
2026-09-22T14:02:46.902Z captured session=8de5e1e1-… harness=claude-code event=PreCompact trigger=auto id=2b91c0e4-… sources=6
2026-09-22T15:10:02.114Z prepared: session 8de5e1e1-…, 4 prompt(s), 8 source id(s) → posting in pid 48122
2026-09-22T15:10:09.870Z captured session=8de5e1e1-… harness=claude-code id=54f612f5-… sources=8 supersedes=2b91c0e4-…
```

Then, from any client with a read key, `search_thoughts` for something the session did — and against the database, `SELECT * FROM trace_provenance('<the new id>')` lists the thoughts the session read (a SQL function from migration 025, not an MCP tool).

## Expected Outcome

- One current thought per episode of the session — captured before each compaction and at the end, each superseding the episode's last — type chosen by the metadata model, `metadata.source` = `claude-code` or `codex`, `derived_from` = the thoughts that episode retrieved and captured. With the opt-in model summary on, the text is what a local model wrote (or the derived text, on any fallback) and `metadata.summary_model` names the model.
- `~/.local/state/open-brain/session-capture/<session_id>.json` holds the first episode's thought id and its summary's fingerprint, `<session_id>_e2.json` the second's, and so on; the same summary is never sent twice; a changed one supersedes its own.
- A session with no human prompt, or no transcript, is skipped with exit 0 and a `skip:` line in the log.
- A summary that carries a secret is refused with exit 1 and a `refused —` line naming the shape and the offset; the episode is not sent, and the session's other episodes still are.
- A post that fails (the server down, its database down, a timeout, the server's own `Error:` such as a grant it lacks or its agent registry being away — anything that is not a `Refused:`) keeps its payload under `pending/`; the next run of the hook that captures, for any session, posts what is pending oldest first and its own summary last (five per run, up to five more that waited behind a claim it cleared, and the stale ones beside those dropped as well) — a run that skips posts nothing. Of two payloads of one session only the newest is posted — a summary is cumulative — and the older goes to `dead/` unposted. While a session's end waits under `pending/`, its current thought is its last checkpoint, whose `Checkpoint:` line says `continuing`; the end's delivery supersedes it. Each run claims the files it posts by moving them into `inflight/<pid>/`, so two sessions ending together never post each other's payload; a run whose payload has an older one of the same session in another run's hands — a compaction's child still posting when the session ends a moment later — steps aside at once, leaving its payload under `pending/` for the run that clears the earlier one's claim — landing it, dropping it, or failing on it — to post next (failing that, the next run of the hook), so the end supersedes the checkpoint instead of standing beside it; and an older payload whose session has a newer one in another run's hands is obsolete, since the newer covers it (SMD-2035); a run that dies leaves its claims for the next run to sweep back, as does any claim older than fifteen minutes. A wrong URL (a 4xx answer) is given up at once and named in the log. A refusal — an unauthorized key, a request the server says no to as shaped — gives up at once, into `dead/`. A payload the server keeps failing to take is never given up for the count of tries; after a week under `pending/` it goes to `dead/`, and `dead/` is pruned after thirty days.
- A `derived_from` id the server does not know (a thought since deleted) is dropped by the server, which records the live sources and tells a key that cannot read nothing of it — not which, not how many (the row's `derived_from` says what landed). A `supersedes` the server refuses is dropped by the hook and the capture retried; one the server could not check (a grant its role lacks, its agent registry away) is the server's `Error:` and the payload waits. The log's `note=` says what was dropped.

## Troubleshooting

**Issue: `session-capture: no endpoint or key`**
Solution: write the config file from step 2. `OB1_BRAIN_URL` and `OB1_CAPTURE_KEY` in the environment override it (a container, a test); `OB1_SESSION_CAPTURE_CONFIG` names another file.

**Issue: `--check` says the key cannot capture**
Solution: the key is read-scoped. Mint one with `--scope capture` (step 1), or use a write key and accept the warning.

**Issue: `pending/` fills up, the log says `pending … error="Unable to connect…"` (under Bun; `"fetch failed"` under Node)**
Solution: the endpoint is not reachable from this machine. Check the URL in the config and that the server is up (`curl http://127.0.0.1:8010/health` → `ok`). The payloads deliver on the next run once it is.

**Issue: the log says `refused — … high-entropy token at char N`**
Solution: something in a prompt or in the assistant's last message looks like a token — `--dry-run` the transcript to see the text at that offset. Take the value out of the conversation before ending the session (or capture a summary by hand with the `session-summary` skill). The scan is deliberately conservative: a refused capture costs one summary; a leaked credential costs more.

**Issue: a search result reads `Checkpoint: compacted at … continuing`**
Solution: that summary was captured before a compaction, of a session still running; its next checkpoint or its end supersedes it, and search marks the superseded hit. Nothing to do.

**Issue: nothing happens at all**
Solution: is the hook in the settings file the harness reads (`~/.claude/settings.json`, or `.claude/settings.json` in the project you were in)? Run the hook by hand, posting in the foreground so the outcome is printed: `echo '{"session_id":"x","transcript_path":"<path>","hook_event_name":"SessionEnd"}' | OB1_SESSION_CAPTURE_SYNC=1 bun session-capture.mjs` prints `session-capture: captured <id>` (one per episode), a `skip:`, a `refused —` or a `deferred:` on stderr (without the variable a capture is one line in the log and nothing on the terminal; a by-hand run steps aside too, printing `deferred:`, while a checkpoint's child is still posting for its session).

**Issue: Codex says the hook timed out**
Solution: Codex allows SessionEnd hooks at most 3 seconds; the foreground finishes in well under one. If a transcript is enormous (hundreds of MB), print a `--event Stop` hook instead — the printed Stop hook sets no timeout, so the harness's 600-second default stands.

## Relationship to the vendored auto-capture skill

[`skills/auto-capture-claude-code/`](../../skills/auto-capture-claude-code/) (vendored from upstream) ships a Stop hook that POSTs the **formatted transcript** to a Supabase REST ingest endpoint with a full-access key — the shape this recipe declines: the transcript is a privacy problem at rest and a retrieval problem at query time (twenty chatty chunks); a summary is one thought with provenance. Its parser also reads a `Human:`/`Assistant:` text format Claude Code does not write. This recipe is the replacement; that skill's fate belongs with the Supabase retirement (SMD-1795 / SMD-1802).

## Testing

```bash
bun recipes/session-capture-hook/test-session-capture.mjs   # no real brain or model: synthetic transcripts, a fake MCP endpoint and a fake model endpoint
```

Both parsers, the summary's shape and caps, every secret pattern's probe and the clean probes (uuids, digests in their spellings, paths, URLs, data URIs, identifiers, prose) with each threshold pinned alone, the refusal — a key past a prompt's clip included — the payload, posting, supersession, refused and unreachable pointers, the queue under two children and after a dead one, a session's end stepping aside for its checkpoint's child and posted by it once the checkpoint has landed, superseding it, obsolete and landed payloads, wrong urls and busy endpoints, the SSE shapes, the detached hand-off inside the budget against a slow endpoint, `--check`, `--dry-run`, `--print-hook` (the default pair, one event alone, Codex refused a compaction hook, an unknown event refused), a compaction checkpoint's line and its supersession by the session's end; the segmenter's boundaries rule by rule and a session of four episodes — two compactions, a move, three tickets — captured one thought each with its own provenance, a re-ending superseding only the episode that changed, a secret in one episode refusing that episode alone, the newest five of seven handed to the run's child and the rest to a later run, the segmentation `--dry-run` prints (SMD-2013); and the opt-in model summary (SMD-2014) — the egress rule (local declared, never guessed; deny/allow/off), the config knobs read from the file and the environment, `modelSummary` returning the model's text on the happy path and the derived text on every fallback (off, unconfigured, egress-refused before anything is sent, a secret in the model's own words, an empty answer, an HTTP error, a timeout), `prepare` attaching the assistant excerpt only in model mode, and the end-to-end child posting the model's text with `metadata.summary_model` while `source` stays the harness. The server's own `capture_thought` `metadata` argument — a caller key stored, a reserved key refused — is covered by `server-portable/test-e2e-sql.ts`. It runs in CI's repo-consistency job.
