# 126. A session leaves one thought behind — a session-end hook for Claude Code and Codex, and a skill to ask for it (SMD-1989 / SMD-1298)

**What changed.** `recipes/session-capture-hook/session-capture.mjs` is a hook
both harnesses run at session end — they hand a hook the same JSON on stdin,
so one dependency-free script serves both, telling the transcripts apart by
their first line. It derives a summary from the transcript (the human's
prompts — a bare slash command is the harness's, one with arguments is an ask —
the assistant's last message, the files changed relative to whichever checkout
the session ran in, a commit count, PR links, the counts of thoughts retrieved
and captured), scans the prompts and outcome whole for secrets, and posts one
`capture_thought` call: `derived_from` = the ids the brain's own tool results
printed (its own tool names under any server, the generic `search`/`fetch` pair
only under a server named with `brain` as a word), `source` = `claude-code` or
`codex`, `supersedes` = the session's earlier summary when it ends again under
the same id. The local half runs in the foreground inside the SessionEnd
budgets (1.5 s / 3 s; ~50 ms on a 20 MB transcript); a detached child posts. A
failed post keeps its payload: a later run delivers what is pending oldest
first, claiming each file by a rename into `inflight/<pid>/` so two runs never
share one, dropping an older payload of a session that ended again as
obsolete, deciding the pointer at post time from what landed or the state,
re-reading the state after the post, recording a landed capture on the payload
before any bookkeeping. A `Refused:` and the SDK's `MCP error -32602` are
final; a refused pointer or position is dropped and the capture retried; a
store or connection failure waits — a week, then dead/, pruned after thirty
days — and a pointer the server keeps failing on is dropped on the last chance.
`--print-hook` prints the settings JSON, the runtime by absolute path, and
installs nothing; `--check` proves the key is capture-scoped; `--dry-run`
prints what would be sent. The transcript is never sent; the key lives in a
0600 config file, never in the command line. `skills/session-summary` is the
agent's half. The secret scan: the common key prefixes, credential and
password assignments under their everyday env-var names, a credential handed
by `--flag`, a URL carrying a password or a key, a bare 64-hex run, JWTs,
private-key blocks, high-entropy tokens; not a reference (`${VAR}`, `%VAR%`,
`process.env.X`), a placeholder or a name (no digit), a path, a digest in its
context, a uuid, an identifier. A hit refuses the whole capture, exit 1.

**Why.** On 2026-09-22 the SMD-1917 session (eight review passes, PR #101)
captured nothing until asked an hour after the merge — its MCP connection had
refused at start-up. The vendored `skills/auto-capture-claude-code` Stop hook
POSTs the transcript to a Supabase REST endpoint with a full-access key and
parses a text format Claude Code does not write.

**Held.** `test-session-capture.mjs` (300 assertions, in CI's repo-consistency
job): both parsers, ids from the brain's tool results alone, what is and is not
"asked", the summary's shape and caps, every secret pattern's probe and a clean
set of sixty lines with each threshold pinned alone, the refusal (exit 1,
nothing written, a key past a clip included), the payload without a key,
supersession, refused pointers dropped and retried, a store error kept and a
`Refused:` or an SDK error dead, oldest-first draining with obsolete and landed
payloads unposted, two children on one queue, a dead child's claims swept back,
the SSE shapes and the reply by request id, the interval gating on a pending
payload, the pointer the state names at post time and re-read after it, the
server's sentences the fake server speaks read from index.ts, the detached
hand-off inside 1.5 s against a 2.5 s endpoint, `--check` on the three scopes.

**Measured after.** Dry run on the branch's own transcript (20 MB, 29 prompts,
13 files, 34 commits, three PRs): 49 ms, scan clean. A Codex rollout (4 MB): 24 ms.

**Review passes.** Thirteen over the combined branch
(`michaelharris/smd-1298-session-end-capture`); the hook's share:

