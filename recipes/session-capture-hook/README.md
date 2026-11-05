# Session Capture Hook

> A session hook for Claude Code and Codex that captures **one summary thought per episode of a session** into Daemonic Brain — a piece of work: the asks between a compaction, a move to another branch or checkout, or a new ticket — at each compaction and at session end: what was asked, what came out, what changed, with the thoughts that piece of the session retrieved as its provenance. Through a capture-only key, after a secret scan that blanks what it finds. Off until you paste the hooks it prints.

## What It Does

Capture in Daemonic Brain is one thought at a time, when an agent chooses to call `capture_thought`. That under-collects: a two-hour session that searched the brain six times, made a decision and shipped a change leaves nothing behind unless the agent was told to write it down — and on the day this recipe was written, a session whose MCP connection failed at start-up had no capture tool at all and nothing reminded anyone (SMD-1298).

This hook runs at a session's checkpoints — before each compaction (Claude Code's `PreCompact`, manual or automatic) and when the session ends — whether or not the session ever connected to the brain. It reads the transcript the harness hands it, cuts it into **episodes**, derives one summary per episode, and posts each through the brain's MCP endpoint as one thought:

- **`derived_from`** — the ids of every thought the session read from the brain (the `ID:` lines of its search results, each at the start of its line — an id a thought's text quotes, fenced `│ ` by the server, is not one) and every thought it captured. Only the brain's tool results are read: its own tool names under any server prefix, and the generic `search`/`fetch` pair every connector has only under a server named with `brain` as a word — `open-brain`, `my_brain` — not a `brainstorm` (a Notion or Linear `search` prints uuid-shaped ids too). The `trace_provenance` SQL function (migration 025) walks from the summary to them; `find_derivatives` from any of them answers "which sessions used this thought". Neither is an MCP tool — run them against the database.
- **`source`** — `claude-code` or `codex`, recorded as `metadata.source`, so a per-source weight can rank a session summary below a considered note.
- **`supersedes`** — when the same episode reaches another checkpoint (a compaction, the session's end, a resume ending again, a Stop hook on an interval) with its summary changed, the new summary replaces the old one. An episode is one current thought however many times it is captured, and an episode already captured and unchanged is skipped; a summary of an episode still running carries a `Checkpoint:` line, which its end — or the compaction that closes it — drops (SMD-2012).

**An episode is a piece of the session's work (SMD-2013).** A two-day session moves through several tickets, and one summary of all of them named the first task, mixed every task's sources and answered no search well. So an episode ends, and the next begins at the next ask, at a compaction (the harness's summary line), when the session is on another branch at that ask — or, with no branch to go by, in a directory inside none the episode ran in — or at an ask naming a ticket none of the episode's asks, its branch or its directory named (on a branch that names a ticket, a mention does not end the episode; only an ask followed by the move to the new ticket's branch does). Not a move: a `cd` within the checkout, or out of it with the branch unchanged (the harness records the shell's directory per command), a move the session came back from before the next ask, a detached `HEAD` mid-rebase, and a move to a branch or directory that names a ticket the episode is about — its opening ask's, its first ask's, its home's — since the branch is made a few lines after the ask that names its ticket. A ticket key in an ask is one of the teams the session's branches or directories have named so far, in any case — `smd-1234` under an `smd-` branch — so `node-22` and `AES-256` are no tickets; before any team is known, a key in capitals counts. Work between a boundary and the next ask — the assistant finishing after a compaction, or after the move — belongs to the ask that caused it; the move itself is the next episode's, so an ended episode keeps its branch, directory and ticket. Boundaries are fixed once written: appending to the transcript never moves an earlier one, so an episode's ordinal, text and fingerprint stand. Each episode chains under its own key — the first under the session's id, so a session of one episode is captured exactly as before — and a re-ending supersedes only the episode that changed. A run's child posts every episode the run prepared; the five per run bound what waited from before. `--dry-run` prints the segmentation before the texts, so you can see where the boundaries fall before installing anything. A Stop hook's interval counts the session's last capture across its episodes, so a new episode inside the interval is not captured at once.

The transcript itself is never sent. Nothing is read from the brain. The key the hook holds can add a thought and do nothing else. A brain given a claim key (step 2) also has the hook renew the work claims a worktree keeps tokens for (SMD-3602). That key is the agent's own and writes, so it is opt-in. Keep it in its own `claim_key_file`, so the config file itself still holds only the capture key.

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

**The secret scan runs before anything leaves.** The summary text — and the prompts, outcome and title whole, before their clips — is checked for the common key shapes (Anthropic, OpenAI, AWS, GitHub, Slack, Google, Stripe, SendGrid, Linear, Hugging Face, npm, JWTs, private-key blocks), credential assignments (`x-brain-key: …`, `MCP_ACCESS_KEY=…`, `AWS_SECRET_ACCESS_KEY=…`, `<ANY>_API_KEY=…`, `<ANY>_TOKEN=…`, `--api-key <value>`, a bearer token — a value that is a reference, `${VAR}`, `%VAR%` or `process.env.X`, or that carries no digit, a placeholder or a name, is not one), password assignments of six characters or more (`POSTGRES_PASSWORD=hunter2`), URLs carrying a password, a bare 64-hex run with or without `0x` (Daemonic Brain's own keys are 64 hex; a digest after `name:scope:` or `sha256:` is not one), a work claim's token (`wc_` and 64 hex digits, in either case, which proves a claim to any agent under its key — SMD-3615), a key in a URL's query (`?key=…`, the connector form), and 32-character-plus mixed-case high-entropy tokens. Not tokens: a uuid, a git sha, a digest in its context, paths, a URL's path or query, base64 data URIs, file names, and word-shaped identifiers; nor a value in brackets — `[YOUR_API_KEY]`, `[redacted]` — a placeholder.

**A hit is blanked, not the session dropped** (SMD-2127). Each span the scan finds becomes `[redacted:<reason>]` — the value of an assignment, a flag or a URL's password (a quoted value to its closing quote, straight, curly, guillemet or backtick, spaces and all), so `LINEAR_API_KEY=[redacted:linear key, credential assignment, high-entropy token]` keeps the name; the whole of a prefixed key, a token, a single-line private-key header — in the prompts, the outcome and the title before the text is rendered (so a key a clip would cut in half is blanked whole), then in the rendered text for what reaches it from elsewhere; three rules firing at one site are one marker naming the three. A MULTI-LINE key blob — a pasted PEM or PGP block, a wrapped base64 key spanning lines — is not redacted but **refuses** the episode: blanking a block precisely proved leaky over several review passes, and losing one summary beats sending a line of a key. The text is scanned once more, sources included, and only a text that second scan finds clean is sent: one it does not — a URL whose blanked password leaves a digest in its path reading as a bare key — is **refused**, as is any episode carrying a multi-line key blob, as every hit was before: the reason, the source and the character offset are printed, never the match; the exit code is 1; nothing is written. The session ends as it would have — exit 1 blocks nothing in either harness. The log's `captured` line carries `redactions=N`, the payload records each span's reason, offset and source, and `--dry-run` prints the text as it would be sent. `OB1_CAPTURE_ON_SECRET=refuse` in the hook's environment restores the refusal for every hit; `redact` is the default, and any other word is refused — a typo must not pick a mode: the hook exits 1 with nothing captured (and, as on any refused flag, posts nothing under `pending/` until the word is fixed; `--post` by hand still drains it), `--print-hook` and `--dry-run` exit 2 as on a bad flag, `--check` names it with exit 1. The thought also carries `metadata.redactions` = the count of secrets blanked (SMD-2168; the count alone, the text's markers name the kinds); a clean summary carries none, and a server that refuses the key gets the summary posted without it.

## An Optional Model Summary

The derived summary is a log entry: deterministic, free, never wrong about what happened — and unable to say what was **decided** or why. With a local model on the box, an opt-in `summary: "model"` has one rewrite each episode's summary into decisions taken and their reasons, what was left open, and what changed. It is off by default; nothing about the derived summary changes unless you turn it on (SMD-2014).

- **Where it runs.** In the detached child that posts, never in the foreground — the hook's budget is 1.5 seconds, a model call is seconds. The model is shown the **derived summary and the episode's assistant messages only** — never the raw transcript, never tool results. It is asked to name no ids and quote no secrets, under a token cap.
- **The fallback is the derived summary.** A missing endpoint, an egress refusal, a slow, failed or empty call, or **a secret in the model's own words** (the scan runs on its output too) all fall back to the derived text the payload already carries — a well-formed memory beats none — and the log line says why. `derived_from` stays the derived summary's provenance whichever text is sent; the model names no ids.
- **The egress gate.** The hook carries its **own** policy, because it is a client on another machine from the server whose gate SMD-1903 defines. `egress` (or `OB1_EGRESS_POLICY`) is `deny` by default and fails closed; under deny only an endpoint **declared** local — `"model_local": true` — may be called. "Local" is declared, never guessed from the address, exactly as the server declares it: a loopback URL behind a forwarding proxy is not local, and a LAN model a box vouches for is. `allow` and `off` permit any endpoint.
- **How a reader tells the two apart.** `metadata.source` stays the harness (`claude-code` / `codex`). A `summary_model` metadata key records which model wrote it, so a reader — and a per-source weight (SMD-1297) — can tell a model summary from the derived one. The wire contract is otherwise unchanged.

The config keys (each also an env var, which wins, for a container or a test): `summary` (`derived` | `model`, `OB1_SESSION_CAPTURE_SUMMARY`), `model_url` (`OB1_SESSION_CAPTURE_MODEL_URL`, falling back to `OB1_CHAT_BASE_URL` / `OB1_LLM_BASE_URL` — the OpenAI `/chat/completions` shape), `model` (`OB1_SESSION_CAPTURE_MODEL`, falling back to `OB1_METADATA_MODEL`), `model_key` (`OB1_SESSION_CAPTURE_MODEL_KEY`, for an endpoint that needs one; a user and password in `model_url`, `https://user:pass@host/v1`, are taken out of it and sent as Basic when no key is set — SMD-2885), `model_local` (or `OB1_CHAT_LOCAL` / `OB1_LLM_LOCAL`), `egress` (`OB1_EGRESS_POLICY`), and `model_timeout` (`OB1_SESSION_CAPTURE_MODEL_TIMEOUT`, milliseconds; 30 s by default). `--check` and `--dry-run` print the mode and, when a model is configured, whether egress would let it run — without calling it. **`capture_thought` gained an optional `metadata` argument** (SMD-2014): a small object of caller keys, stored beside the server's own; a key the server owns (`source`, the extractor's tags) is refused, not overruled.

## Prerequisites

- A running Daemonic Brain at release 1.1.0 or later — the portable server at or after SMD-1298 (the `capture` key scope and `capture_thought`'s `source` argument; migration 049) — [`SETUP.md`](../../SETUP.md)
- Claude Code, or Codex CLI 0.151 or later (hooks; `PreCompact` is Claude Code's — Codex has no compaction hook)
- Bun 1.4+ or Node.js 18+ on the machine that runs the sessions
- The [`session-summary`](../../skills/session-summary/) skill, if you also want the agent to write a considered summary at wrap-up (this hook is the floor under that: it runs whether or not the agent did)

## Credential Tracker

```text
SESSION CAPTURE HOOK -- CREDENTIAL TRACKER
--------------------------------------------

FROM YOUR DAEMONIC BRAIN SETUP
  Endpoint URL (the MCP endpoint, e.g. http://127.0.0.1:8010/mcp):  ____________

GENERATED DURING SETUP
  Capture-scoped key (step 1; shown once by keygen):              ____________
  Claim key file (step 2, optional; a copy of your connector's key, mode 600):  ____________
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

A capture-scoped key sees `capture_thought`, since SMD-3664 `set_priority` and `clear_priority`, which the brain lets it use on a thought it captured alone, and since SMD-3665 the open-item writers (`open_item`, `update_item`, `set_item_status`, `propose_item_close` and `decide_item_close`), on an item it opened alone: no search, no update of a thought, no delete. If this file leaks, the leak can add a thought to your brain, state how much its own thoughts matter at its own tier, and keep its own to-dos; it cannot read one, alter one, remove one, state a priority on another key's, or confirm or close another key's item. Preflight lists the key as `session-hook(capture)`.

Since migration 046 (SMD-1730) every audit row records who holds the key that wrote it — `operator`, `agent` or `ingested` — from the key's classification in the registry. The hook's summaries are agent-written, so classify the key right after minting, before the hook's first request (046 upserts the label; `resolve_agent` attaches the digest when the key is first seen) — else its first summaries land with no kind and preflight's `audit events` row names the key until they are backfilled. (`resolve_agent` gives each key a stable agent id when it first sees it, kept across a rename — the same key under a new name — and a rotation — a new key under the same name.)

```sql
SELECT set_agent_kind('session-hook', 'agent');
```

### 2. Write the config file

```bash
mkdir -p ~/.config/open-brain
cat > ~/.config/open-brain/session-capture.json <<'EOF'
{ "url": "http://127.0.0.1:8010/mcp", "key": "<the raw capture key>" }
EOF
chmod 600 ~/.config/open-brain/session-capture.json
```

The key lives here and nowhere else — not in the hook's command line, which sits in a settings file every tool on the machine can read. (`"key_file": "/path"` is accepted in place of `"key"`.) Nor in the url: a connector URL pasted whole, with its `?key=`, is refused when the config loads, and the refusal says where the key goes without printing it. The hook names its url, in `--check` and in its log, with every query value masked (SMD-2743).

**Several brains** (SMD-3313): to capture each summary into more than one brain — stable and its canary, say — list them, each with its own url and its own capture key (one minted on that brain):

```json
{
  "brains": [
    { "name": "stable", "url": "http://127.0.0.1:8010/mcp", "key_file": "/home/you/.config/open-brain/stable.key" },
    { "name": "canary", "url": "http://127.0.0.1:8011/mcp", "key_file": "/home/you/.config/open-brain/canary.key" }
  ]
}
```

Write `key_file` as a full path (`~` is not expanded), each file mode 600.

- **Each brain is a delivery of its own.** It has its own queue, its own chain per session, and its own log, so a summary supersedes that brain's earlier one by that brain's own id. A brain that does not answer waits in its own queue (`bun session-capture.mjs --brain <name> --post` drains it by hand) and delays no other.
- **Where state lives.** The first brain keeps the state directory a one-brain config uses, so switching to a list keeps its chains. Each brain after it gets `brains/<name>/` under that directory.
- **Provenance.** The `derived_from` ids are the ones the session read, from whichever brain served the reads. A brain that lacks some of them keeps the ones it holds, since the server trims the list for a capture key.
- **Names and keys.** A name is lower-case letters, digits and hyphens, given once. A `url`, `key` or `key_file` beside the list is refused.
- **The model summary**, if on, is shared and asked once per brain.
- **The environment wins.** `OB1_BRAIN_URL` in the environment is one brain, over the list.

**Copying your writes to another brain** (SMD-3314): the same hook, on Claude Code's `PostToolUse`, repeats each capture, edit and delete you or an agent make through one connector on every other brain that has a write key. Give the brain the connector writes to its `connector` (the MCP server's name as Claude Code spells it in `mcp__<server>__<tool>`), and each brain that should receive copies a `write_key` or `write_key_file` — a write-scoped key minted on that brain (`bun server-portable/keygen.ts --name claude-code --scope write`; the same name as the connector's key keeps the copies attributed to the same agent):

```json
{
  "brains": [
    { "name": "stable", "url": "http://127.0.0.1:8010/mcp", "key_file": "/home/you/.config/open-brain/stable.key", "connector": "open-brain" },
    { "name": "canary", "url": "http://127.0.0.1:8011/mcp", "key_file": "/home/you/.config/open-brain/canary.key",
      "write_key_file": "/home/you/.config/open-brain/canary-write.key", "connector": "open-brain-canary" }
  ]
}
```

Then paste the hook `--print-hook claude-code --fan-out` prints (step 4): an async `PostToolUse` command on `^mcp__open-brain__(capture_thought|update_thought|delete_thought)$`, so a copy never holds the session.

- **What is copied.** A write that landed through the `connector` brain's server — its reply that tool's success (`Captured as`, `Updated`, `Deleted`), never a refusal or a fault, and never a capture whose key matched a thought already there, which wrote nothing: a capture with `client_key` set to the id that brain gave the thought (the server keeps it on the copy, migration 112, so every brain names the thought by that one id), and its own arguments; an edit by the id the first brain answered (a thought named by its `client_key` there is copied by its own id), without `if_unchanged_since` (the first brain's clock, which the copy never matches); a delete by the same id. A write through any other server — the canary's own connector, its test traffic — is that brain's alone. A write that failed reaches `PostToolUseFailure`, which the hook does not take, and a result that reads as an error is never copied.
- **In order, one at a time.** Each receiving brain has its own queue (`writes/pending/` under its state directory) and one drain at a time. A copy the brain does not take now — it is away, its store is down, the write key cannot write — stops the queue, so nothing made after it lands before it; the rest wait, and land in order at the next write, at a session event (at most every five minutes while the queue is held, and always at a session's end), or by hand: `bun session-capture.mjs --drain-writes --brain <name>`. A copy still held after a week is given up, as the capture queue gives a payload up. One drain runs at a time: its lock is renewed before each copy, and only a dead holder's, or one silent for fifteen minutes (a copy's longest is five 90-second tries), is taken back. The one copy such a stalled holder had in flight is the only one two drains can both post, and its key lands it as one thought.
- **What is skipped.** An edit or delete of a thought the brain never got (made before the copying began, or by the brain's own writers) is skipped and logged. A pointer it does not know — a `derived_from` or `supersedes` naming such a thought, a board-sync row's id, or one that would close a loop there — is dropped and the write sent again, and so is metadata its server refuses. A fault on the brain (its REST core or store restarting) holds the queue, as the brain being away does. A capture whose text that brain already holds lands on that thought, now named by the first brain's id too, and the log says so. A copy refused for good — an input the brain's server cannot validate among them — goes to `writes/dead/`, pruned after thirty days. The brain's log names each copy by its tool and id, never its text.
- `--check` names the connector and where its writes go, and for each receiving brain that its write key can capture, edit and delete and that its server keeps a `client_key` (a server from before migration 112 fails it), with what its queue holds and how old its oldest copy is.

**Renewing work claims** (SMD-3602): an agent claims its ticket on the brain before it creates the branch (`claim_work`, SMD-3598), on a lease of a day. It keeps the token it gets back in `.work-claims/<claim id>.json` at its worktree's root, mode 600, in a directory of mode 700 holding a `.gitignore` of `*`:

```json
{ "id": "<the claim id>", "token": "wc_…", "ticket": "SMD-1234", "piece": "PR 2", "lease_seconds": 86400, "server": "open-brain" }
```

- **The fields.** `id` and `token` are required, and the file is named by the id. `ticket` and `piece` name the work in the log.
  - `lease_seconds` is the lease each renewal sets: 60 to 604800, or the server's four hours if absent. The rule has an agent claim for a day and set a week once its PR opens. A renewal without it would cut the lease back to four hours.
  - `server` is the MCP server the claim was made through, and it is required. A claim is renewed only on the brain whose `connector` is that name and that has a claim key, one brain or several, so a token never goes to a brain that didn't issue it. A file without one is skipped.
- **Keeping it out of git.** The directory's own `.gitignore` keeps it out of git on any branch and in any repo. `.work-claims` in the repo's `.gitignore` does too. The token proves the claim to anyone holding your key.

Give the brain your agents claim through the agent's key, as `claim_key_file` (or `claim_key`): the very key the agent claims with. Only that brain needs one, stable in this repo's setup, not its canary. A claim belongs to the key's agent id, and only that key can renew it. A second key can't share the id: the server takes one key per name in `MCP_ACCESS_KEYS`, and its preflight fails, keeping the REST core down, when a name appears twice. The claims hook needs the capture config of step 1 as well; it adds to it and doesn't stand alone.

For Claude Code, the key is the `x-brain-key` of its brain connector. Copy it into the file without it ever reaching the terminal (a full path: `~` is not expanded in the config):

```bash
umask 077; claude mcp get open-brain | sed -n 's/^.*x-brain-key:[[:space:]]*//p' > /home/you/.config/open-brain/stable-claims.key
test -s /home/you/.config/open-brain/stable-claims.key && echo written
```

A connector that carries its key on its url (`?key=`) has no header, so the file comes out empty: put the raw key you kept at keygen time in it instead. Keep the file mode 600; `--check` warns about one others can read.

If that key is your operator key, which a default install hands its coding client (SETUP.md classifies it `operator`), first give sessions an agent key of their own, as AGENTS.md's "Claim your work" says under **Keys**. The claim key then holds no operator power. The operator key can force-release any claim, and it sits in a file read at every tool call. A Codex session on a different key can't be renewed through this brain's one claim key; its agent renews by the rule.

```json
{
  "brains": [
    { "name": "stable", "url": "http://127.0.0.1:8010/mcp", "key_file": "/home/you/.config/open-brain/stable.key",
      "connector": "open-brain", "claim_key_file": "/home/you/.config/open-brain/stable-claims.key" }
  ]
}
```

The one-brain shape takes `connector` and a claim key too:

```json
{ "url": "http://127.0.0.1:8010/mcp", "key_file": "/home/you/.config/open-brain/capture.key",
  "connector": "open-brain", "claim_key_file": "/home/you/.config/open-brain/stable-claims.key" }
```

`OB1_CLAIM_KEY` in the environment wins over the one-brain file's claim key. The brain `OB1_BRAIN_URL` names has no connector, so it renews no claims: no token goes to it, a claim key in the file goes unused, and `OB1_CLAIM_KEY` beside it is unused. `--check` warns about each. A claim key that can't be read — a missing or empty file, a `~` path — turns claims off for that brain and leaves the capture running; `--check` fails with the reason, and a checkpoint logs it.

- **When it renews.**
  - **At a compaction and at a session's end:** each claim the worktree holds a token for, unless it was attempted within the last minute.
  - **On a Stop hook's turn:** only the claims that are due.
  - **With the claims hook pasted (step 4):** every tool call and every prompt renews what is due.

  A claim is due a quarter of its lease after the last attempt, but never less than a minute or more than an hour after it: hourly on four hours, a day or a week. A lease shorter than four minutes is renewed every minute, so it has less than three quarters of its time to spare at each renewal; a 60-second lease lapses for an instant before each one. A session waiting overnight renews nothing, and a claim on a day's lease outlasts the night.
- **Where it looks.** The session's working directory, symlinks resolved, up to the nearest directory with a `.git`: a checkout's directory, a worktree's file, a submodule's file. A session must run inside its worktree: one whose working directory is the main checkout, editing a worktree by path, renews the main checkout's claims and not the worktree's.
- **It never claims and never releases.** Claiming stays the agent's explicit step, since the hook can't tell a branch for a ticket from a scratch branch. A session can end with its PR still open, so a claim ends when the agent releases it at merge or abandon, when board-sync releases it because its ticket closed, or lapses when nothing renews it. The agent renews too; the hook is the backstop.
- **When the claim has ended,** released by its holder, an operator, board-sync (its ticket closed: the brain's words name the reason `<ticket> closed: …`), or a takeover after it lapsed, the token file becomes `<id>.ended.json`. It keeps the work, the code and the brain's words (`lapsed and was taken over by …: stop work on it`) and drops the token.
- **Anything else keeps the file**, and the next due event tries again. Each case is a `claims: kept:` line in the log, the code first:
  - the brain away, or its agent registry away (`CLAIM_UNATTRIBUTED`);
  - a token the brain does not match;
  - a claim key that is not the holder's;
  - a claim this brain does not have (made through another server than the file names);
- **When another claim covers its work** (`WORK_CLAIMED`: the claim lapsed, and another claim, by any key including your own, now covers overlapping work), the hook keeps the token and writes `<id>.blocked.json` beside it, with the code and the brain's words. Migration 115 would renew the claim once that other claim ends, silently, though another agent may have built part of the work meanwhile. So the hook renews it no more until the agent deletes the marker, which the rule has it do on the user's decision. A checkpoint logs each claim it holds back. The marker is written whenever the token file still holds the token renewed, even if the agent rewrote the file during the call.
- **The agent's own claim calls.** With the claims hook pasted, the hook reads the result of the agent's own `renew_claim`, or `claim_work` with a token, through the connector its token file names. A `WORK_CLAIMED` there, with one claim in the way or several, writes the same `<id>.blocked.json`, so the agent's next renewal doesn't revive the claim silently once the covering claim ends. Only a call on the token file's own work marks it: `renew_claim` of its id, or `claim_work` of its ticket and piece, cleaned as 115 cleans them (a token file naming no ticket is taken as that work). A `claim_work` for other work carrying the token meets claims of its own. A renewal there records the new expiry, so the hook's record never reads a lapse the agent prevented. If the claim in the way is this worktree's own piece, the line says to release the older claim instead, read off the whole reply even when the marker is cut.
- **Before reviving a claim it knows lapsed** (its recorded expiry past), the hook lists the ticket's claims, ended ones included. A claim on overlapping work made or renewed since the lapse means another agent may have built part of it. Then the claim is not renewed, and a `.blocked.json` says so ("not renewed") and names who claimed what, when it was claimed and last renewed, and the claim's id, so the agent can match it against the claim named after the user's decision. With none, or with the claim listed live (the agent renewed it), it is renewed, and a lapse with none since is logged as one on any brain. A token file with no `ticket` is renewed unchecked, and the line says so. A claim `list_claims` doesn't list is kept, not renewed blind.
- **A renewal's reply that reports a lapse.** Since SMD-3654 a renewal that revived a lapsed claim says when it had lapsed, and names any claim made or renewed on its work meanwhile. The hook marks such a renewal with the same `.blocked.json`, its code `CLAIMED_WHILE_LAPSED`: its own, or the agent's when the claims hook sees it. A reply that the claims since couldn't be read, or that whether the claim had lapsed couldn't be, is marked too; there the rule has the agent make the reply's check, and stop only if it finds a claim. One saying no other claim was made or renewed is not marked, and the log line says it had lapsed. A marker longer than 600 characters, a lapse's or a `WORK_CLAIMED`'s, is cut, and says where. `--renew-claims` exits 1 on a renewal it marked, as on a blocked one. An agent renewing with no claims hook reads the same words in its own reply, and the rule has it stop on a claim named. On a brain from before SMD-3654 the replies don't say, and the lapse check above is the hook's one guard.
- **What it refuses to read.** These are skipped and named at a checkpoint: a file not named `<claim id>.json`, one whose `id` its name does not match, one without a `server`, a token file that is a symlink or a second link to another file (a hardlink), a `.work-claims` that is a symlink, and a file or directory it cannot read. The hook writes `.ended.json` to a fresh file, created exclusively, and renames it into place. A symlink planted at either name is therefore replaced or refused, never followed.
- **The log** names each claim by its work and id, never its token; a token-shaped run in a brain's words, an error, a ticket or a file name is masked. The hook owns the token files. A file or directory others can read, as a Write tool leaves a file, is closed to 600 or 700 through a handle opened without following links — and a file only when it is still the one the claim was read from, one link and the same inode — and the line names which.
- **Two at once.** Each claim is stamped before its call, so within one run, and for a run that starts after the stamp, a due claim is renewed once. Hooks fired in the same instant can both renew it, which costs one extra call.
- **By hand.** `bun session-capture.mjs --renew-claims [--cwd <dir>] [--claim <id>]` renews a worktree's claims now, or the one named, and prints what happened, terminal or not. It exits 1 when one was kept, blocked or skipped, or a `--claim` id has a bad token file or none, and 0 when each was renewed, unmarked, or found ended. A `--claim` that is no claim id is refused, exit 2, without being shown, so a token given there by mistake reaches neither the terminal nor the log. `--check` says where the claim key came from, that it can call `renew_claim`, and for which connector; it fails a claim key on a brain with no `connector`, which could renew nothing.

To have a local model write the summary instead of the derived one, add the model keys (all optional; see [An optional model summary](#an-optional-model-summary) below):

```json
{
  "url": "http://127.0.0.1:8010/mcp", "key": "<the raw capture key>",
  "summary": "model",
  "model_url": "http://127.0.0.1:11434/v1", "model": "llama3.1:8b",
  "model_local": true
}
```

### 3. Check it

```bash
bun recipes/session-capture-hook/session-capture.mjs --check
```

`ok: http://127.0.0.1:8010/mcp/ answers, and the key sees capture_thought alone (capture scope). On a secret: redact. State: ~/.local/state/open-brain/session-capture`. A server since SMD-3664 gives a capture key the priority writers too (`set_priority` and `clear_priority`, on a thought it captured), and since SMD-3665 the open-item writers (`open_item`, `update_item`, `set_item_status`, `propose_item_close` and `decide_item_close`, on an item it opened), and the line lists them: still a capture key, no warning. With a write key it warns — the hook would work, and a leak would read your brain. With a read key it exits 1: the key cannot capture. A url at the origin's root, the one given before the proxy, warns too on a stack before v2.0.0: it answers through the proxy's deprecated legacy route, and the warning names the `/mcp` url to set (SMD-2686). From v2.0.0 that route is gone (SMD-2532), and the root is the proxy's 404, which `--check` names as not the endpoint. A url at stable's `/canary/mcp` or `/working/mcp` on a stack before v2.0.0 warns as well (from v2.0.0 those tier routes are gone, SMD-2874, and such a url is the proxy's 404, which `--check` names as not the endpoint), and the warning says to set the tier itself, a canary's own port (`deploy/canary.sh`), never stable's `/mcp` (SMD-3057), and says so beside the 404 such a route gives with no tier behind it. Each route's `Deprecation` date tells which answered. Only `--check` says so, as for the root.

With several brains, `--check` checks each, every line led by its name (`[canary] ok: …`, with that brain's own `State:`). It exits with the worst brain's code, so one brain that does not answer fails the check while the others still say ok.

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

**The write fan-out's hook** (SMD-3314, Claude Code only), for a config that gives brains a `connector` and a `write_key` (step 2):

```bash
bun recipes/session-capture-hook/session-capture.mjs --print-hook claude-code --fan-out   # --connector <server> for another connector's
```

It prints a `PostToolUse` entry with `"matcher": "^mcp__open-brain__(capture_thought|update_thought|delete_thought)$"` (the config's connector) and `"async": true`, to paste beside the others. Anchored, because the harness reads a matcher holding any character past letters, digits and `_-|,` as an unanchored pattern.

**The claims hook** (SMD-3602, Claude Code only), for a config that gives a brain a `claim_key` (step 2):

```bash
bun recipes/session-capture-hook/session-capture.mjs --print-hook claude-code --claims
```

It prints a `PostToolUse` entry on every tool (`"matcher": "*"`) and a `UserPromptSubmit` entry, both `"async": true` and both running the script with `--claims`. They renew what is due and capture and copy nothing. The flag keeps them apart from the fan-out's `PostToolUse`, which would otherwise copy a write twice. On a session hook's own event a command given `--claims` still captures, then renews. A run with nothing due reads a directory and exits.

**Merge, don't paste over.** The printed object is a whole `{"hooks": {…}}`. Settings that already hold the session hooks (and the fan-out's) take its entries inside their existing `hooks` object:
- append its `PostToolUse` group to the `PostToolUse` array, beside the fan-out's;
- add its `UserPromptSubmit` group: as a new key, or appended to an existing `UserPromptSubmit` array.

A second top-level `"hooks"` key would leave one of the two sets silently unread. `/hooks` in Claude Code lists what it loaded. The same applies to the fan-out's hook.

Codex has no async hook. Its agent renews with `renew_claim` itself, and its session hook renews once, at SessionEnd, or on each due turn with `--print-hook codex --event Stop --min-interval <minutes>` pasted.

**The time budget.** Claude Code gives SessionEnd hooks 1.5 seconds between them by default and raises that to the hook's own `timeout` (at most 60); Codex allows 1 second, at most 3. PreCompact shares no budget — a command hook's default of 600 seconds stands — but a compaction waits on the hook, so it is printed with the same `"timeout": 10`. The transcript file is written asynchronously and may lag the conversation by a message or two when a checkpoint fires; the session's end has them all. The hook does its local work — read, summarise, scan — in the foreground (about 50 ms on a 20 MB transcript) and hands the network call to a detached child, then exits 0. The child posts, records the new thought's id, and writes one line to the log.

### 5. End a session and look

```bash
tail -4 ~/.local/state/open-brain/session-capture/log
```

```text
2026-09-22T14:02:40.318Z prepared: session 8de5e1e1-… (PreCompact auto), 3 prompt(s), 6 source id(s) → posting in pid 47210
2026-09-22T14:02:46.902Z captured session=8de5e1e1-… harness=claude-code event=PreCompact trigger=auto id=2b91c0e4-… sources=6
2026-09-22T15:10:02.114Z prepared: session 8de5e1e1-…, 4 prompt(s), 8 source id(s) → posting in pid 48122
2026-09-22T15:10:09.870Z captured session=8de5e1e1-… harness=claude-code id=54f612f5-… sources=8 supersedes_sent=2b91c0e4-…
```

Then, from any client with a read key, `search_thoughts` for something the session did — and against the database, `SELECT * FROM trace_provenance('<the new id>')` lists the thoughts the session read (a SQL function from migration 025, not an MCP tool).

## Expected Outcome

- One current thought per episode of the session — captured before each compaction and at the end, each superseding the episode's last — type chosen by the metadata model, `metadata.source` = `claude-code` or `codex`, `derived_from` = the thoughts that episode retrieved and captured. With the opt-in model summary on, the text is what a local model wrote (or the derived text, on any fallback) and `metadata.summary_model` names the model.
- `~/.local/state/open-brain/session-capture/<session_id>.json` holds the first episode's thought id and its summary's fingerprint, `<session_id>_e2.json` the second's, and so on; the same summary is never sent twice; a changed one supersedes its own.
- A session with no human prompt, or no transcript, is skipped with exit 0 and a `skip:` line in the log.
- A single-line secret is sent with it blanked to `[redacted:<reason>]`, the `captured` line saying `redactions=N` and the thought carrying `metadata.redactions` = that count; a multi-line key blob (a pasted PEM or PGP block, a wrapped base64 key), a hit the blanking leaves in the text, or any hit under `OB1_CAPTURE_ON_SECRET=refuse`, is refused with exit 1 and a `refused —` line naming the shape (the block, or the reason and the source and the offset); that episode is not sent, and the session's other episodes still are.
- A post that fails (the server down, its database down, a timeout, the server's own `Error:` such as a grant it lacks or its agent registry being away — anything that is not a `Refused:`) keeps its payload under `pending/`; the next run of the hook that captures, for any session, posts what is pending oldest first and its own summary last (five per run, up to five more that waited behind a claim it cleared, and the stale ones beside those dropped as well) — a run that skips posts nothing. Of two payloads of one session only the newest is posted — a summary is cumulative — and the older goes to `dead/` unposted. While a session's end waits under `pending/`, its current thought is its last checkpoint, whose `Checkpoint:` line says `continuing`; the end's delivery supersedes it. Each run claims the files it posts by moving them into `inflight/<pid>/`, so two sessions ending together never post each other's payload; a run whose payload has an older one of the same session in another run's hands — a compaction's child still posting when the session ends a moment later — steps aside at once, leaving its payload under `pending/` for the run that clears the earlier one's claim — landing it, dropping it, or failing on it — to post next (failing that, the next run of the hook), so the end supersedes the checkpoint instead of standing beside it; and an older payload whose session has a newer one in another run's hands is obsolete, since the newer covers it (SMD-2035); a run that dies leaves its claims for the next run to sweep back, as does any claim older than fifteen minutes. A wrong URL (a 4xx answer) is given up at once and named in the log. A refusal — an unauthorized key, a request the server says no to as shaped — gives up at once, into `dead/`. A payload the server keeps failing to take is never given up for the count of tries; after a week under `pending/` it goes to `dead/` (one failing on its `supersedes` first gets a try without it), and `dead/` is pruned after thirty days. The hook tells a final refusal from a kept transient, and which pointer to drop, by the server's **machine-readable verdict** — a `code` and a `retryable` flag (and, for a key allowed to know, the `derived_from` positions) carried in the tool result's `structuredContent` (SMD-1978) — falling back to the server's prose for a brain from before that field. Pull this checkout when the server is upgraded: a server that sends a newer code (SMD-2283's pointer-shape codes) to an older checkout's hook is read as a final refusal, and the summary is dropped where its bad pointer alone would have been.
- A `derived_from` id the server does not know (a thought since deleted) is dropped by the server, which records the live sources and tells a key that cannot read nothing of it — not which, not how many (the row's `derived_from` says what landed). A `supersedes` works the same way for the capture-only key the hook holds (SMD-2473). The server writes the pointer only when it names a thought this key captured itself, under its agent id, that still exists, that no other key or board-sync has taken since (SMD-2638, migration 082: a write key's capture of the same text, an edit of its text, or board-sync adopting the row; since migration 092 (SMD-2708), also a reviewer's accept or a write key's pointer that puts it over a thought this key did not capture or one another key took, directly or through a chain of its own summaries — a reject or an unlink that clears that pointer gives it back; a tag or other metadata edit, a vector a worker fills in, an operator's metadata backfill, or a write key linking two of this key's own summaries does not count, unless a summary below the link is, or later becomes, taken that way), and that nothing supersedes yet — two summaries naming the same earlier one leave the second without its pointer. A pointer the hook wrote before such a taking lapses: the earlier summary reads current again, because another key now holds it. A pointer written by a server from before SMD-2638 does not lapse, and a summary captured before then is not noted when a write key re-captures it unchanged. Any other pointer it drops without a word, and the reply is the same either way, so the hook cannot tell and does not try. The log's `supersedes_sent=` is the pointer the post that landed named; the new row's `supersedes` is what was written. While the server's agent registry is unreachable it cannot tell which thoughts are this key's: it answers an `Error:` for every pointer and the payload waits. So does one the server could not check because it cannot read the target's capture record (a missing SELECT on `thought_audit` or `thoughts`, or the store's own error). Once at least one attempt has failed on the pointer, it is dropped from the fifth attempt on (four tries of any kind made), or once the payload is a week old; the payload itself is never given up for the count. A refused pointer — a write key's naming a thought since deleted, or a capture key's on a server from before SMD-2473 — the hook drops, and posts again. The log's `note=` says what the hook dropped.

## Troubleshooting

**Issue: `session-capture: no endpoint or key`**
Solution: write the config file from step 2. `OB1_BRAIN_URL` and `OB1_CAPTURE_KEY` in the environment override it (a container, a test); `OB1_SESSION_CAPTURE_CONFIG` names another file.

**Issue: `--check` says the key cannot capture**
Solution: the key is read-scoped. Mint one with `--scope capture` (step 1), or use a write key and accept the warning.

**Issue: `pending/` fills up, the log says `pending … error="Unable to connect…"` (under Bun; `"fetch failed"` under Node)**
Solution: the endpoint is not reachable from this machine. Check the URL in the config and that the server is up (`curl http://127.0.0.1:8010/health` → `ok`). The payloads deliver on the next run once it is.

**Issue: the log's `captured` line says `redactions=N`, and the thought reads `[redacted:high-entropy token]`**
Solution: something in a prompt or in the assistant's last message looked like a token and was blanked before the summary left — `--dry-run` the transcript to see the text as sent and the `secret scan:` line naming each span's shape, the prompt (or the outcome, the title) it sat in and its offset in that prompt as blanked. A blanked non-secret costs a few words of one summary; nothing to do unless the marker sits where a value you meant to keep was — then reword the prompt next time.

**Issue: the log says `refused — … at char N after 3 redactions`**
Solution: the blanking left something the scan still reads as a secret — a digest in the path of a URL whose password was blanked is the known shape — and the episode was refused rather than sent. `--dry-run` the transcript to see the blanked text and the hit. Take the value out of the conversation before ending the session (or capture a summary by hand with the `session-summary` skill). Under `OB1_CAPTURE_ON_SECRET=refuse` every hit reads this way, without the `after`: that mode drops the episode for any hit, as the hook did before SMD-2127.

**Issue: an episode's summaries stand side by side instead of superseding each other**
Solution: find the episode's `captured` lines in the hook's log (`grep 'session=<id>'`; the log interleaves sessions). Each episode chains on its own: lines from the second episode on carry `episode=N`, a line without it is the first, and episodes are meant to stand apart, so compare lines of one episode only.
- **No `supersedes_sent=`, and `note="supersedes dropped: …"`:** the hook dropped the pointer. Either a server from before SMD-2473 refused it (the note quotes `Refused: …`), or the server could not judge it and the last resort posted without it — after at least one failure on the pointer: from the fifth attempt, or once the payload was a week old. The note quotes only the last error, cut short; that session's earlier `pending … error="…"` lines carry the pointer's own — `could not be attributed while the agent registry is unavailable`, or `could not be checked against the target's capture record (…)`, the server unable to read `thought_audit` or `thoughts` — a missing SELECT, or the store's own error, which the parentheses quote, cut short.
- **`supersedes_sent=<id>`:** the post named the pointer, and the server dropped it without a word, because it could not prove the target is this key's own standing thought (SMD-2473). Check two things with `podman compose -f deploy/compose.yaml …` (or `docker compose`) from the repo root, plus the `-f` files the stack runs with:
  - `… logs -t api | grep 'agent registry'` (the REST core, which resolves the hook's key behind `/mcp` since SMD-2287; `server` on a stack before it), run after the hook has posted again and without narrowing the time window: a line appears when a key's failure starts or changes, and a recreated container starts a fresh log. `resolve_agent cannot attribute key "<name>" as this server is set up` names its fix — the migration, the role's search_path, or the registry tables' grant, which runs as their owner (`cd db && bun migrate.ts --grant <role> --url <the owner's connection string>`). `resolve_agent refused key "<name>"` means the registry function and the server disagree (it refuses only a malformed digest or an empty name, which the server rejects before asking): bring the server and the brain to the same release. Either way the key has no agent id, and every pointer of its is dropped. On the compose stack the server connects as `postgres`, so the grant and search_path causes are for a role of your own on your own Postgres; `preflight` reports the migration, the search_path and a missing SELECT on the registry tables, not the INSERT or UPDATE `resolve_agent` writes them with — only this line names that.
  - `… exec postgres psql -U postgres openbrain`, then `SELECT actor_name, canonical_agent_id FROM thought_audit WHERE thought_id = '<the supersedes_sent id>' AND action = 'capture';`, and this key's own id with `SELECT canonical_agent_id FROM ob1_agents WHERE label = '<the key's name>';`. No agent id: written while the registry could not attribute the key `actor_name` names. This key's own: the thought has since been deleted, or another key has taken it — an `update` row on it, or on a thought its `supersedes` chain reaches, by another actor that re-captured it (`recaptured`), changed its text (`content`), adopted it as a ticket's row (board-sync's `metadata` gaining `issue`), or pointed it at another key's thought (`supersedes`) (`SELECT action, actor_name, diff FROM thought_audit WHERE thought_id = '<id>' ORDER BY seq;`). Another agent's: the summary's text was already in the brain under another key, or the hook now holds a new key under a new name (a rename or a rotation keeps the agent id).

Once the key resolves, its next summaries supersede each other again, though the first after the fix still stands beside the last one before it. To link two that stand side by side, use a write key: `update_thought` with `id` the newer summary and `supersedes` the older — the `id=` values of that session's `captured` lines. A link between two of this key's own summaries takes neither (migration 092), so the hook's next summary still supersedes the newer one — unless the older was written while the registry could not attribute the key (its capture row has no agent id), or is, or later becomes, taken by another key: that one counts as another's, the link takes the newer, and the hook's pointer onto the newer lapses.

**Issue: a work claim lapsed though the hook is installed**
Solution: from a terminal in that worktree, `bun session-capture.mjs --renew-claims` renews now and prints the reason; `grep 'claims:' <state>/log` shows what the hook said before.
- `no brain … has connector "<server>"`: the token file's `server` matches no brain's `connector`. Set the connector your agents claim through on that brain.
- `brain "<name>" (connector …) has no claim_key`, or `claims are off on brain …`: give that brain a readable claim key.
- `OB1_BRAIN_URL is set, and its brain renews no claims`: unset it in the hook's environment.
- `kept: … CLAIM_NOT_YOURS … (claim_key must be the very key …)`: the claim key isn't the key the agent claimed with. A rotated connector key, or a Codex session on its own key.
- `blocked: …`: another claim covered the work after this one lapsed, or was made on it while it was lapsed. The agent reads `<id>.blocked.json`, tells you, and deletes it once you've decided.
- `skipped …: no "server"` or another skip: the token file isn't in the rule's shape.
- No `claims:` line at all: the session's working directory was outside the worktree (the main checkout, editing the worktree by path), so the hook looked in the wrong `.work-claims/`. Or nothing fired: the claims hook isn't pasted, and the session neither compacted nor ended within the lease.
- `--check` should show a `claim key (…): ok for connector …` line for that brain.

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

Both parsers, the summary's shape and caps, every secret pattern's probe and the clean probes (uuids, digests in their spellings, paths, URLs, data URIs, identifiers, prose) with each threshold pinned alone, the redaction (SMD-2127) — a SINGLE-LINE secret blanked (the value's span, quotes of every kind, three rules at one site as one marker, the fingerprint the blanked text's, provenance untouched, the marker in what reaches the endpoint and the key not, `redactions=N` in the log) and a MULTI-LINE key blob refused (PGP armor, a footer-less body, a name-split block, a word-shaped line, found on the raw sources), a misspelt `OB1_CAPTURE_ON_SECRET` refused on every path, `metadata.redactions` sent as the count and dropped-and-reposted when the server refuses the key (SMD-2168), and under `refuse` the refusal as it was — a key past a prompt's clip included — the payload, posting, supersession, refused and unreachable pointers, the queue under two children and after a dead one, a session's end stepping aside for its checkpoint's child and posted by it once the checkpoint has landed, superseding it, obsolete and landed payloads, wrong urls and busy endpoints, the SSE shapes, the detached hand-off inside the budget against a slow endpoint, `--check`, `--dry-run`, `--print-hook` (the default pair, one event alone, Codex refused a compaction hook, an unknown event refused), a compaction checkpoint's line and its supersession by the session's end; the segmenter's boundaries rule by rule and a session of four episodes — two compactions, a move, three tickets — captured one thought each with its own provenance, a re-ending superseding only the episode that changed, a secret in one episode refusing that episode alone, the newest five of seven handed to the run's child and the rest to a later run, the segmentation `--dry-run` prints (SMD-2013); and the opt-in model summary (SMD-2014) — the egress rule (local declared, never guessed; deny/allow/off), the config knobs read from the file and the environment, `modelSummary` returning the model's text on the happy path and the derived text on every fallback (off, unconfigured, egress-refused before anything is sent, a secret in the model's own words, an empty answer, an HTTP error, a timeout), `prepare` attaching the assistant excerpt only in model mode, and the end-to-end child posting the model's text with `metadata.summary_model` while `source` stays the harness. The server's own `capture_thought` `metadata` argument — a caller key stored, a reserved key refused — is covered by `server-portable/test-e2e-sql.ts`. The write fan-out (SMD-3314) runs against a second fake brain that keeps `client_key` as the server since migration 112 does: what is copied and what is not, every result shape, the order under a brain away or busy, the skipped, dropped and kept cases, `--check`, `--print-hook --fan-out` and the detached child. The claims renewal (SMD-3602) runs against a fake brain answering `renew_claim` as migration 115 does. It covers:

- the worktree walk (a worktree nested in a checkout is its own; a symlinked directory resolves), and the token-file reads, names, ids and unreadable files;
- the quarter-lease interval, a file's own lease, and two runs at once in one process renewing once;
- checkpoints, Stop turns when due and not, events the hook does not capture on, and `--claims` on a session hook;
- released and taken-over claims ending their files without the token, and a planted symlink replaced rather than followed;
- `WORK_CLAIMED` writing `<id>.blocked.json` and holding renewals until it is deleted, from the hook's renewal or the agent's own call (an own-piece claim named); the agent's renewal recorded; a claim the hook knows lapsed checked against the claims made since (blocked, renewed, renewed when live, unchecked without a ticket, kept when unlisted); a renewal whose reply reports claims made or renewed while the claim had lapsed (or unread, or the lapse unread) marked, its own or the agent's, exiting 1 by hand, a long one cut saying so, and one reporting none not but logged as a lapse; the expiry recorded the renewal's own, whatever a piece named later says; the lapse check counting a claim renewed during the lapse, naming each claim's id and saying it did not renew, and logging a quiet lapse on an older brain; a `WORK_CLAIMED` naming several claims marked and cut saying so, the own-piece note read off the whole reply; a `claim_work` for other work carrying the token not marked; each kept case (`CLAIM_UNATTRIBUTED`, `REFUSED_CLAIM_INPUT`, a brain echoing the token, masked, a JSON-RPC -32602 envelope read as a key that cannot renew), an ended file that cannot be rewritten, and symlinked token files and directories skipped;
- a token file or directory others can read (644, 640, 755) closed to 600 or 700 and named, a file or the directory swapped for a symlink mid-run left alone, a FIFO swapped in mid-run not holding the run, a symlink at the ended file's temporary name refused, a token file that is a hardlink skipped and one swapped in mid-run left alone, and no claim key or no worktree;
- the brain chosen by `server` against each brain's `connector`, one brain or several: a file with no `server`, one naming another brain's or an unkeyed brain's connector, and `OB1_BRAIN_URL`'s brain renewing nothing;
- the detached child at a tool and at a checkpoint, `--renew-claims` and `--claim` in either case and for an id with a bad file or none, `OB1_CLAIM_KEY` and its warnings, a `--claim` that is no uuid refused unshown, the claims hook under a mistyped `OB1_CAPTURE_ON_SECRET`, `--print-hook --claims`, `--check` (the key's source and connector, a key with no connector failed, a key file others can read, one `OB1_BRAIN_URL` leaves unused), a missing, `~` or empty claim key turning claims off while the capture runs, and the config's refusals;
- tokens masked in a brain's words, as markdown escapes them, in an error the call throws on, and in a ticket.

It runs in CI's repo-consistency job.
