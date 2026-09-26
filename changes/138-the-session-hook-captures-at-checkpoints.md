# 138. The session hook captures at checkpoints — a compaction is one, and the session's end supersedes it (SMD-2012)

**What changed.** `recipes/session-capture-hook/session-capture.mjs` holds its
three events in one table, `EVENTS` — what a summary captured there says of the
session, whether the printed hook pins a timeout, whether the command carries
the interval — and prints per-harness defaults (`DEFAULT_EVENTS`): for Claude
Code the pair `SessionEnd` + `PreCompact`, one command each, both with
`timeout: 10`; for Codex `SessionEnd` alone, since Codex has no compaction hook
— the table says which harness fires which event, and `--print-hook codex
--event PreCompact` is refused with the Stop alternative named. The table is
read by own property alone: `constructor` and `toString` are not events.
`--event` is held to the table by one reader for `--print-hook` and
`--dry-run`, `--min-interval` by one for every path, the `=` form read as the
space form is; `--dry-run` reads its flags before the transcript: a misspelt event (`precompact`) would have installed a hook that
never fires, and nothing would have said so; the refusal names the case. A
hook run under an event outside the table (`SubagentStop`) skips: it fires
mid-session and would post a final-looking summary over the checkpoint.
`checkpointOf(hook)` reads the event — PreCompact with its `trigger` when it is
`manual` or `auto`, Stop as a turn's end, an absent event as an end — and
`renderSummary` writes it as a `Checkpoint:` line before the closing `Session`
line: `compacted at 2026-09-23 11:49 (auto),
continuing — the session's next checkpoint or its end supersedes this summary`,
or `turn ended at <time>, continuing`. The moment is the transcript's last
timestamp, never the clock, so the fingerprint does not move with time. The
6,000-character cap falls on the body — prompts, outcome, files — never on the
Checkpoint and Session lines. The payload carries `trigger` when it is manual
or auto; the log line names the event and the trigger when the event is not
SessionEnd. `--dry-run <transcript> --event PreCompact --trigger auto` previews
the line, the trigger held to the two a harness sends. The Stop interval stays Stop's alone: a compaction is rare and an
episode boundary, so it is never gated. The local half ran unchanged for the
event already; each capture supersedes the session's earlier one, so a session
stays one current thought that grows at every checkpoint. `--print-hook`
refuses `--event` with no value and `--min-interval` under any event but Stop,
which would otherwise validate and vanish.

