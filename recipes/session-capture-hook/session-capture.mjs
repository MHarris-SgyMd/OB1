#!/usr/bin/env bun
/**
 * session-capture.mjs — a session hook for Claude Code and Codex that captures
 * ONE summary thought into Daemonic Brain at each of a session's checkpoints — a
 * compaction (Claude Code's PreCompact) and the session's end — with the
 * thoughts the session retrieved as its provenance (SMD-1298, SMD-2012) —
 * one thought per EPISODE of the session, not per session (SMD-2013): a
 * long session is several pieces of work, and each gets its own summary, its
 * own provenance and its own supersedes chain.
 *
 * What it sends: a summary this script derives from the transcript — what was
 * asked (the human prompts), what came out (the assistant's last message), what
 * changed (file paths, a commit count, PR links), and how many thoughts the
 * session read from or wrote to the brain. Those thoughts' ids go in
 * `derived_from`, so the trace_provenance SQL function (migration 025) walks
 * from the summary to them and find_derivatives from any of them to the
 * session; search results mark a superseded hit. The transcript itself is
 * never sent, and nothing is read from the brain — the hook holds a
 * capture-scoped key (`bun keygen.ts --scope capture`), which the server
 * registers `capture_thought` for, the priority writers on its own
 * thoughts (SMD-3664) and the open-item writers on its own items (SMD-3665),
 * and no read.
 *
 * Before anything leaves the machine the summary is scanned for secrets — the
 * common key prefixes, credential assignments, a URL carrying a password, and
 * high-entropy tokens. A secret on ONE line is REDACTED (SMD-2127): the span
 * becomes `[redacted:<reason>]` in the prompts, the outcome and the title
 * before the text is rendered, the text is scanned again, and only a text that
 * second scan finds clean is sent. A MULTI-LINE key blob — a pasted PEM or PGP
 * block, a wrapped base64 key — is REFUSED, not redacted: blanking a block
 * precisely proved leaky, and losing one summary beats sending a line of a key.
 * A refusal prints the reason (never the match), exits 1, and the session ends
 * as it would have. OB1_CAPTURE_ON_SECRET=refuse refuses on every hit, blob or
 * not. Exit 2 is the one code a Stop hook may block with; as a hook
 * this script never uses it (the by-hand forms — --print-hook, --dry-run — exit
 * 2 on misuse).
 *
 * Time budget: Claude Code gives SessionEnd hooks 1.5 s by default (raised to the
 * hook's `timeout`, at most 60), Codex 1 s (at most 3); PreCompact shares no
 * budget, but a compaction waits on it, so it is printed with the same 10 s. The hook does its local
 * work — read, summarise, scan — in the foreground, well inside a second, then
 * hands the network call to a detached child and exits 0. The child posts,
 * records the new thought's id in the state directory, and appends a line to the
 * log; a post that fails waits under pending/ for a later run, which claims what
 * it posts by a rename so two runs never share a file, drops an older
 * payload of a session that has since ended again as obsolete, and steps
 * aside for an earlier payload of its own session still in another child's
 * hands, so that it lands first and the later one supersedes it (SMD-2035).
 * A later run for
 * the same session (a compaction, a Stop hook with --min-interval, or a session
 * resumed under the same id — `claude --resume`, a Codex resume — ending again)
 * captures a fresh summary that SUPERSEDES the earlier one, so a session is one
 * current thought however many times it is captured; a summary of a session
 * still running says so in a Checkpoint line, which its end drops. A fork under
 * a new id is a new session with its own summary.
 *
 * Both harnesses hand a hook the same JSON on stdin — session_id,
 * transcript_path, cwd, hook_event_name — so one script serves both; the
 * transcript's first line says which wrote it.
 *
 *   bun session-capture.mjs --version                    # prints "session-capture <version>" (SMD-4378)
 *   bun session-capture.mjs --print-hook claude-code     # the settings.json to paste (SessionEnd + PreCompact); installs nothing
 *   bun session-capture.mjs --print-hook codex           # the hooks.json to paste (SessionEnd: Codex has no compaction hook)
 *   bun session-capture.mjs --print-hook claude-code --event Stop --min-interval 20   # the coarser checkpoint: a turn, at most every 20 min
 *   bun session-capture.mjs --check                      # config + endpoint (warned if on a pre-v2.0.0 stack's legacy root or tier route) + key scope; writes nothing
 *   bun session-capture.mjs --dry-run <transcript.jsonl> # print what WOULD be sent; sends nothing (--event PreCompact --trigger auto previews a checkpoint's)
 *   bun session-capture.mjs --print-hook claude-code --claims   # the claims hook: renews a worktree's work claims while a session works (SMD-3602)
 *   bun session-capture.mjs --renew-claims [--cwd <dir>] [--claim <id>]  # renew the claims this worktree keeps tokens for, now
 *   bun session-capture.mjs --copy-forget <id> --from <name> [--client-key <uuid>] [--brain <name>] [--yes]  # copy a forget the hook missed (SMD-4411); says what it would do until --yes
 *   bun session-capture.mjs                              # as the hook: hook JSON on stdin
 *
 * Bun or Node 18+, no dependencies. The hook is this file and the modules in
 * lib/ beside it (SMD-4338): a hook command names this file, a copy of the hook
 * copies lib/ with it, and every export is this file's. Its code is lib/'s:
 * this file re-exports it and, run as the entry point, calls lib/cli.mjs's
 * main(). Config (0600, never in a hook command line):
 *   ${XDG_CONFIG_HOME:-~/.config}/open-brain/session-capture.json
 *   { "url": "http://127.0.0.1:8010/mcp", "key": "<the raw capture key>" }
 * or several brains, each its own url and capture key (SMD-3313):
 *   { "brains": [{ "name": "stable", "url": "…/mcp", "key_file": "…" }, { "name": "canary", … }] }
 * A brain's `claim_key` (or `claim_key_file`) is the key agents claim work
 * with, which renews the claims whose tokens a worktree keeps in
 * `.work-claims/` (SMD-3602).
 * State and log: ${XDG_STATE_HOME:-~/.local/state}/open-brain/session-capture/
 * (the first brain's; each brain after it under brains/<name>/, its own queue,
 * chains and log: a brain away delays no other).
 */

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { shellWord, shownUrl } from "./lib/util.mjs";
import { CONFIG_PATH, SELF, STATE_BASE, STATE_DIR, readState, useSelf, useStateRoot } from "./lib/state.mjs";
import { SECRET_MODES, SECRET_PATTERNS, describeRedactions, redactSecrets, redactionMarker, scanForSecrets, secretMode } from "./lib/secrets.mjs";
import { CaptureError, REFUSAL_RE, SDK_ERROR_RE, parseRpcBody, resultText, rpc } from "./lib/rpc.mjs";
import { endpointOf, loadBrains, loadConfig, splitUserinfo } from "./lib/config.mjs";
import { CLAIMS_DIRNAME, claimFiles, renewClaim, renewClaims, renewEveryMs, worktreeRoot } from "./lib/claims.mjs";
import { DEFAULT_EVENTS, EVENTS, HARNESS, HARNESSES, HOOK_EVENTS, HOOK_VERSION, INTERVAL_EVENTS, TRIGGERS, TRIGGER_EVENTS, VERSION_RE, checkpointOf, eventSpec } from "./lib/hook.mjs";
import { LIMITS, NOT_TICKETS, assistantExcerpt, cleanEpisode, episodeChain, gateFindings, headerTickets, provenanceOf, redactEpisode, renderSummary, scanSummary, segment, stripInjected, ticketsIn } from "./lib/episode.mjs";
import { parseClaudeCode, parseCodex, sniffHarness, summariseTranscript } from "./lib/transcript.mjs";
import { egressRefusalForModel, modelStatusLine, modelSummary } from "./lib/model.mjs";
import { RUN_MAX, aheadOf, landedAfter, landedBefore, newerInFlight, pointerFor, postCapture, postPending, prepare, providerMends, verdictOf } from "./lib/post.mjs";
import { FANOUT_TOOLS, drainWrites, dropCopiesOf, enqueueWrite, fanOutPlan, lostForget, pendingWrites, postWrite, queueForget, resultIsError } from "./lib/writes.mjs";
import { claimsHookJson, fanOutHookJson, hookJson, main } from "./lib/cli.mjs";
// The exports that moved to lib/ (SMD-4338), re-exported so every name this file exported before is still its own: the suite,
// the agent runner, server-portable's suite and db/test-live.ts import from here.
export { CLAIMS_DIRNAME, CONFIG_PATH, CaptureError, DEFAULT_EVENTS, EVENTS, FANOUT_TOOLS, HARNESS, HARNESSES, HOOK_EVENTS, HOOK_VERSION, INTERVAL_EVENTS, LIMITS, NOT_TICKETS, REFUSAL_RE, RUN_MAX, SDK_ERROR_RE, SECRET_MODES, SECRET_PATTERNS, STATE_BASE, STATE_DIR, TRIGGERS, TRIGGER_EVENTS, VERSION_RE, aheadOf, assistantExcerpt, checkpointOf, claimFiles, claimsHookJson, cleanEpisode, describeRedactions, drainWrites, dropCopiesOf, egressRefusalForModel, endpointOf, enqueueWrite, episodeChain, eventSpec, fanOutHookJson, fanOutPlan, gateFindings, headerTickets, hookJson, landedAfter, landedBefore, loadBrains, loadConfig, lostForget, main, modelStatusLine, modelSummary, newerInFlight, parseClaudeCode, parseCodex, parseRpcBody, pendingWrites, pointerFor, postCapture, postPending, postWrite, prepare, provenanceOf, providerMends, queueForget, readState, redactEpisode, redactSecrets, redactionMarker, renderSummary, renewClaim, renewClaims, renewEveryMs, resultIsError, resultText, rpc, scanForSecrets, scanSummary, secretMode, segment, shellWord, shownUrl, sniffHarness, splitUserinfo, stripInjected, summariseTranscript, ticketsIn, useStateRoot, verdictOf, worktreeRoot };

// This file, by its own url: the path its detached children re-run and its guard compares (lib/state.mjs, SELF).
useSelf(fileURLToPath(import.meta.url));

// Run as the entry point — argv[1] resolved through any symlink (sixth review
// pass: a hook installed through ~/bin compared the link with the real path,
// never ran, and exited 0 saying nothing).
const invokedAs = (() => { try { return process.argv[1] ? realpathSync(process.argv[1]) : ""; } catch { return process.argv[1] ?? ""; } })();
if ((invokedAs && SELF === invokedAs) || (typeof Bun !== "undefined" && Bun.main === SELF)) {
  main(process.argv).then((code) => process.exit(code), (e) => { console.error(`session-capture: ${e?.message ?? e}`); process.exit(1); });
}
