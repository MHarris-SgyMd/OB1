/**
 * lib/cli.mjs — the session hook's command line (SMD-4338): the hook JSON it
 * prints to paste (`--print-hook`), its flags, and `main()`, which runs the
 * hook on its stdin or a by-hand form (`--check`, `--dry-run`, `--post`,
 * `--drain-writes`, `--renew-claims`, `--copy-forget`, `--version`). The
 * script calls `main()` when it is run as the entry point.
 */

import { readFileSync, existsSync, fstatSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { oneLine, shellWord } from "./util.mjs";
import { CONFIG_PATH, LOG_PATH, SELF, STATE_BASE, log, useStateRoot } from "./state.mjs";
import { countRedactions, describeRedactions, secretMode } from "./secrets.mjs";
import { CONNECTOR_RE, loadBrains, loadConfig } from "./config.mjs";
import { CLAIMS_DIRNAME, UUID_ONLY_RE, checkClaims, noteAgentClaimCall, renewClaims, scrubTokens, worktreeRoot } from "./claims.mjs";
import { DEFAULT_EVENTS, EVENTS, HARNESS, HARNESSES, HOOK_EVENTS, HOOK_VERSION, INTERVAL_EVENTS, TRIGGERS, TRIGGER_EVENTS, checkpointOf, eventSpec } from "./hook.mjs";
import { anchorOf, boundaryBegan, boundaryEnded, cleanEpisode, distinctPrompts, gateFindings, headerTickets, provenanceOf, when } from "./episode.mjs";
import { sniffHarness, summariseTranscript } from "./transcript.mjs";
import { modelStatusLine } from "./model.mjs";
import { checkBrain, detachPost, postPending, prepare } from "./post.mjs";
import { FANOUT_TOOLS, WRITES_PENDING, checkWrites, drainWrites, fanOutHook, kickWriteDrains, lostForget, opLabel, pendingWrites, queueForget } from "./writes.mjs";

// ── Hook JSON to paste ───────────────────────────────────────────────────────

/** The settings JSON for a harness: its default events (EVENTS, DEFAULT_EVENTS) or the one named. */
export function hookJson(harness, { event, minInterval = 20, runtime } = {}) {
  // The runtime that printed the hook, by its absolute path: a harness launched
  // from a GUI may carry a PATH without ~/.bun/bin, and a bare `bun` would fail
  // with "command not found" at every session end (twelfth review pass).
  const bin = runtime || process.execPath;
  // main() checks both names first; a caller of the export hears why, not a
  // TypeError off undefined or a hook under an event that never fires (first
  // and second review passes).
  if (!HARNESSES.includes(harness)) throw new Error(`hookJson: no default events for harness "${harness}" — one of ${HARNESSES.join(", ")}`);
  if (event !== undefined && !eventSpec(event)) throw new Error(`hookJson: "${event}" is not an event this hook runs on — one of ${HOOK_EVENTS.join(", ")}`);
  // Which harness fires which event is the table's to say, not a special case
  // in main() — the export printed Codex a PreCompact hook (third review pass).
  if (event !== undefined && !EVENTS[event].harnesses.includes(harness)) throw new Error(`hookJson: ${harness} has no ${event} hook — it fires ${EVENTS[event].harnesses.join(", ")}'s`);
  const events = event ? [event] : DEFAULT_EVENTS[harness];
  const handlerFor = (ev) => {
    const spec = EVENTS[ev];
    // The harness runs the command through a shell: a checkout under a path with a
    // space would otherwise split (first review pass).
    const cmd = [shellWord(bin), shellWord(SELF), ...(spec.interval ? ["--min-interval", String(minInterval)] : [])].join(" ");
    // Claude Code raises SessionEnd's shared 1.5 s budget to a hook's own timeout (≤ 60);
    // Codex allows at most 3 s there. The foreground finishes in well under one second either way.
    // PreCompact shares no budget — a command hook's 600 s default stands — but a
    // compaction WAITS on it, so it is pinned to the same 10 s: a read that hangs
    // must not hold a compaction for ten minutes (SMD-2012).
    // A Stop hook keeps the harness's default, 600 s in both (third review pass:
    // a pinned 30 undercut the README's advice for an enormous transcript).
    return spec.timeout ? { type: "command", command: cmd, timeout: HARNESS[harness].timeoutSec } : { type: "command", command: cmd };
  };
  return { hooks: Object.fromEntries(events.map((ev) => [ev, [{ hooks: [handlerFor(ev)] }]])) };
}

/**
 * The fan-out's settings JSON (SMD-3314): a PostToolUse hook on the write
 * tools of one connector's server, anchored — `^mcp__open-brain__` would match
 * nothing else, but the harness reads a matcher with any other character as an
 * unanchored regex — and async, so a copy never holds the session.
 */
export function fanOutHookJson({ connector = "open-brain", runtime } = {}) {
  if (!CONNECTOR_RE.test(connector)) throw new Error(`fanOutHookJson: "${connector}" is no MCP server's name`);
  const cmd = [shellWord(runtime || process.execPath), shellWord(SELF)].join(" ");
  return { hooks: { PostToolUse: [{ matcher: `^mcp__${connector}__(${FANOUT_TOOLS.join("|")})$`, hooks: [{ type: "command", command: cmd, async: true }] }] } };
}

/**
 * The claims hook's settings JSON (SMD-3602): `--claims` on every tool's
 * PostToolUse and PostToolUseFailure and on each prompt, async, so a renewal
 * never holds the session. PostToolUseFailure is where Claude Code hands the
 * agent's own refused claim calls (SMD-3874). The flag keeps it apart from the
 * fan-out's PostToolUse, which would otherwise copy a write twice, and from
 * the capture.
 */
export function claimsHookJson({ runtime } = {}) {
  const hook = { type: "command", command: [shellWord(runtime || process.execPath), shellWord(SELF), "--claims"].join(" "), async: true };
  return { hooks: { PostToolUse: [{ matcher: "*", hooks: [hook] }], PostToolUseFailure: [{ matcher: "*", hooks: [hook] }], UserPromptSubmit: [{ hooks: [hook] }] } };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

/**
 * The value after a flag — `--name value` or `--name=value` — "" when the flag
 * is last or the next token is itself a flag (thirteenth review pass:
 * `--print-hook --event Stop` read `--event` as the harness), undefined when
 * absent. The `=` form was unseen and so silently ignored: `--trigger=auto`
 * previewed no trigger, `--min-interval=45` printed 20 (third review pass).
 */
function flag(args, name) {
  // The LAST mention wins, in either form (fourth review pass: `=` won over a
  // later space form, so a corrected flag appended to the line was ignored).
  return flagAll(args, name).at(-1);
}
/** Whether a flag is present in either form. */
const has = (args, name) => flag(args, name) !== undefined;
/** Every value a flag was given, in order, in either form — `--post a --post b`, one per episode of a run (SMD-2013); `flag` is its last. */
function flagAll(args, name) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name) { const v = args[i + 1] ?? ""; out.push(v.startsWith("--") ? "" : v); }
    else if (args[i].startsWith(`${name}=`)) { const v = args[i].slice(name.length + 1); out.push(v.startsWith("--") ? "" : v); } // `--event=--min-interval` is a value forgotten too (fifth review pass)
  }
  return out;
}

