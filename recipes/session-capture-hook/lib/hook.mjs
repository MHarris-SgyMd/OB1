/**
 * lib/hook.mjs — what the session hook is (SMD-4338): its version, the one
 * source of it (SMD-4378), the harnesses it serves and the events it runs on,
 * each in one table, and what an event says of the session. It imports
 * nothing.
 */

/**
 * The hook's version, the one source of it (SMD-4378). It is a constant, not a
 * read of `metadata.json`, because an installed hook may be a copy of the
 * script and its lib/, without the recipe's other files. The suite fails if it
 * differs from `metadata.json`'s. `--version`
 * prints it, `--check` and `--dry-run` name it first, and each summary carries
 * it as `metadata.hook_version`: the hook that prepared the payload, whose
 * rules wrote its derived text and header. A model's summary is written when
 * the payload is sent, which a later hook may do; its stamp names the hook
 * that prepared the model's input.
 */
export const HOOK_VERSION = "1.11.3";
/** A version's shape, three numbers: the only stamp `postCapture` sends. The suite holds HOOK_VERSION to it. */
export const VERSION_RE = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;

/**
 * The harnesses, and what differs between them: the label a message uses,
 * where the printed hook is pasted, and the timeout a pinned hook carries —
 * Claude Code raises SessionEnd's shared 1.5 s budget to a hook's own (≤ 60),
 * Codex allows at most 3 s (fifth review pass: the 3-or-10, the labels and the
 * paths were ternaries beside the events' table).
 */
export const HARNESS = Object.assign(Object.create(null), {
  "claude-code": { label: "Claude Code", settings: "~/.claude/settings.json (or .claude/settings.json in a project)", timeoutSec: 10 },
  codex: { label: "Codex", settings: "~/.codex/hooks.json", timeoutSec: 3 },
});
export const HARNESSES = Object.keys(HARNESS);
/**
 * The events this hook runs on, in one table (SMD-2012; second review pass:
 * the same three names were spelled in four structures that had to agree).
 * `checkpoint` is what a summary captured at the event says of the session —
 * `compacted` before a compaction, `running` at a turn's end, nothing at an
 * end; `timeout` whether the printed hook pins 10 s (3 on Codex): SessionEnd's
 * budget is shared, and a compaction waits on PreCompact; `interval` whether
 * the printed command carries --min-interval, Stop's floor — and prepare()
 * gates on it; `trigger` whether the harness sends one with it; `harnesses`
 * which harness fires it, `byDefault` whether --print-hook prints it unasked.
 * The table is the one reader of these facts (fourth review pass: the gate,
 * the interval's event and the trigger's were still spelled as names). Claude
 * Code's PreCompact fires before a compaction, manual or automatic — the
 * checkpoint a long session already has; Codex has no compaction hook, so its
 * default is SessionEnd alone. An event outside the table is
 * not the hook's: prepare() skips it, since SubagentStop or UserPromptSubmit
 * would post a final-looking summary of a session still running.
 */
// A null prototype, and eventSpec() by own property: on a plain object
// `EVENTS["constructor"]` is Object's, and "toString" passed every check as an
// event — printed as a hook that never fires, captured as an end (third review pass).
export const EVENTS = Object.assign(Object.create(null), {
  SessionEnd: { checkpoint: undefined, timeout: true, interval: false, trigger: false, harnesses: HARNESSES, byDefault: true },
  PreCompact: { checkpoint: "compacted", timeout: true, interval: false, trigger: true, harnesses: ["claude-code"], byDefault: true },
  Stop: { checkpoint: "running", timeout: false, interval: true, trigger: false, harnesses: HARNESSES, byDefault: false },
});
export const HOOK_EVENTS = Object.keys(EVENTS);
/** The table's row for a name, or undefined — the one way the table is read. */
export const eventSpec = (name) => (typeof name === "string" && Object.hasOwn(EVENTS, name) ? EVENTS[name] : undefined);
/** What --print-hook prints with no --event: the table's default events the harness fires (second review pass: a second table beside the first). */
export const DEFAULT_EVENTS = Object.fromEntries(HARNESSES.map((h) => [h, HOOK_EVENTS.filter((e) => EVENTS[e].byDefault && EVENTS[e].harnesses.includes(h))]));
/** The events that carry a trigger, and those the interval gates — derived once, so a message cannot drift from the table (fifth review pass). */
export const TRIGGER_EVENTS = HOOK_EVENTS.filter((e) => EVENTS[e].trigger);
export const INTERVAL_EVENTS = HOOK_EVENTS.filter((e) => EVENTS[e].interval);
/** The two triggers Claude Code sends with PreCompact; anything else is recorded nowhere. */
export const TRIGGERS = ["auto", "manual"];

/** What the event says about the session, for renderSummary's Checkpoint line: `compacted` with its trigger, `running`, or nothing for an end. */
export function checkpointOf(hook) {
  const spec = eventSpec(String(hook.hook_event_name ?? ""));
  if (!spec?.checkpoint) return undefined;
  return spec.trigger ? { kind: spec.checkpoint, trigger: TRIGGERS.includes(hook.trigger) ? hook.trigger : undefined } : { kind: spec.checkpoint };
}