**Why.** The first dogfood session (2026-09-23) ran two days across several
compactions and many tasks; installed as SessionEnd alone, the hook would have
left one thought at the end, titled after the first task, with forty-two
prompts flattened into twelve lines, and every session running beside it read
nothing until then. Claude Code's `PreCompact` fires before every compaction,
manual or automatic, with the same stdin shape plus `trigger`; it shares no
time budget (a command hook's 600 s default), cannot block the compaction, and
the transcript file may lag the conversation by a message or two when it fires
— the session's end has them all. It is pinned to 10 s all the same, because a
compaction waits on it.

**Held.** `test-session-capture.mjs` (359 assertions, in CI's
repo-consistency job). The line: `checkpointOf` on each event and on a trigger
that is neither (recorded nowhere); the Checkpoint line's text, position and
determinism, undated, a Stop's; a summary past the cap ending on its Session
line with the Checkpoint whole and differing from the end's, an absurd id
clipped. The hook: `prepare` on a PreCompact input, ungated, twice; over the
fake server a compaction captured naming it and the session's end superseding
it naming none, the transcript unchanged; the log's `event=` and `trigger=`;
a foreign event and Object's own names skipped, every flag but the hook's two
refused. The by-hand forms: the default pair against Codex's single, the
timeouts, one event alone, the refusals — Codex + PreCompact, a misspelt,
empty, prefixed or inherited event, `--min-interval` off Stop, `--trigger`
misspelt, alone, under Stop or dangling, each form's flag on the other, a
promptless transcript — in one set of words, the `=` form and the last mention;
`hookJson` refusing by name; the two tables' shapes and the subsets derived
from them; the obsolete reason's words. Every pass's mutants — forty-nine
across the six commits, each listed in its commit body — fail at least one
assertion, but one equivalent, named in pass 3's body.

**Review passes.**

| Pass | Finding | Caught by | Fix |
| --- | --- | --- | --- |
| 5 | The cap's sentence was false: an unbounded session id made the closing outgrow it; the `=` form kept a dangling flag as its value where the space form read none, and its match was unpinned; the two event subsets were filtered inline at three sites and the harness timeout, labels and paths were ternaries beside the table; the hook path refused two flags and took a misspelt `--min-intervall` in silence; "gigabytes" in the record overreached what was measured | cold-read + run-it | the id clipped at 120; one rule for both forms and a tooth on the prefix; `TRIGGER_EVENTS`/`INTERVAL_EVENTS` and a `HARNESS` table; the hook path knows its two flags; the number measured |
| 4 | The stdin path took `--event` and `--trigger` on its command line in silence while every by-hand path refused them; a repeated flag resolved to the `=` form over a later space form; the interval gate, `--min-interval`'s event and the trigger's were still spelled as names outside the table; two presence checks re-spelled `has()`; the dogfood copy is the pre-change hook and its PreCompact entry was pasted without the timeout | cold-read + run-it | refused with exit 1; last mention wins; `trigger` and `interval` columns read everywhere; `has()`; the dogfood step says re-copy AND re-paste |
| 3 | Object's own names (`constructor`, `toString`) passed every `EVENTS[name]` check — printed as a hook that never fires, captured as an end over the checkpoint; `--dry-run` skipped a promptless transcript before reading its flags, so a misspelt one vanished; Codex + PreCompact was a special case in `main()`, so the export printed Codex a compaction hook; `--min-interval` had four readers and two rules; `--flag=value` was unseen, so `--trigger=auto` previewed no trigger and `--min-interval=45` printed 20; the README's by-hand line promised stderr the detached path never prints, named Node's error text under Bun, and said any run drains the queue; the fragment's count was stale | cold-read + run-it | a null-prototype table read by `eventSpec`, `harnesses` in it; flags before the transcript; `intervalFlag`; `flag()` reads `=`; README corrected; the count re-read |
| 2 | A PreCompact whose detached post lands after the session's end stands as a current "continuing" thought beside the final summary — the two-in-flight gap SMD-1989 recorded, now on the default path; a body cap that went negative with a long session id sliced from the end; `checkpointOf` read any unknown event as an end, so a command pasted under `SubagentStop` posted a final-looking summary over the checkpoint; `--trigger` was never validated on the preview path; the `--event` rule was spelled twice and the copies disagreed; four structures spelled the three events; `hookJson` printed a hook under any event name; the obsolete wording and the skill's version were held by nothing | cold-read + run-it | SMD-2035 filed; `Math.max(1, …)`; a foreign event skips; `triggerFlag`; `eventFlag` for both paths; the `EVENTS` table; a named error; a tooth and the bump |
| 1 | `clip()` cut from the tail, so a summary at the cap lost its Checkpoint and Session lines — and the checkpoint's and the end's texts clipped to the same bytes, so the end was "already captured" and the checkpoint stood as final; `--event` with no value and `--min-interval` under the default pair validated and vanished; `payload.trigger` was written for no reader and a mutant recording any value survived; `--dry-run` took an unknown event in silence and could not show the line; the skill's advice to supersede the hook's thought mid-session now leaves two current thoughts; `hookJson` on a harness with no defaults threw a TypeError; the display time was spelled three times | cold-read + run-it | the closing lines never clipped; both flags refused; the trigger logged and a tooth on an odd one; `--dry-run --event [--trigger]`; the skill says supersede from a later session; a named error; `when()` |

**Boyscout.** After the stop signal, what the passes cut for space: the
harness names read from `HARNESSES` at both CLI checks, the suite's try/catch
idiom spelled once above its users and each refusal run once, the README's
`--check` line quoted whole and its pasted block free of the second comment;
after passes 3–5, a dangling `--min-interval` says "none was given" as its
sibling readers do, and the header's exit-2 sentence names hook mode. No
behaviour changed; the suite and the checker held.

**Upgrade note.** A session captured at the cap under 1.1.0 renders a
different text under this renderer — the closing lines moved out of the clip
— so its next ending re-captures once with the same content, superseding.
One post per over-cap session, then idempotent again.

**Not taken.** A `--timeout` knob on the printed PreCompact hook (fourth
review pass): the foreground is 35–65 ms per 20 MB of transcript (a 102 MB
one: 0.2–0.3 s), so ten seconds covers the hundreds of megabytes a transcript
reaches before the runtime's string ceiling does, and a knob would be a way to
make a compaction wait longer for nothing.
`SessionStart` with the `compact` matcher — it fires after the
compaction, when the transcript already carries the compaction summary;
PreCompact sees the episode whole. One thought per compaction — that is
segmentation (SMD-2013), which changes what `supersedes` means and needs its
design note first. Gating PreCompact by `--min-interval`. Taking the fingerprint
over the body without the Checkpoint line, so that a session's end after a
checkpoint with the transcript unchanged would be a skip (first review pass): the
line is content — it says the session still runs — and the standing thought
would say "continuing" of a session that had ended; the cost is one supersede
per compacted session for a paragraph of difference, which is the price of a
summary that is right about its own state. A real compaction writes its
summary line into the transcript and moves the last timestamp, so compactions
post again at each; an unchanged transcript under the same trigger is a skip.
A structured checkpoint field on
the write, so the fingerprint could exclude the prose and a ranker need not
read `^Checkpoint:` — `capture_thought` has no such argument; it belongs with
SMD-2013's design note, and SMD-2035 names it. The bump is `patch`: a recipe
with no schema change, by FORK.md's rule.

**Follow-ups.** SMD-2035 (a checkpoint landing after the end stands beside
it: a run waits for its session's in-flight predecessor, or the server
arbitrates), SMD-2013 (per-episode thoughts), SMD-2014 (opt-in model
summary). Dogfood: the PreCompact entry is in `~/.claude/settings.json` since
2026-09-23, pasted before this change and so without its `timeout: 10`; after
this merges, re-copy the script to `~/.local/share/open-brain/` AND re-paste
`--print-hook claude-code`'s output, so the line appears and the compaction
waits at most ten seconds on it.

**Upstream status.** Not upstream.