/**
 * `--event` as the CLI reads it, for --print-hook and --dry-run alike (second
 * review pass: spelled twice, and the copies disagreed on the empty value and
 * the case hint). { event } — undefined when absent — or { error } to print
 * and exit 2 with. A misspelt event would install a hook that never fires;
 * an empty one (`--event --min-interval 20`, the Stop forgotten) would print
 * the default pair as silently (first review pass).
 */
function eventFlag(args) {
  const event = flag(args, "--event");
  if (event === undefined) return { event };
  if (event === "") return { error: `--event takes one of ${HOOK_EVENTS.join(", ")}; none was given` };
  if (!eventSpec(event)) return { error: `--event takes ${HOOK_EVENTS.join(", ")}, not "${event}"${HOOK_EVENTS.some((e) => e.toLowerCase() === event.toLowerCase()) ? " — the case matters" : ""}` };
  return { event };
}

/**
 * `--min-interval` as every path reads it (third review pass: four readers and
 * two rules). { minInterval } — undefined when absent — or { error }. A printed
 * Stop hook needs a floor above zero (at zero it would capture every turn); the
 * hook path takes zero as no floor.
 */
function intervalFlag(args, { aboveZero }) {
  const raw = flag(args, "--min-interval");
  if (raw === undefined) return { minInterval: undefined };
  const n = Number(raw);
  if (!(raw.trim() !== "" && Number.isFinite(n) && n >= 0 && (!aboveZero || n > 0))) return { error: `--min-interval takes a number of minutes${aboveZero ? " above zero" : ""}${raw.trim() ? `, not "${raw}"` : "; none was given"}`, raw };
  return { minInterval: n, raw };
}