| Pass | Finding | Caught by | Fix |
| --- | --- | --- | --- |
| 1 | The queue was never drained from the hook's path; a refused `supersedes` went dead for ever; a store outage read as a refusal; six false positives and `POSTGRES_PASSWORD=hunter2` passed | cold read + run-it | drained oldest first; dropped and retried; `CaptureError` kinds; URLs and base64 blanked, a password rule at six |
| 2 | The fork's own 64-hex keys passed; `REFUSAL_RE` read "not found" as a refusal; bookkeeping inside the post's try re-posted a landed capture | cold read + run-it | a bare 64-hex run outside `name:scope:` and `sha256:`; `^Refused` alone; the id on the payload first |
| 3 | Two children shared one pending/; the scan ran on clipped text; a same-millisecond flake | cold read + run-it | claims by rename into `inflight/<pid>/`; scanned whole; a per-process sequence |
| 4 | URL blanking hid the `?key=` connector form; a pid reused by another process kept a claim; a clock ahead poisoned later endings | cold read + run-it | a named pattern on the full text; age sweep; a future time decides nothing |
| 5 | Config was checked after a payload was queued; a 4xx retried five times; digest spellings refused sessions | cold read + run-it | config first; 4xx dead and named; digests exempt |
| 6 | A landed payload beside a newer one went obsolete and its id was lost; 429, a redirect and an HTML page were a wrong url or five silent retries; a symlinked script never ran | cold read + run-it | landed payloads finish and are superseded; 408/429 kept, 3xx and HTML dead by name; `realpathSync` |
| 7 | A payload prepared before its predecessor landed posted with no pointer; a pointer the server kept failing on took the summary down | cold read | decided at post time; dropped on the last attempt |
| 8 | The Stop interval gated on the last LANDED capture, so an outage meant a payload per turn and dead/ never pruned; `search`/`fetch` under any connector were the brain's; `--min-interval 20m` ran as NaN | cold read | the last attempt gates; a `brain` server; the flag validated |
| 9 | `brain` as a substring (`brainstorm`); an undated transcript took today's date; a terminal run hung on stdin | cold read + run-it | a word; "undated"; a TTY is told the by-hand forms |
| 10 | No session_id keyed the state under "" and the payload under the transcript's id; nothing linked the fake server's sentences to the server | cold read | one id; the suite reads index.ts |
| 11 | `AWS_SECRET_ACCESS_KEY=` passed — `\b` never sits after `_`; five tries dead-lettered transient failures; a hyphen-suffix id saw another's payloads; a twin summary was dead-lettered as obsolete | cold read + run-it | an env-var prefix; a week, not a count; the name compared whole; a pending fingerprint is a skip |
| 12 | A slash command with arguments was "not asked"; a reference (`${VAR}`, `process.env.X`) was a value and compose's own line refused itself; a bare runtime word a GUI PATH may not resolve; the word `Unauthorized` dead-lettered an outage — and the code regex had never matched -32001 | cold read + run-it | bare only; a reference is no value; `process.execPath`; the codes alone, all three |
| 13 | An out-of-scope tool is an isError result, not a JSON-RPC error — the fake had the wrong shape and a narrowed key retried for a week; placeholders, names and calls were credentials; a path or a docker `--secret` spec was a flag's value; `--print-hook --event Stop` read `--event` as the harness | run-it + cold read | `SDK_ERROR_RE` final, the shape pinned in e2e; a value carries a digit; not a path or a spec; a flag's value is never a flag |

**Not taken.** Redacting a secret and sending the rest — the ticket asks for a
refusal, and a redacted summary would still say what was around the secret.
Calling a model in the hook to write prose — the summary is derived, so it is
deterministic, free and never wrong about what happened. Two runs of one
session in flight together against the same predecessor leave two current
summaries — the state is protected, the graph is not; the server would arbitrate.

**Follow-ups.** SMD-1978 (machine-readable refusal codes; a source-text tooth
holds the prose today); a probe corpus for the scan. Install on the dogfood
machine: mint, hash into `deploy/.env`, rebuild, paste the hook, classify the key.

**Upstream status.** Not upstream; its auto-capture adapter is the transcript-over-REST shape this replaces.