/** `--trigger`, --dry-run's: with --event PreCompact, one of the two a harness sends — a typo would preview the wrong line in silence (second review pass). */
function triggerFlag(args, event) {
  const trigger = flag(args, "--trigger");
  if (trigger === undefined) return { trigger };
  if (!eventSpec(event)?.trigger) return { error: `--trigger goes with --event ${TRIGGER_EVENTS.join(" or ")}${event ? `, not ${event}` : ", which was not given"}` };
  if (!TRIGGERS.includes(trigger)) return { error: `--trigger takes ${TRIGGERS.join(" or ")}${trigger ? `, not "${trigger}"` : "; none was given"}` };
  return { trigger };
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

/** Whether stdin is a pipe or a socket, as a harness hands a hook its JSON: not a terminal, not /dev/null (SMD-4378 review pass 2). */
function stdinIsPiped() {
  try { const st = fstatSync(0); return st.isFIFO() || st.isSocket(); } catch { return false; }
}

export async function main(argv) {
  const args = argv.slice(2);
  // First, whatever else is given and whether or not stdin is piped: an
  // operator confirming an upgrade needs no config, no brain and no
  // transcript (SMD-4378). A piped stdin may be a hook command's, which then
  // does nothing at every run: the log says so, as it does for a flag no hook
  // takes (review pass 1: it was silent). On a terminal or /dev/null, as an
  // interactive shell or Claude Code's Bash tool runs it, nothing is logged
  // and no state dir is made (review pass 2).
  if (has(args, "--version")) {
    if (stdinIsPiped()) log(`--version: printed session-capture ${HOOK_VERSION}; stdin unread, nothing captured, renewed or copied (if this is a hook command, it stops every run: remove --version)`);
    console.log(`session-capture ${HOOK_VERSION}`);
    return 0;
  }
  const harness = flag(args, "--harness");
  // Exit 1, not 2: on a Stop hook 2 would block the assistant's turn over a typo in the command line (seventh review pass).
  if (harness !== undefined && !HARNESSES.includes(harness)) { console.error(`--harness takes ${HARNESSES.join(" or ")}, not "${harness}" (omit it: the transcript's first line says which)`); return 1; }
  const { mode: onSecret, error: modeError } = secretMode(); // judged where it is read: --check, --dry-run, the hook (SMD-2127)
  if (has(args, "--print-hook")) {
    if (modeError) { console.error(modeError); return 2; } // a by-hand form, exit 2 as on a bad flag (first review pass: the one path that let a typo by)
    const h = flag(args, "--print-hook") || "claude-code";
    if (!HARNESSES.includes(h)) { console.error(`--print-hook takes ${HARNESSES.join(" or ")}, not "${h}"`); return 2; }
    // The claims hook (SMD-3602): Claude Code's async PostToolUse,
    // PostToolUseFailure (SMD-3874) and UserPromptSubmit, renewing the claims a
    // session's worktree holds tokens for.
    if (has(args, "--claims")) {
      if (h !== "claude-code") { console.error(`--claims is Claude Code's: ${HARNESS[h].label} has no async hook. Its agent renews with renew_claim itself, and its session hook renews at each event it fires`); return 2; }
      for (const f of ["--event", "--min-interval", "--trigger", "--fan-out", "--connector"]) if (has(args, f)) { console.error(`${f} is not --claims's; --claims prints the claims hook alone`); return 2; }
      console.error(`# Paste into ${HARNESS[h].settings} — this prints the hook, it installs nothing. It renews the claims whose tokens a session's worktree keeps in ${CLAIMS_DIRNAME}/, through the config's claim_key. A claims hook pasted before 1.7.3 has no PostToolUseFailure entry, so it never saw the agent's own refused claim calls (SMD-3874): add that entry, or replace all three if the printed command differs from yours.`);
      console.log(JSON.stringify(claimsHookJson(), null, 2));
      return 0;
    }
    // The write fan-out's hook (SMD-3314): Claude Code's async PostToolUse, for
    // the connector the config names on a brain (or --connector, or open-brain).
    if (has(args, "--fan-out")) {
      if (h !== "claude-code") { console.error(`--fan-out is Claude Code's: ${HARNESS[h].label} has no async PostToolUse hook`); return 2; }
      for (const f of ["--event", "--min-interval", "--trigger"]) if (has(args, f)) { console.error(`${f} is the session hook's; --fan-out prints the write fan-out's PostToolUse hook alone`); return 2; }
      let connector = flag(args, "--connector");
      if (connector === "") { console.error("--connector <the MCP server's name>"); return 2; }
      if (connector === undefined) { try { connector = loadBrains().find((b) => b.cfg.connector)?.cfg.connector; } catch { /* no config: the default */ } }
      connector ??= "open-brain";
      if (!CONNECTOR_RE.test(connector)) { console.error(`--connector takes an MCP server's name — letters, digits, hyphens and underscores — not "${connector}"`); return 2; }
      console.error(`# Paste into ${HARNESS[h].settings} — this prints the hook, it installs nothing. Copies go to the brains the config gives a write_key.`);
      console.log(JSON.stringify(fanOutHookJson({ connector }), null, 2));
      return 0;
    }
    if (has(args, "--connector")) { console.error("--connector goes with --fan-out"); return 2; }
    const { event, error } = eventFlag(args); // absent: the harness's default events
    if (error) { console.error(error); return 2; }
    // A flag of the other by-hand form would validate nowhere and vanish (second review pass).
    if (has(args, "--trigger")) { console.error("--trigger is --dry-run's, to preview a checkpoint; a hook reads the trigger the harness sends"); return 2; }
    if (event !== undefined && !EVENTS[event].harnesses.includes(h)) {
      const who = HARNESS[h].label;
      console.error(`${who} has no ${event === "PreCompact" ? "compaction" : event} hook: --print-hook ${h} prints ${DEFAULT_EVENTS[h].join(" and ")}; for a checkpoint on ${who} print --event ${INTERVAL_EVENTS.join(" or ")} --min-interval <minutes>`);
      return 2;
    }
    // A Stop hook printed with `--min-interval 20m` would run with NaN and capture every turn (eighth review pass).
    const { minInterval: mi, error: intervalError } = intervalFlag(args, { aboveZero: true });
    if (intervalError) { console.error(intervalError); return 2; }
    // The interval rides on a Stop hook's command line and nowhere else: given with the default pair it would validate and vanish (first review pass).
    if (mi !== undefined && !eventSpec(event)?.interval) { console.error(`--min-interval applies to --event ${INTERVAL_EVENTS.join(" or ")} alone; the other events capture every time`); return 2; }
    const where = HARNESS[h].settings;
    console.error(`# Paste into ${where} — this prints the hook, it installs nothing. Off until you do.`);
    console.log(JSON.stringify(hookJson(h, { event, minInterval: mi ?? 20 }), null, 2));
    return 0;
  }
  if (has(args, "--check")) {
    console.log(`session-capture ${HOOK_VERSION}`); // the copy being checked, before the mode and config checks (SMD-4378); a bad --harness is refused before it
    if (modeError) { console.error(`session-capture: ${modeError}`); return 1; } // before the config: a missing config must not hide the typo (first review pass)
    let brains;
    try { brains = loadBrains(); } catch (e) { console.error(`session-capture: ${e.message}`); return 2; }
    // Each brain checked, and named when there are several (SMD-3313); the
    // run's exit is the worst brain's.
    let code = 0;
    for (const b of brains) {
      useStateRoot(b.root);
      const tag = brains.length > 1 ? `[${b.name}] ` : "";
      const c = await checkBrain(b.cfg, tag, onSecret);
      code = Math.max(code, c, await checkWrites(b, brains, tag), await checkClaims(b, tag));
    }
    // OB1_CLAIM_KEY is the one-brain shape's; beside a brains list it is read by no brain (review pass 1).
    if (process.env.OB1_CLAIM_KEY && (brains.some((b) => b.listed) || process.env.OB1_BRAIN_URL)) console.error(`warning: OB1_CLAIM_KEY is set but no brain uses it — it is read for the one-brain config file alone${process.env.OB1_BRAIN_URL ? " (OB1_BRAIN_URL's brain renews no claims)" : "; with a brains list give the brain its own claim_key"}`);
    return code;
  }
  if (has(args, "--renew-claims")) {
    // The claims a worktree keeps tokens for, renewed now: by hand (the
    // current directory's worktree, or --cwd's), or as the hook's child, told
    // by id which claims it stamped (SMD-3602).
    const given = flagAll(args, "--claim");
    // An empty --claim (`--claim --cwd X`, `--claim=`) is refused, not read as "every claim" (review pass 5).
    if (given.some((v) => !v)) { console.error("session-capture: --claim takes a claim id (a uuid); none was given"); return 2; }
    const ids = given.map((s) => s.toLowerCase());
    // A --claim that is no claim id is refused unechoed: a token given there by mistake is not printed or logged (review pass 4).
    if (ids.some((id) => !UUID_ONLY_RE.test(id))) { console.error("session-capture: --claim takes a claim id (a uuid) — the value given is not one, and is not shown"); return 2; }
    let brains;
    try { brains = loadBrains(); } catch (e) { console.error(`session-capture: ${e.message}`); return 2; }
    const cwd = flag(args, "--cwd") || process.cwd();
    const dir = isAbsolute(cwd) ? cwd : join(process.cwd(), cwd);
    const outcomes = await renewClaims(dir, brains, { now: true, ...(ids.length ? { only: ids } : {}) });
    // The hook's child writes to the log already; a run by hand prints, terminal or not (review pass 4: an agent's shell is no terminal).
    if (!has(args, "--from-hook")) {
      if (!outcomes.length) console.log(`no claims to renew: ${worktreeRoot(dir) ? `no token files in ${join(worktreeRoot(dir), CLAIMS_DIRNAME)}/` : "not inside a git worktree"}`);
      for (const o of outcomes) console.log(o.line);
    }
    // A renewal that revived a lapsed claim others claimed meanwhile is renewed and blocked: 1, as a blocked one is (review pass 1).
    return outcomes.some((o) => (!o.ok || o.blocked) && !o.ended) ? 1 : 0;
  }
  if (has(args, "--copy-forget")) {
    // A forget copied again, by hand (SMD-4411): one the hook never queued — its config unreadable at that run, or the
    // hook not run — which the first brain now refuses as FORGOTTEN, so a repeat through the connector copies nothing.
    // Queued as the hook queues one: the drop on every brain's queue with it, queued for each brain with a write key,
    // held for one without that has been copied to — or all of that on the one brain --brain names — then drained here.
    // A forget is not undone, and nothing here can tell a forgotten id from a wrong one (a brain answers whether a name
    // is forgotten only by forgetting it): so --from, the brain it was forgotten on, is required and is sent nothing
    // unless its queue carries a copy, and without --yes the command only says what it would do (review pass 2: a wrong
    // id pasted forgot a kept thought on every brain, exit 0).
    const usage = "--copy-forget <the thought's id, as the brain you forgot it on answered it> --from <that brain> [--client-key <the thought's own client_key>] [--brain <name>] [--yes]";
    const id = flag(args, "--copy-forget").toLowerCase();
    if (!UUID_ONLY_RE.test(id)) { console.error(`session-capture: ${usage}${id ? " — the id given is not a uuid" : ""}`); return 2; }
    const altRaw = flag(args, "--client-key");
    const alt = altRaw?.toLowerCase();
    if (alt !== undefined && !UUID_ONLY_RE.test(alt)) { console.error(`session-capture: --client-key takes the thought's own client_key (a uuid), as the forget's reply named it${alt ? `, not "${altRaw}"` : "; none was given"}`); return 2; }
    const brainName = flag(args, "--brain");
    if (brainName === "") { console.error("session-capture: --brain <name> (a brain the config names)"); return 2; }
    const fromName = flag(args, "--from");
    if (!fromName) { console.error(`session-capture: --from <the brain you forgot it on> is required: that brain is sent no forget unless its queue still carries a copy of the thought — ${usage}`); return 2; }
    if (brainName !== undefined && brainName === fromName) { console.error(`session-capture: --brain names the brain the thought was forgotten on (--from); name the brain to copy the forget to`); return 2; }
    let brains, targets, source;
    // A brain the forget can reach: one with a write key, or one without that has been copied to, where it is held.
    const reachable = (b) => Boolean(b.cfg.writeKey) || existsSync(join(b.root, "writes"));
    try {
      brains = loadBrains();
      const named = (n) => { const b = brains.find((x) => x.name === n); if (!b) throw new Error(`no brain named "${n}" in ${CONFIG_PATH} (its brains: ${brains.map((x) => x.name).join(", ")})`); return b; };
      source = named(fromName);
      if (brainName !== undefined) {
        const b = named(brainName);
        if (!reachable(b)) throw new Error(`brain "${brainName}" has no write_key and has never been copied to, so nothing goes to it — forget the thought there through its own connector`);
        targets = [b];
      } else {
        targets = brains;
        if (!brains.some((b) => b !== source && reachable(b))) throw new Error(`no brain in ${CONFIG_PATH} other than ${fromName} (--from) has a write_key or has been copied to, so there is nowhere to copy the forget — is --from the brain you forgot it on? Else forget the thought on each brain through its own connector`);
      }
    } catch (e) { console.error(`session-capture: ${e.message}`); return 2; }
    const op = { tool: "forget_thought", args: { id, confirm: id, detach_citations: true }, ...(alt && alt !== id ? { alt } : {}), from: "--copy-forget", session: null, at: new Date().toISOString() };
    // Without --yes: what it would do, and nothing done.
    if (!has(args, "--yes")) {
      console.log(`would forget, for good, the thought named ${id}${op.alt ? `, then by its client_key ${op.alt}` : ""}:`);
      // A forget of the name already in a brain's queue (the hook's, kept while the brain was away) (review pass 3).
      const queuedHere = (b) => { useStateRoot(b.root); return pendingWrites().some((f) => { try { const o = JSON.parse(readFileSync(join(WRITES_PENDING(), f), "utf8")); return o?.tool === "forget_thought" && o.args?.id === id; } catch { return false; } }); };
      const drop = "its queued copies of it dropped";
      for (const b of brainName === undefined ? brains : targets) {
        const already = queuedHere(b) ? "; a forget of it is already queued here, which lands at the next drain" : "";
        if (b === source) { console.log(`  [${b.name}] where it was forgotten: ${drop}; ${b.cfg.writeKey ? "sent the forget" : "held the forget (no write_key now)"} only if a copy that may have landed is still queued there${already}`); continue; }
        console.log(`  [${b.name}] ${b.cfg.writeKey ? `${drop}, then the forget sent` : reachable(b) ? `${drop}, then the forget held: this brain has no write_key now` : "nothing: it has no write_key and has never been copied to"}${already}`);
      }
      if (brainName === undefined) console.log("  and the queues of brains no longer in the config, on this machine: their queued copies of it dropped");
      // What this machine's logs record of the name: a forget the hook made or lost, or nothing — the one check there is
      // against a wrong id, since a brain answers whether a name is forgotten only by forgetting it (review pass 3).
      const seen = [];
      for (const root of new Set([STATE_BASE, ...brains.map((b) => b.root)])) {
        let text = "";
        try { text = readFileSync(join(root, "log"), "utf8"); } catch { continue; }
        const line = text.split("\n").filter((l) => l.includes(`forget_thought of ${id}`)).at(-1);
        if (line) seen.push(`  ${line.slice(0, 220)}`);
      }
      console.log(seen.length ? `This machine's logs record a forget of ${id}, the latest of each:\n${seen.join("\n")}` : `No line in this machine's logs records a forget of ${id}: the hook never saw one — check the id before you go on.`);
      console.log(`A forget is not undone. Check that ${id} is the id ${fromName} answered in its own reply ("Forgot ${id}…")${op.alt ? `, and ${op.alt} the client_key that reply named` : ""}, then run this again with --yes.`);
      return 0;
    }
    // --brain names one brain: no other loses its copies or is held the forget (review pass 1).
    const { queued, held, failed } = queueForget(op, brains, { source, targets, all: brainName === undefined, sourceAlways: false });
    let code = failed.length ? 1 : 0;
    for (const b of failed) console.log(`[${b.name}] ${opLabel(op)} was not queued there: its queue could not be written (the log at ${join(b.root, "log")} says why)`);
    for (const h of held) { console.log(`[${h.brain.name}] held ${opLabel(op)}: this brain has no write_key now; once one is set, it lands, in order, at its next drain`); code = 1; }
    if (!queued.length && !held.length && !failed.length) { console.log(`nothing was queued or held: ${fromName}'s queue carries no copy of the thought, and no other brain was reached`); return 1; }
    for (const q of queued) {
      useStateRoot(q.brain.root);
      const outcomes = await drainWrites(q.brain.cfg);
      for (const o of outcomes) console.log(`[${q.brain.name}] ${o.line}`);
      if (outcomes.some((o) => !o.done)) code = 1;
      const mine = outcomes.find((o) => o.name === q.name);
      // A name that found nothing there: a wrong id, a thought that brain knows by its own id alone, or one forgotten
      // there already, whose copy keeps no key (review pass 1: exit 0 read as success while the text stayed). Not said
      // when a forget of the same name landed in this drain, ahead of it — the hook's, held for the brain (review pass 2).
      const landedBefore = outcomes.some((o) => o !== mine && o.done && !o.notFound && o.forgetOf === id);
      if (mine?.notFound && !landedBefore) {
        // The step that leaves no text first; "forgotten already" last, where a reader stopping early does no harm (review pass 3).
        console.log(`[${q.brain.name}] nothing was forgotten on ${q.brain.name}: no thought there has ${op.alt ? `${id} or ${op.alt}` : id} as its id or client_key.${op.alt ? "" : ` If the forget's reply named a client_key ("its client_key <uuid>"), run this again with --client-key <that uuid>: a thought that began on ${q.brain.name} is known there by it alone.`} Or, by its own id there: --copy-forget <its id on ${q.brain.name}> --from ${fromName} --brain ${q.brain.name}. Check the id. Only if it was forgotten there already (a forgotten copy keeps no key, so a repeat finds nothing) is nothing left to do`);
        code = 1;
      }
      // Still queued: left to a drain already running, or kept, or behind a copy kept.
      if (pendingWrites().includes(q.name)) {
        console.log(outcomes.length
          ? `[${q.brain.name}] ${opLabel(op)} stays queued: it lands, in order, at this brain's next drain (--drain-writes --brain ${q.brain.name})`
          : `[${q.brain.name}] ${opLabel(op)} is queued behind a drain already running, which sends it in order: its outcome is in ${LOG_PATH()}`);
        code = 1;
      }
    }
    return code;
  }
  if (has(args, "--drain-writes")) {
    // A brain's queue of copied writes, by hand or as the hook's child (SMD-3314).
    const brainName = flag(args, "--brain");
    if (!brainName) { console.error("--drain-writes --brain <name> (a brain the config gives a write_key)"); return 2; }
    let b;
    try {
      const brains = loadBrains();
      b = brains.find((x) => x.name === brainName);
      if (!b) throw new Error(`no brain named "${brainName}" in ${CONFIG_PATH} (its brains: ${brains.map((x) => x.name).join(", ")})`);
      if (!b.cfg.writeKey) throw new Error(`brain "${brainName}" has no write_key, so nothing is copied to it`);
    } catch (e) { console.error(`session-capture: ${e.message}`); return 2; }
    useStateRoot(b.root);
    const outcomes = await drainWrites(b.cfg);
    if (process.stdout.isTTY) for (const o of outcomes) console.log(o.line);
    return outcomes.some((o) => !o.done) ? 1 : 0;
  }
  if (has(args, "--dry-run")) {
    const path = flag(args, "--dry-run");
    if (!path) { console.error("--dry-run <transcript.jsonl>"); return 2; }
    // `--event PreCompact [--trigger auto|manual]` or `--event Stop` previews the
    // checkpoint line the hook would write for that event (first review pass:
    // --print-hook refused an unknown event while --dry-run took one in silence,
    // and nothing by hand could show the line). The flags are read BEFORE the
    // transcript: a transcript with no prompt returned 0 past every refusal
    // (third review pass).
    const { event: ev, error } = eventFlag(args);
    if (error) { console.error(error); return 2; }
    const { trigger, error: triggerError } = triggerFlag(args, ev);
    if (triggerError) { console.error(triggerError); return 2; }
    if (has(args, "--min-interval")) { console.error("--min-interval is --print-hook's, for a Stop hook; a dry run has no interval"); return 2; }
    if (modeError) { console.error(modeError); return 2; }
    console.log(`--- session-capture ${HOOK_VERSION}: what it would send; nothing is sent\n`); // which hook's rules the texts below follow (SMD-4378)
    // With the model summary on, say so and that a dry run does NOT call it: the
    // texts below are the DERIVED summaries — what the model is given, and what
    // is sent if the call is refused, slow or unconfigured (SMD-2014). Tolerant
    // of a missing brain config: a dry run is offline.
    try { const c = loadConfig(); if (c.summary === "model") console.log(`--- ${modelStatusLine(c)}; a dry run shows the DERIVED text below (the model is not called here)\n`); } catch { /* no config: nothing to say about the model */ }
    const s = summariseTranscript(path, harness);
    if (!s.episodes.length) {
      const sniffed = sniffHarness(readFileSync(path, "utf8").split("\n", 5));
      console.log(`--- would SKIP: no human prompt in ${path} (a compaction, or a transcript with only tool traffic${harness && harness !== sniffed ? `; note: --harness ${harness} was given but the first line says ${sniffed}` : ""})`);
      return 0;
    }
    const several = s.episodes.length > 1;
    if (ev) s.episodes[s.episodes.length - 1].checkpoint = checkpointOf({ hook_event_name: ev, trigger });
    // The segmentation first (SMD-2013): where the boundaries fell and why, one
    // line per episode, so an operator sees the pieces before the texts.
    if (several) {
      console.log(`--- ${s.episodes.length} episodes — one thought each, on its own supersedes chain:`);
      for (const ep of s.episodes) {
        const tickets = ep.named.size ? [...ep.named].join(", ") : anchorOf(ep.cwd, ep.branch)[0] ?? "no ticket";
        console.log(`    ${ep.n}. ${[tickets, ep.branch ? `(${ep.branch})` : "", `${distinctPrompts(ep.prompts).length} prompt(s)`, ep.first ? `${when(ep.first)} → ${when(ep.last)}` : "undated", ep.opened ? `begun ${boundaryBegan(ep.opened)}` : "from the start", ep.closed ? `ended ${boundaryEnded(ep.closed)}` : "still open"].filter(Boolean).join(" — ")}`);
      }
    }
    let code = 0;
    for (const ep of s.episodes) {
      const cleaned = cleanEpisode(ep, onSecret);
      const { text, redactions } = cleaned;
      const where = gateFindings(cleaned, text);
      const ids = provenanceOf(ep);
      if (several) console.log(`\n=== episode ${ep.n} ===`);
      console.log(text);
      const from = headerTickets(cleaned.ep).from;
      console.log(`\n--- would send${several ? ` (episode ${ep.n})` : ""}: source=${s.harness}, derived_from=${ids.length} id(s)${ids.length ? ` [${ids.slice(0, 5).join(", ")}${ids.length > 5 ? ", …" : ""}]` : ""}${from ? `, metadata.tickets_from=${from}` : ""}, metadata.hook_version=${HOOK_VERSION}`);
      if (where.length) { console.log(`--- would REFUSE${several ? ` episode ${ep.n}` : ""}: ${where.join(", ")}${redactions.length ? ` after ${countRedactions(redactions.length)}` : ""}`); code = 1; }
      else if (redactions.length) console.log(`--- secret scan: ${countRedactions(redactions.length)} — ${describeRedactions(redactions)}; the text above is what would be sent`);
      else console.log("--- secret scan: clean");
    }
    return code;
  }
  if (has(args, "--post")) {
    const files = flagAll(args, "--post").filter(Boolean); // none: drain pending/ alone
    // `--brain <name>`: the brain whose queue this drains, as the hook's child
    // is told (SMD-3313); none, the first.
    const brainName = flag(args, "--brain");
    if (brainName === "") { console.error("--brain <name> (a brain the config names)"); return 2; }
    let cfg;
    try {
      const brains = loadBrains();
      const b = brainName === undefined ? brains[0] : brains.find((x) => x.name === brainName);
      if (!b) throw new Error(`no brain named "${brainName}" in ${CONFIG_PATH} (its brains: ${brains.map((x) => x.name).join(", ")})`);
      useStateRoot(b.root);
      cfg = b.cfg;
    } catch (e) { log(`error: ${e.message}`); console.error(`session-capture: ${e.message}`); return 2; }
    const outcomes = await postPending(cfg, files.length ? files : undefined);
    // Each outcome is already a timestamped line in the log, where this
    // process's stdout also lands when the hook spawned it; say it again only
    // to a terminal (first review pass: every line twice in the log).
    if (process.stdout.isTTY) for (const o of outcomes) console.log(o.ok ? `captured ${o.id}${o.note ? ` (${o.note})` : ""}` : o.deferred ? o.error : `not captured: ${o.error}${o.dead ? " (given up)" : " (kept for retry)"}`);
    return outcomes.some((o) => !o.ok && !o.obsolete && !o.deferred) ? 1 : 0;
  }

  // The hook itself: JSON on stdin. A terminal is not a hook — say so instead
  // of waiting on it for ever (ninth review pass).
  if (process.stdin.isTTY) { console.error("session-capture: expected the hook's JSON on stdin (a harness pipes it). By hand: --version, --print-hook [claude-code|codex], --check, --dry-run <transcript>, --post <payload> [--post <payload>…], --copy-forget <id>."); return 2; }
  let hook;
  try { hook = JSON.parse(await readStdin()); } catch (e) { console.error(`session-capture: stdin is not the hook's JSON (${e.message})`); return 1; }
  // A hook takes two flags. Any other — `--event` or `--trigger`, which are
  // the by-hand forms' and whose values the harness sends on stdin, or a
  // misspelt `--min-intervall` that would capture every turn — would change
  // nothing and say nothing (fourth and fifth review passes). Exit 1, never 2:
  // a Stop hook's 2 blocks the turn.
  const HOOK_FLAGS = ["--harness", "--min-interval", "--claims"];
  for (const a of args) {
    if (!a.startsWith("--") || HOOK_FLAGS.includes(a.split("=")[0])) continue;
    const name = a.split("=")[0];
    log(`error: ${name} is not a hook flag`);
    console.error(`session-capture: ${name} is not a hook flag — a hook takes ${HOOK_FLAGS.join(" and ")}; the event and the trigger come from the harness on stdin — remove it from the command; nothing captured`);
    return 1;
  }
  const { minInterval: hookInterval, error: intervalError, raw: intervalRaw } = intervalFlag(args, { aboveZero: false });
  if (intervalError) { log(`error: --min-interval "${intervalRaw}" is not a number of minutes`); console.error(`session-capture: ${intervalError}; nothing captured`); return 1; }
  const event = String(hook.hook_event_name ?? "");
  // The claims hook renews and captures nothing, so the capture's secret mode
  // is not its to judge: a typo there must not stop renewals (review pass 2).
  const claimsOnly = has(args, "--claims") && !eventSpec(event);
  // Exit 1, as the flags above: a typo in the environment blocks nothing and captures nothing (SMD-2127).
  if (modeError && !claimsOnly) { log(`error: ${modeError}`); console.error(`session-capture: ${modeError}; nothing captured`); return 1; }
  const minIntervalMin = hookInterval ?? 0;
  // The config is checked FIRST, before a payload exists: a hook pasted before
  // the config is written would otherwise queue one payload per session end
  // for as long as the config is missing, and post them all, stale, when it
  // appears (fifth review pass).
  let brains;
  try { brains = loadBrains(); } catch (e) {
    log(`error: ${e.message}`); console.error(`session-capture: ${e.message}`);
    // A forget this run would have copied is lost with it: named, with the command that copies it once the config
    // loads (SMD-4411 review pass 1: the log said the errno alone).
    const lost = lostForget(hook);
    if (lost) { log(`fan-out: ${lost}`); console.error(`session-capture: ${lost}`); }
    return 1;
  }
  const sync = process.env.OB1_SESSION_CAPTURE_SYNC === "1";
  // The claims hook (SMD-3602): renew what is due, nothing captured or copied.
  // Exit 0 once the config loads: a renewal's fate is the log's. On an event
  // the hook captures on, a command given --claims by hand still captures, the
  // renewal after it (review pass 1: it silently captured nothing).
  if (claimsOnly) {
    try { noteAgentClaimCall(hook, brains); } catch (e) { useStateRoot(brains[0].root); log(`claims: error: ${scrubTokens(oneLine(String(e?.message ?? e))).slice(0, 200)}`); }
    try { await renewClaims(hook.cwd, brains, { detach: !sync }); } catch (e) { useStateRoot(brains[0].root); log(`claims: error: ${scrubTokens(oneLine(String(e?.message ?? e))).slice(0, 200)}`); }
    return 0;
  }
  // A write tool's result (SMD-3314): copied to the other brains, nothing captured.
  if (event === "PostToolUse") return fanOutHook(hook, brains);
  // Each brain prepares from its own state and posts in a child of its own
  // (SMD-3313): its chains supersede its own ids, its queue waits for it alone,
  // and one away delays no other. One brain says what it always said; several
  // name theirs on every line. The exit is the worst brain's.
  const several = brains.length > 1;
  let code = 0;
  for (const b of brains) {
    useStateRoot(b.root);
    code = Math.max(code, await hookForBrain(hook, b, several, { minIntervalMin, harness, onSecret }));
  }
  // Copies a drain left behind (their brain away) get another drain at every session event.
  await kickWriteDrains(brains, { atEnd: event === "SessionEnd" });
  // The session's claims (SMD-3602): renewed at a compaction and at its end —
  // never released there, as its PR may still be open — and, on a Stop hook's
  // turn, when due. Not on an event this hook does not capture on.
  if (!event || eventSpec(event)) {
    try { await renewClaims(hook.cwd, brains, { force: !eventSpec(event)?.interval, detach: !sync }); } catch (e) { useStateRoot(brains[0].root); log(`claims: error: ${scrubTokens(oneLine(String(e?.message ?? e))).slice(0, 200)}`); }
  }
  return code;
}

/** The hook's run for one brain, its state root set: prepare, then post in sync or in a detached child. Returns the exit code. */
async function hookForBrain(hook, brain, several, { minIntervalMin, harness, onSecret }) {
  const tag = several ? `[${brain.name}] ` : "";
  const cfg = brain.cfg;
  let prepared;
  try { prepared = prepare(hook, { minIntervalMin, harness, onSecret, summary: cfg.summary }); } catch (e) { log(`error: ${e.message}`); console.error(`session-capture: ${tag}${e.message}`); return 1; }
  // A refused episode exits 1 once the others are on their way (SMD-2013): the
  // secret's episode is not sent, the rest of the session still is.
  const paths = prepared.payloadPaths ?? [];
  if (!paths.length) { log(prepared.message); console.error(`session-capture: ${tag}${prepared.message}`); return prepared.code; }
  if (prepared.code) { log(prepared.message); console.error(`session-capture: ${tag}${prepared.message}`); } // the refusal first, then what posts
  if (process.env.OB1_SESSION_CAPTURE_SYNC === "1") {
    // The run's own outcomes, by file — oldest-first posting puts stranded
    // payloads before them (third review pass: `[o]` read the first outcome).
    const outcomes = await postPending(cfg, paths);
    const own = paths.map((p) => outcomes.find((x) => x.file === p));
    if (own.every((o) => !o)) { console.error(`session-capture: ${tag}another run took ${paths.length === 1 ? "this payload" : "these payloads"} (to post them, or as obsolete beside a newer one)`); return prepared.code; } // two runs at once (fourth review pass)
    for (const o of own) if (o) console.error(`session-capture: ${tag}${o.ok ? `captured ${o.id}` : o.obsolete ? `skip: ${o.error}` : o.deferred ? o.error : `not captured: ${o.error}`}`);
    return prepared.code || (own.every((o) => !o || o.ok || o.obsolete || o.deferred) ? 0 : 1);
  }
  const pid = detachPost(paths, several ? brain.name : undefined);
  log(`${prepared.code ? `posting the rest` : prepared.message} → posting in pid ${pid}`);
  return prepared.code;
}
