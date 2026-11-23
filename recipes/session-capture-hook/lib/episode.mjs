/**
 * lib/episode.mjs — a session's summary and its episodes (SMD-2013; moved here
 * by SMD-4338): the caps on what a summary carries, the empty summary the
 * parsers fill, a prompt's injected blocks removed, the ids a brain tool's
 * reply names, the segmenter that cuts a session into episodes at compactions,
 * moves and new tickets, the tickets an episode names, the summary's text and
 * header, and its redaction and secret gate (SMD-2127).
 */

import { basename, relative, isAbsolute } from "node:path";
import { UUID, clip, oneLine } from "./util.mjs";
import { HOME } from "./state.mjs";
import { redactSecrets, scanForSecrets } from "./secrets.mjs";

/** Caps on what the summary carries. The text is one thought; the server chunks long ones, but a summary is meant to be read whole. */
export const LIMITS = {
  prompts: 12,          // human prompts listed
  promptChars: 200,     // per prompt
  outcomeChars: 1500,   // the assistant's last message
  sessionIdChars: 120,  // the id in the closing line — a uuid is 36; bounded so the closing lines never outgrow the cap (fifth review pass)
  files: 20,            // file paths named
  textChars: 6000,      // the whole summary
  derived: 60,          // provenance ids sent (the server validates each; a long list is a long validation)
  modelMsgs: 30,        // assistant messages kept per episode for an opt-in model summary (SMD-2014): the most recent, decisions land late
  modelInputChars: 12000, // the assistant text handed to the model, tail-clipped
};

// `ID: <uuid>` is how every read tool prints a thought's id (SMD-1248); a capture answers `Captured as … — id <uuid>`.
// Each at a line's start, as the server prints it: a thought's text is fenced (`│ ` before its every
// line, SMD-2483), so an id line its text quotes is not one, and is never claimed as provenance.
const RETRIEVED_ID_RE = new RegExp(`^[ \\t]*ID:\\s*(${UUID})\\b`, "gim");
const CAPTURED_ID_RE = new RegExp(`^Captured as [^\\n]*?\\bid (${UUID})\\b`, "gim");

// ── Small helpers ────────────────────────────────────────────────────────────

/**
 * Harness-injected blocks a prompt may carry that are not what the human typed:
 * Claude Code's system reminders, slash-command wrappers and pasted-content
 * frames; Codex's environment context and instruction frames. Removed before a
 * prompt is judged non-empty, so a turn that was only a reminder is not "asked".
 */
const INJECTED_TAGS = ["system-reminder", "system_reminder", "command-name", "command-message", "command-args", "local-command-stdout", "local-command-caveat",
  "pasted_content", "environment_context", "user_instructions", "permissions", "turn_aborted", "ide_selection", "task-notification", "agent-message", "AGENTS\\.md"];
const INJECTED_RE = new RegExp(`<(${INJECTED_TAGS.join("|")})(?:\\s[^>]*)?>[\\s\\S]*?<\\/\\1>|<(${INJECTED_TAGS.join("|")})(?:\\s[^>]*)?\\/?>`, "gi");
export function stripInjected(text) {
  return String(text ?? "").replace(INJECTED_RE, " ").replace(/[ \t]+\n/g, "\n").trim();
}

/** An empty summary — the session's (n = 0) or one episode's (n ≥ 1) — filled by the segmenter from either parser's events. */
function emptySummary(n = 0) {
  // `cwd` and `branch` are where the session ENDED; `roots` every directory it
  // ran in (a session that moves between worktrees has several), so a file under
  // any of them is inside the project.
  // `checkpoint` is set by prepare() from the hook event (checkpointOf); a
  // transcript read for --dry-run or a test has none, and renders no such line.
  // `n` is the episode's ordinal (0: the whole session), `named` the tickets
  // its asks name in first-mention order, `about` the tickets it is the work
  // of (its opening ask's, its first ask's, its home's), `opened` and `closed`
  // the boundaries at its ends, and `episodes` — the session's alone — its
  // pieces (SMD-2013).
  // `assistant` holds the episode's assistant messages, the most recent kept
  // (LIMITS.modelMsgs), for the opt-in model summary alone (SMD-2014); it never
  // reaches a derived payload, so a session with the option off is byte-identical.
  return { harness: "", sessionId: "", title: "", cwd: "", branch: "", roots: new Set(), prompts: [], outcome: "", assistant: [], files: new Set(), commits: 0, prs: [], retrieved: new Set(), captured: new Set(), first: "", last: "", pushed: false, checkpoint: undefined, n, named: new Set(), about: new Set(), opened: undefined, closed: undefined, episodes: [] };
}

function harvestIds(text, s) {
  for (const m of text.matchAll(CAPTURED_ID_RE)) s.captured.add(m[1].toLowerCase());
  for (const m of text.matchAll(RETRIEVED_ID_RE)) { const id = m[1].toLowerCase(); if (!s.captured.has(id)) s.retrieved.add(id); }
}

// ── Episodes ─────────────────────────────────────────────────────────────────

/**
 * A ticket key as a branch name or an ask spells it — `SMD-2013`, `smd-2013`:
 * two to five letters, a dash, two to six digits. Not the shapes that look
 * like one and are not (a digest's name, an encoding, a standard, a PR
 * number, a cipher). In an ASK, once the session's branches or directories
 * have named a team (`teams`), only that team's keys count, in any case —
 * `node-22`, `port-8010` and `AES-256` are spelled the same way, and split a
 * session on `main` (first and second review passes); before any team is
 * known, an upper-case key counts, since it is the only way a session with no
 * keyed branch names its work.
 */
const TICKET_RE = /\b([A-Za-z]{2,5})-(\d{2,6})\b/g;
// The brain's own denied prefixes (server-portable/subject.ts's NOT_TICKET_PREFIXES) are here too, those this shape can
// match: a branch's first word the brain denies would else be its ticket here and none there (SMD-4291's review pass 2:
// `es-2015-target-smd-610` named ES-2015, and the asked smd-610 lost its team).
export const NOT_TICKETS = new Set(["SHA", "UTF", "ISO", "RFC", "CVE", "IPV", "TLS", "SSL", "HTTP", "PR", "MD", "AES", "RSA", "GPT", "ED", "HTML",
  "IEEE", "CWE", "WCAG", "GPL", "LGPL", "AGPL", "FSL", "BSD", "MPL", "CC", "ES", "COVID", "FY"]);
/** The ticket keys a text names, upper-cased, in first-mention order; with `teams`, under the rule for an ask. */
export function ticketsIn(text, teams) {
  const out = [];
  for (const m of String(text ?? "").matchAll(TICKET_RE)) {
    const team = m[1].toUpperCase(), id = `${team}-${m[2]}`; // `team`, not `key`: Daemonic Brain's credential-compare check reads a `key` under an equality operator as a secret compared, comments included
    if (NOT_TICKETS.has(team) || out.includes(id)) continue;
    if (teams && (teams.size ? !teams.has(team) : m[1] !== team)) continue;
    out.push(id);
  }
  return out;
}
/**
 * The tickets an ask names, read with its secrets blanked (SMD-4292): a ticket-shaped value a secret holds
 * (`password=ABC-1234`) is no ticket. Read off the raw ask, it headed the summary while the ask that held it was
 * blanked, the brain keyed it as a subject, it began an episode ("begun with ABC-1234") and it decided where the
 * session split. Both readers of an ask's tickets, `named` and the segmenter's boundaries, go through here.
 * In both modes: under `refuse`, read raw, the secret split off an episode of its own, and the clean episode before it
 * was sent saying "ended when ABC-1234 was taken up" (review pass 1: limiting this rule to `redact` kept sending that
 * line). Read blanked, it splits nothing, and its episode is refused whole, as one holding `password=hunter2` always
 * was. A real ticket the scan takes for a secret (`Password: SMD-12 (reset flow)`) is dropped too: its ask is blanked
 * in the text as well.
 * The ask is blanked on one line, as `redactEpisode` blanks each prompt: blanked as written, a quoted secret whose
 * closing quote is on the next line (`password = "hunter22⏎QQZ-9876"`) was cut at its first space, and its
 * ticket-shaped part headed the summary while the prompt showed it blanked (review pass 1, secrets adversary).
 * Only tickets the raw ask names, read with the same teams, are kept: blanking can join a word to its marker into a
 * ticket shape (`XY-12` before a Slack webhook's URL; review pass 1, cold read), and a lower-case mention of that key
 * before any team is known is no ticket (review pass 3, mutant).
 * The cost: the scan runs once per ask, cached per event (the segmenter and the episode both read it), and only for an
 * ask whose raw text names a ticket: about 20 ms per MB of such asks, nothing for an ask naming none.
 */
const blankedAsks = new WeakMap();
const askTickets = (ev, teams) => {
  const raw = ticketsIn(ev.text, teams);
  if (!raw.length) return [];
  let text = blankedAsks.get(ev);
  if (text === undefined) { text = redactSecrets(oneLine(ev.text)).text; blankedAsks.set(ev, text); }
  return ticketsIn(text, teams).filter((id) => raw.includes(id));
};
/**
 * A place's own tickets (SMD-4291): the first ticket-shaped word of `text` is the place's ticket, and the other keys of
 * its team are tickets beside it (`smd-610-and-smd-611`); a word of another team is the place's description, no ticket
 * and no team (`node-22` of `smd-610-bump-node-22`). Before, every ticket-shaped word of a branch or a directory was a
 * ticket of the place and taught its team, so on `smd-610-bump-node-22` an ask's `node-22` headed the summary.
 */
const ownTickets = (text) => {
  const [first] = ticketsIn(text);
  return first ? ticketsIn(text, new Set([first.split("-")[0]])) : [];
};
/** A branch's own tickets: read whole, its first ticket-shaped word the place's (`feature/smd-55-x`). */
const branchTickets = (branch) => ownTickets(branch);
/**
 * A directory's own tickets: those of its deepest part that names one, a worktree's or a project's own name before a
 * parent's (`~/aoc-2024/smd-55-day1/src` is SMD-55's, not AOC-2024's; `~/aoc-2024/day1` is AOC-2024's). Split at either
 * slash, so a Windows path is read by its parts too (review pass 1, run-it: read whole, its parent's word won).
 */
const dirTickets = (cwd) => {
  const parts = String(cwd ?? "").split(/[\\/]/);
  for (let k = parts.length - 1; k >= 0; k--) { const own = ownTickets(parts[k]); if (own.length) return own; }
  return [];
};
/** The tickets of a place's change, a `cwd` or a `branch` event, as the event's kind reads them. */
const placeTickets = (t, v) => (t === "branch" ? branchTickets(v) : dirTickets(v));
/** The tickets a place — a branch and a directory — names: each one's own, the branch's first. */
const anchorOf = (cwd, branch) => [...new Set([...branchTickets(branch), ...dirTickets(cwd)])];
/** The tickets an episode is known by: those its asks named, and those its branch and its directory name. */
const knownTickets = (ep) => new Set([...ep.named, ...anchorOf(ep.cwd, ep.branch)]);
/** Anchored: the episode's branch or directory names a ticket — its work has a home, and a ticket an ask merely mentions does not end it. */
const anchored = (ep) => anchorOf(ep.cwd, ep.branch).length > 0;
/** Whether, before the next ask, the session moves to a branch or directory naming one of these tickets: then the ask that named them began that work, whatever branch it was typed on. */
const movesTo = (events, i, ids) => {
  for (let k = i + 1; k < events.length && events[k].t !== "prompt"; k++) {
    if ((events[k].t === "cwd" || events[k].t === "branch") && placeTickets(events[k].t, events[k].v).some((id) => ids.includes(id))) return true;
  }
  return false;
};

/** One parser event onto a summary — the session's, or an episode's. */
function apply(x, ev, teams) {
  switch (ev.t) {
    case "time": if (!x.first) x.first = ev.at; x.last = ev.at; break;
    case "cwd": x.cwd = ev.v; x.roots.add(ev.v); break;
    case "branch": x.branch = ev.v; break;
    case "prompt": x.prompts.push(ev.text); for (const id of askTickets(ev, teams)) x.named.add(id); break;
    case "outcome": x.outcome = ev.text; x.assistant.push(ev.text); if (x.assistant.length > LIMITS.modelMsgs) x.assistant.shift(); break; // `outcome` is the last, for the derived text; `assistant` keeps the recent window for the model (SMD-2014)
    case "file": x.files.add(ev.path); break;
    case "commit": x.commits++; break;
    case "push": x.pushed = true; break;
    case "pr": if (!x.prs.includes(ev.url)) x.prs.push(ev.url); break;
    case "ids": harvestIds(ev.text, x); break;
    case "title": x.title = ev.text; break;
    default: break; // a compaction is a boundary, nothing of the summary's
  }
}

/**
 * The segmenter (SMD-2013): the parser's events, in transcript order, folded
 * into the session's summary `s` and into `s.episodes`, one per piece of work.
 * The session's PLACE — its branch and directory, `loc` — is followed on every
 * line; an episode's place (`cwd`, `branch`, `roots`) is where it runs, and a
 * move away from it is applied to the episode the next ask opens, never to
 * the one it ends (first review pass: the ended episode was labelled — its
 * branch, its project, and when its asks named no ticket its TICKET — with
 * the place the session moved to). An episode ENDS, and the next begins at
 * the next ask:
 *   - at a compaction — the harness's summary line;
 *   - when the session is on another branch at that ask, or, with no branch to
 *     go by, in a directory inside none of the episode's roots — a cd within
 *     the checkout is no move, nor is one out of it with the branch unchanged
 *     (the harness records the shell's directory per command), nor a move the
 *     session came back from before the ask, nor a detached HEAD mid-rebase;
 *   - at an ask that names a ticket none of the episode's asks, its branch or
 *     its directory named — unless the episode's branch or directory names a
 *     ticket (the work has a home; a mention does not end it), in which case
 *     only if the session then moves to a branch or directory naming the new
 *     ticket before the next ask: the ask began that work.
 * A move to a place that names a ticket the episode is ABOUT — its opening
 * ask's, its first ask's, its home's — is the episode's own, since the branch
 * is made a few lines after the ask that names its ticket; and when the
 * episode is about nothing yet, such a move names the work instead of ending
 * it. A ticket an ask merely mentioned makes no later move its own (first
 * review pass: a plan mentioned the next ticket, and the move to its branch
 * never ended the episode). Work between a boundary and the next ask — the
 * assistant finishing after a compaction, or after the move — belongs to the
 * ask that caused it. A compaction and a move between two asks are both
 * recorded. So a boundary is fixed once written: appending to the transcript
 * never moves an earlier one, and an episode's ordinal, text and fingerprint
 * stand — an episode captured and unchanged is skipped, and only the one that
 * changed supersedes its own earlier summary. The one boundary decided by
 * what FOLLOWS is the ask that names a new ticket under an anchored episode:
 * until the move to that ticket's branch is written — or the next ask, which
 * settles it the other way — the ask is the earlier episode's, and a
 * checkpoint taken in that window is superseded by that episode's own next
 * summary, on its own chain. Episodes without an ask are not episodes.
 */
const STAMPED = new Set(["prompt", "outcome", "file", "commit", "push", "pr", "ids"]); // the events that carry a line's time onto an episode: its span is that of its content, so an episode closed at an ask does not reach to that ask's line
export function segment(events, s = emptySummary()) {
  // The team prefixes the session's branches and directories (not a folder
  // of a checkout: `placeOf`) have named SO FAR: what a lower-case key in
  // an ask may be a ticket of. Gathered as the
  // walk goes, never ahead of it — a branch made later would make an earlier
  // mention a key and move a boundary already captured (second review pass).
  const teams = new Set();
  const learnTeams = (t, v) => { for (const id of placeTickets(t, v)) teams.add(id.split("-")[0]); }; // the team of a branch's or a directory's own ticket, not of every word (SMD-4291)
  const episodes = [];
  let cur, lineAt = "", compacted = false; // the open episode; the current line's time; a compaction since the episode's last ask
  const loc = { cwd: "", branch: "" }; // where the session IS, against where the episode runs
  const branchMoved = () => Boolean(loc.branch && cur.branch && loc.branch !== cur.branch);
  const below = (dir, root) => dir === root || dir.startsWith(`${root}/`) || dir.startsWith(`${root}\\`); // either slash: a Windows path too (SMD-4291's review pass 2)
  const inside = () => !loc.cwd || !cur.cwd || [...cur.roots].some((r) => below(loc.cwd, r)); // at or under a root: an ancestor of the checkout — HOME, ~/Projects — is not inside it (second review pass: it became the episode's directory, and every checkout under it was then inside)
  /** Away: the session is not where the episode runs — another branch, or with no branch to go by, a directory inside none of its roots. */
  const away = () => branchMoved() || (!(loc.branch && cur.branch) && !inside());
  /** The episode's top root a directory lies below: a root no other root contains. */
  const topOf = (dir) => { const roots = [...cur.roots]; return roots.find((r) => dir !== r && below(dir, r) && !roots.some((o) => o !== r && below(r, o))) ?? ""; };
  /**
   * What a directory below the episode's roots is, read from its parts below the top root. A part begins a checkout of
   * its own when it sits directly in a worktrees folder (a name ending `worktree` or `worktrees`, or `wt`, `.wt`, in any
   * case: `.claude/worktrees/smd-…`, `.worktrees`, `repo-worktrees`, a worktree named for no ticket among them), or when
   * it names a ticket and that ticket is the one `branch` names (`~/Projects/smd-55-day1` on `smd-55-day1`), or it is
   * the first part naming a ticket below HOME with `branch` naming none, or directly in a top root naming none by its
   * directory or `branch` (`~/Projects/smd-55-day1`). Any other part naming a ticket is a ticket-shaped folder of the
   * checkout it is in (`packages/node-22-compat`, `docs/smd-500-notes`). `kind` is "checkout" when the directory's deepest
   * part naming a ticket begins one, "folder" when it is a folder, "" when no part below the top root names one (`api`)
   * or it is in no root; `home` is the deepest checkout of its own at or above it, "" for the top root's (read when asked,
   * as the roots change: `placeAt`). A cd within the roots into a folder teaches its home's team, not the folder's; an
   * episode opened in a folder runs in its home. The cost: a ticket-shaped folder directly in a checkout naming no ticket
   * (`app/node-22-compat` on `main`) reads as a checkout of its own (SMD-4291's review passes 3 to 5).
   */
  const placeOf = (dir, branch) => {
    const top = topOf(dir);
    if (!top) return { kind: "", home: "" };
    const rel = dir.slice(top.length + 1).split(/[\\/]/), named = rel.map((part) => ownTickets(part).length > 0);
    const bt = branchTickets(branch), first = named.indexOf(true), k = named.lastIndexOf(true);
    const begins = (j) => (j > 0 && /worktrees?$|^\.?wt$/i.test(rel[j - 1]))
      || (named[j] && (bt.includes(ownTickets(rel[j])[0]) || (j === first && ((top === HOME && !bt.length) || (j === 0 && !anchorOf(top, branch).length)))));
    let end = -1;
    for (let j = 0; j <= k; j++) if (begins(j)) end = j;
    return { kind: k < 0 ? "" : k === end ? "checkout" : "folder", home: end < 0 ? "" : dir.slice(0, top.length + 1 + rel.slice(0, end + 1).join("/").length) };
  };
  // A directory's place is decided when the session first enters it below the roots, with the branch it has then, and
  // both readers (the team a cd teaches, the place an episode opens in) read that one answer: read again at a branch
  // move, `node-22-compat` was a folder to the episode it closed and a checkout to the next line (review pass 4, run-it).
  // A folder of the top root's checkout takes the current episode's top root as its home, never the one it was entered
  // under: a compaction there ran in `~/Projects` after the session had moved its episodes to `ob1` (review pass 5).
  const places = new Map();
  const placeAt = (dir, branch) => {
    const place = places.get(dir) ?? placeOf(dir, branch);
    if (place.kind) places.set(dir, place);
    return place.kind && !place.home ? { ...place, home: topOf(dir) || dir } : place;
  };
  /** The episode runs where the session is: its first directory names the project, a subdirectory does not. */
  const settle = () => {
    if (loc.cwd) { cur.roots.add(loc.cwd); if (!cur.cwd || !below(loc.cwd, cur.cwd)) cur.cwd = loc.cwd; }
    if (loc.branch) cur.branch = loc.branch;
  };
  /**
    * Whether a move to a place naming these tickets is the episode's own —
    * about one of them (the keys it opened and was asked with), or heading to
    * where it already runs (its home). An episode about nothing and with no
    * home yet takes the move's keys as its own. Its home is read LIVE, never
    * kept in `about`: once the episode has moved on, a move BACK to the branch
    * it began on is a new piece of work, not its own (second review pass: an
    * ex-home key lingered in `about`, and a return to the old branch was
    * absorbed).
    */
  const own = (names) => {
    const home = anchorOf(cur.cwd, cur.branch);
    if (names.some((id) => cur.about.has(id) || home.includes(id))) return true;
    if (cur.about.size || home.length || !names.length) return false;
    for (const id of names) cur.about.add(id);
    return true;
  };
  const open = (boundary) => {
    const next = emptySummary(episodes.length + 1);
    if (cur) cur.closed = boundary;
    next.opened = boundary;
    // An episode opened with the shell in a ticket-shaped folder (`placeOf`) runs in the checkout the folder is in: a
    // compaction, a new ticket or a branch move in `packages/node-22-compat` named NODE-22 as the new episode's place
    // (SMD-4291's review passes 2 to 4, cold read). Any other takes where the shell is, as before: a
    // folder naming nothing (`api`), a checkout of its own (a nested worktree), a place out of the roots.
    const place = boundary && cur?.cwd && loc.cwd && inside() ? placeAt(loc.cwd, loc.branch) : undefined; // the parser writes no empty branch: loc.branch is set whenever cur.branch is
    next.cwd = place?.kind === "folder" ? place.home : loc.cwd; next.branch = loc.branch;
    if (next.cwd) next.roots.add(next.cwd);
    if (boundary?.ticket) next.about.add(boundary.ticket); // the key it BEGAN with; its home is read live in `own` (second review pass)
    if (lineAt) next.first = next.last = lineAt;
    episodes.push(next); cur = next; compacted = false;
  };
  open(undefined);
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    apply(s, ev); // the session's rollup names every key it mentioned; the episodes' `named` is team-gated
    if (ev.t === "time") { lineAt = ev.at; continue; } // the session's span is every line's; an episode's, its content's (below)
    if (ev.t === "title") { episodes[0].title = ev.text; continue; } // the harness titles the session from its first asks: the first episode's, whenever the line falls
    if (ev.t === "compaction") { if (cur.prompts.length) compacted = true; else cur.opened = { kind: "compaction" }; continue; }
    if (ev.t === "cwd" || ev.t === "branch") {
      if (ev.t === "branch" && ev.v === "HEAD") continue; // detached mid-rebase: the session is where it was
      loc[ev.t] = ev.v;
      // A cd within the episode's roots into a ticket-shaped folder (`placeOf`) teaches its home's team: a folder's
      // name is its checkout's, not a ticket's (review pass 1, run-it: `packages/node-22-compat` taught NODE), but this
      // repo's worktrees sit under its checkout, the branch still `main`, and a projects folder holds checkouts (review
      // pass 2; pass 3 made it the rule an episode's opening reads too).
      // The branch the line moves to when it records both, cwd first: the place is read with it (review pass 4, cold
      // read), and the pair is one move (below).
      const pairBranch = ev.t === "cwd" && events[i + 1]?.t === "branch" && events[i + 1].v !== "HEAD" ? events[i + 1].v : "";
      // A folder teaches its home's team: a nested worktree's `packages/node-22-compat` is that worktree's (review pass 5).
      const entered = ev.t === "branch" || !cur.cwd || !inside() ? undefined : placeAt(loc.cwd, pairBranch || loc.branch);
      if (entered?.kind === "folder") learnTeams("cwd", entered.home); else learnTeams(ev.t, ev.v);
      // A line writes its cwd then its branch, so the two are one move: read
      // the branch before judging the cwd, else a cwd-first return to the repo
      // root — a parent of the worktree it was in — settles onto the episode it
      // ends before its branch arrives (second review pass).
      if (pairBranch) { const nb = events[++i]; apply(s, nb); learnTeams("branch", nb.v); loc.branch = nb.v; }
      if (!cur.prompts.length) { settle(); continue; } // before the first ask, the episode is wherever the session is
      if (!branchMoved()) {
        if (inside()) settle(); // a cd within the checkout
        else if (!cur.branch && own(dirTickets(loc.cwd))) settle(); // no branch to go by: a directory naming the episode's ticket is its own
        // else: the shell out of the checkout on the same branch — the session's place stands; or, with no branch, a move the next ask decides
        continue;
      }
      if (own([...branchTickets(loc.branch), ...(inside() ? [] : dirTickets(loc.cwd))])) settle(); // a move to the episode's own place — judged by what changed: the branch, and the directory once it too has left the roots, in whichever order the line records them; else pending, decided at the next ask
      continue;
    }
    if (ev.t === "prompt") {
      const named = askTickets(ev, teams);
      if (cur.prompts.length) {
        const known = knownTickets(cur), fresh = named.filter((id) => !known.has(id));
        const moved = away();
        const fresh_ = named.length > 0 && fresh.length === named.length;
        const turned = fresh_ && (!anchored(cur) || movesTo(events, i, named));
        if (compacted || moved || turned) {
          const move = moved ? (branchMoved() ? { kind: "branch", to: loc.branch } : { kind: "directory", to: basename(loc.cwd) }) : undefined;
          // The new episode is "with" the ask's key only on the key's own evidence: the
          // key alone ended an episode with a home, or the session then moved to its
          // branch. An ask that names a key beside a compaction or a move may only be
          // mentioning it (second review pass: a review on main was "with SMD-2000",
          // and about it, so the move to SMD-2000's branch never began an episode).
          const began = fresh_ && (anchored(cur) ? movesTo(events, i, named) : !(compacted || moved));
          const b = { kind: compacted ? "compaction" : move ? move.kind : "ticket", ticket: began ? fresh[0] : undefined };
          if (move) { b.to = move.to; if (compacted) b.moved = move; }
          open(b);
        }
      }
      if (!cur.prompts.length && cur.n === 1) for (const id of named) cur.about.add(id); // the session's first ask says what its first episode is about: its keys (its home is read live in `own`); a later episode's opening ask says so only through `began`
      compacted = false;
    }
    if (lineAt && STAMPED.has(ev.t)) { if (!cur.first) cur.first = lineAt; cur.last = lineAt; }
    apply(cur, ev, teams);
  }
  s.episodes = episodes.filter((ep) => ep.prompts.length); // the first, before any ask, is the only one that can be empty
  for (const ep of s.episodes) { ep.harness = s.harness; ep.sessionId = s.sessionId; }
  return s;
}

/** The key an episode's summaries chain under: the session's own id for the first episode — a session of one episode is captured as before — and `<session id>#e<n>` after it. The state file and the payload names carry it sanitised. */
export const episodeChain = (sessionId, n) => (n > 1 ? `${sessionId}#e${n}` : sessionId);
/** The chain a payload belongs to: its own, or — a payload from before episodes — its session's. */
const chainOf = (j) => j?.chain_id ?? j?.session_id;

/** A move as the episode line says it. */
const moveText = (m) => `${m.kind === "branch" ? "branch " : ""}${clip(m.to ?? "", 80)}`;
/** The move a boundary carries: itself, or the one recorded beside a compaction. */
const moveOf = (b) => (b.kind === "compaction" ? b.moved : b.kind === "ticket" ? undefined : b);
/** How an episode began, for its line in the summary. */
const boundaryBegan = (b) => {
  const parts = [];
  if (b.kind === "compaction") parts.push("after a compaction");
  if (moveOf(b)) parts.push(`on the move to ${moveText(moveOf(b))}`);
  const base = parts.join(" and ");
  return b.ticket ? `${base}${base ? " " : ""}with ${b.ticket}` : base;
};
/** …and how it ended. */
const boundaryEnded = (b) => {
  const parts = [];
  if (b.kind === "compaction") parts.push("at a compaction");
  if (moveOf(b)) parts.push(`when the session moved to ${moveText(moveOf(b))}`);
  if (b.kind === "ticket") parts.push(`when ${b.ticket} was taken up`);
  return parts.join(" and ");
};

// ── The summary text ─────────────────────────────────────────────────────────

/** A path relative to the first project root that contains it; unchanged (absolute) when none does. */
function relPath(p, roots) {
  if (!isAbsolute(p)) return p;
  for (const root of roots) {
    const r = relative(root, p);
    if (r && !r.startsWith("..") && !isAbsolute(r)) return r;
  }
  return p;
}

/** Dedupe consecutive repeats of one prompt (a retried command), keep order. */
function distinctPrompts(prompts) {
  const out = [];
  for (const p of prompts) { const line = oneLine(p); if (line && out[out.length - 1] !== line) out.push(line); }
  return out;
}

/** How a redaction or a refusal names a prompt: its place in the distinct list the text shows, and a word when it lies past the listed ones (second review pass of SMD-2127). */
function promptLabel(i) {
  return `prompt ${i + 1}${i >= LIMITS.prompts ? ` (past the ${LIMITS.prompts} the text lists)` : ""}`;
}

/** An ISO timestamp as the summary shows it: the day and the minute. */
const when = (iso) => iso.slice(0, 16).replace("T", " ");

/**
 * The tickets a summary's header lists, at most three, and where they came from: `asks`, those the episode's asks
 * named; else `place`, those its branch or directory names; null for none (SMD-2013). The capture sends `from` as
 * `metadata.tickets_from` (SMD-3306 PR 7a-3b-2): the brain's subject rule keys a session by its header's tickets, and
 * the text alone cannot say which kind of list it holds — the summary lists only 12 asks, each cut at 200
 * characters, and an ask in lower case before a team is known counts for none.
 */
export function headerTickets(s) {
  const named = s.named ? [...s.named] : [];
  if (named.length) return { tickets: named.slice(0, 3), from: "asks" };
  const place = anchorOf(s.cwd, s.branch).slice(0, 3);
  return { tickets: place, from: place.length ? "place" : null };
}

/**
 * Render the summary — the session's, or one episode's — as one thought.
 * Deterministic: the same transcript renders the same text, which is what the
 * fingerprint and the state compare; and an episode's text depends on nothing
 * after it (not on how many episodes follow), so a closed one never changes.
 */
export function renderSummary(s) {
  const project = s.cwd && s.cwd !== HOME ? basename(s.cwd) : ""; // a session in $HOME names no project (and not the user)
  // A transcript with no timestamp is "undated", never today: the clock would
  // change the fingerprint at midnight and the same session would be captured twice (ninth review pass).
  const day = s.last || s.first ? (s.last || s.first).slice(0, 10) : "undated";
  const prompts = distinctPrompts(s.prompts);
  // The tickets first (SMD-2013): those the asks named, else the one the branch
  // or the directory names — a search for the ticket lands on this episode.
  const tickets = headerTickets(s).tickets.join(", ");
  const head = ["Session summary", tickets, s.harness, project, s.branch ? `(${s.branch})` : "", day].filter(Boolean).join(" — ").replace(" — (", " (");
  const parts = [head];
  const title = oneLine(s.title || prompts[0] || "");
  if (title) parts.push(`Title: ${clip(title, 120)}`);

  if (prompts.length) {
    const shown = prompts.slice(0, LIMITS.prompts).map((p) => `- ${clip(p, LIMITS.promptChars)}`);
    if (prompts.length > LIMITS.prompts) shown.push(`- … and ${prompts.length - LIMITS.prompts} more`);
    parts.push(`Asked (${prompts.length} prompt${prompts.length === 1 ? "" : "s"}):\n${shown.join("\n")}`);
  }
  const outcome = stripInjected(s.outcome).trim();
  if (outcome) parts.push(`Outcome (the assistant's last message):\n${clip(outcome, LIMITS.outcomeChars)}`);

  const changed = [];
  if (s.files.size) {
    // Inside the project, by relative path; outside it (a memory note, a scratch
    // file, another checkout) counted only — not the session's work, and the
    // path says where things live on this machine.
    const inside = [], outside = [];
    const roots = s.roots.size ? s.roots : new Set(s.cwd ? [s.cwd] : []);
    for (const f of s.files) { const r = relPath(f, roots); (isAbsolute(r) ? outside : inside).push(r); }
    if (inside.length) {
      const shown = inside.slice(0, LIMITS.files).join(", ") + (inside.length > LIMITS.files ? `, … ${inside.length - LIMITS.files} more` : "");
      changed.push(`${inside.length} file${inside.length === 1 ? "" : "s"} — ${shown}`);
    }
    if (outside.length) changed.push(`${outside.length} file${outside.length === 1 ? "" : "s"} outside the project`);
  }
  if (s.commits) changed.push(`${s.commits} commit${s.commits === 1 ? "" : "s"}${s.pushed ? ", pushed" : ""}`);
  if (s.prs.length) changed.push(`PR ${s.prs.join(", ")}`);
  if (changed.length) parts.push(`Changed: ${changed.join("; ")}.`);

  const brain = [];
  if (s.retrieved.size) brain.push(`retrieved ${s.retrieved.size} thought${s.retrieved.size === 1 ? "" : "s"}`);
  if (s.captured.size) brain.push(`captured ${s.captured.size}`);
  parts.push(brain.length ? `Brain: ${brain.join(", ")} (recorded as this summary's provenance).` : "Brain: no thoughts read or written this session.");
  // A summary of a session still running says so, and how it got here — a
  // compaction (PreCompact, manual or auto) or a turn (Stop) — so a reader
  // tells a checkpoint from an end; the end's summary carries no such line and
  // supersedes it (SMD-2012). The moment is the transcript's last timestamp,
  // never the clock: the fingerprint must not move with time.
  const tail = [];
  // Which piece of the session this is, and what bounded it (SMD-2013): only
  // when there is something to say — a session of one episode reads as before.
  if (s.n > 1 || s.closed) tail.push(`Episode ${s.n} of the session${s.opened ? `, begun ${boundaryBegan(s.opened)}` : ""}${s.closed ? `, ended ${boundaryEnded(s.closed)}` : ""}.`);
  if (s.checkpoint) {
    const at = s.last ? ` at ${when(s.last)}` : "";
    const how = s.checkpoint.kind === "compacted" ? `compacted${at}${s.checkpoint.trigger ? ` (${s.checkpoint.trigger})` : ""}` : `turn ended${at}`;
    tail.push(`Checkpoint: ${how}, continuing — the session's next checkpoint or its end supersedes this summary.`);
  }
  tail.push(`Session ${clip(s.sessionId || "unknown", LIMITS.sessionIdChars)}${s.first ? `, ${when(s.first)}` : ""}${s.last && s.last !== s.first ? ` → ${when(s.last)}` : ""}.`);
  // The cap falls on the body — prompts, outcome, files — never on the closing
  // lines: clip() cuts from the tail, and a long checkpoint summary that lost
  // the line saying the session still runs would read as final (first review
  // pass). The closing is bounded (the id clipped, the rest fixed), so the
  // whole stays within LIMITS.textChars (fifth review pass: an unbounded id
  // made that sentence false).
  // The body's room is never below one: clip() with a negative bound slices
  // from the end (second review pass; a session id longer than the cap is
  // unreachable through the hook — its payload name would fail — but the
  // arithmetic is honest, and the closing is then the whole).
  const closing = tail.join("\n\n");
  return `${clip(parts.join("\n\n"), Math.max(1, LIMITS.textChars - closing.length - 2))}\n\n${closing}`;
}

/**
 * The runs the summary's clips cut, in a text rendered from `s`: in the title (120 characters) and each listed prompt
 * (200), the last run before the clip's `…`, as `[at, end)` (SMD-4502). The scan of each whole prompt, and of the
 * title's source, judged that run uncut; read cut, two rules can judge it otherwise — the entropy rule's ratio and bar
 * on a shorter run, and the Google key's `\b` at the `…` — so it was blanked in the line while the header, read from
 * the whole prompt, named a ticket in it. The rendered text's scan leaves these runs to the whole prompt's verdict;
 * the rest of each line it still reads, so what a blanking exposed (a digest in an un-URL'd path) is still blanked.
 * Read at the places renderSummary writes the lines — the title just after the header's line, the prompts just after
 * `Asked (…):` — never searched for; a line the text's own cap cut is left to the text's scan.
 */
export function clipCuts(s, text) {
  const cuts = [];
  const prompts = distinctPrompts(s.prompts);
  const title = oneLine(s.title || prompts[0] || "");
  // clip(value, n) keeps value's first n - 1 characters, trimmed, then `…`. A run is cut only where the clip falls
  // between two of its characters; one it falls beside, a space between, is whole, and the text's scan reads it.
  const cutRun = (value, n, shown, at) => {
    if (value.length <= n || /\s/.test(value[n - 2]) || /\s/.test(value[n - 1])) return;
    cuts.push([at + shown.lastIndexOf(" ") + 1, at + shown.length]);
  };
  let at = text.indexOf("\n\n"); // the header is one line: the first blank line ends it
  if (at === -1) return cuts;
  if (title) {
    const shown = clip(title, 120), line = `\n\nTitle: ${shown}`;
    if (!text.startsWith(line, at)) return cuts;
    cutRun(title, 120, shown, at + "\n\nTitle: ".length);
    at += line.length;
  }
  if (!prompts.length || !text.startsWith("\n\nAsked (", at)) return cuts;
  let i = text.indexOf("\n", at + 2); // the end of the `Asked (…):` line
  for (const p of prompts.slice(0, LIMITS.prompts)) {
    const shown = clip(p, LIMITS.promptChars), line = `\n- ${shown}`;
    if (i === -1 || !text.startsWith(line, i)) break;
    cutRun(p, LIMITS.promptChars, shown, i + 3);
    i += line.length;
  }
  return cuts;
}

/**
 * The scan over everything the summary was built from — the rendered text and
 * the full prompts, outcome and title BEFORE their clips — so a credential a
 * clip would cut in half is still seen whole (third review pass: the scan ran
 * on the rendered text alone, and a key straddling a 200-character clip left as
 * a fragment no pattern matched). Findings from a source name where they sit.
 */
export function scanSummary(s, text) {
  // A run the summary's clips cut is judged by its whole source, below, not as the clip left it (SMD-4502).
  const found = scanForSecrets(text, { skip: clipCuts(s, text) });
  // Each prompt on its own (SMD-2127's first review pass): the redaction blanks
  // one prompt at a time, so a hit that existed only across the join —
  // `--password` ending one prompt, its value opening the next — was a refusal
  // no redaction could clear, at an offset into a join nobody sees.
  const sources = [...distinctPrompts(s.prompts).map((p, i) => [promptLabel(i), p]), ["the outcome", s.outcome ?? ""], ["the title", s.title ?? ""]];
  for (const [where, full] of sources) {
    for (const f of scanForSecrets(full)) if (!found.some((g) => g.reason.replace(/ in (?:prompt \d+(?: \(past the \d+ the text lists\))?|the outcome|the title)$/, "") === f.reason)) found.push({ ...f, reason: `${f.reason} in ${where}` });
  }
  return found;
}

/** The ids sent as derived_from: what the session retrieved, then what it captured, capped. */
export function provenanceOf(s) {
  return [...s.retrieved, ...s.captured].slice(0, LIMITS.derived);
}

/**
 * The episode's assistant messages, oldest of the kept window first, joined and
 * tail-clipped — the model's input beside the derived summary (SMD-2014). Never
 * tool results, never a human prompt, never the raw transcript: only what the
 * assistant itself wrote. `{ text }`, empty when the episode has no assistant
 * text; or `{ withheld }`, why there is none to send.
 *
 * Scanned and blanked whole before the clip, as the summary's sources are
 * (SMD-3656): a clip through a secret's prefix (`w|c_` and 64 hex, `sk-a|nt-…`)
 * left a body no rule matched, and modelSummary's scan of the clipped excerpt
 * passed it to the model. A multi-line key block is withheld whole, as the
 * summary refuses one, and so is any secret under `refuse`, as the derived
 * summary's episode would be.
 */
export function assistantExcerpt(ep, onSecret = "redact") {
  const joined = (ep.assistant ?? []).map((t) => String(t).trim()).filter(Boolean).join("\n\n----\n\n");
  const r = redactSecrets(joined);
  if (r.blocks.length) return { withheld: `a multi-line key block (${r.blocks[0].reasons.join(", ")}) in the assistant messages` };
  if (onSecret === "refuse" && r.spans.length) return { withheld: `${r.spans[0].reasons.join(", ")} in the assistant messages, under OB1_CAPTURE_ON_SECRET=refuse` };
  return { text: r.text.length > LIMITS.modelInputChars ? r.text.slice(-LIMITS.modelInputChars) : r.text };
}

/**
 * An episode with its secrets blanked and its summary rendered from the
 * blanked sources — the prompts one by one, the outcome and the title, the
 * sources scanSummary reads whole — so a key a clip would cut in half is
 * blanked before the clip; then the rendered text once more, for what reaches
 * it from elsewhere (a path, a link). The episode given is not changed.
 * `redactions` names each span taken — its reasons, its offset in the source
 * it sat in — for the payload, the message and the log.
 */
export function redactEpisode(ep) {
  const redactions = [];
  const blocks = [];
  // A pasted key blob is found on the RAW sources: the summary flattens a
  // prompt's newlines (oneLine), so a multi-line block must be seen before that
  // — a key-material span crossing a newline is a blob the caller refuses
  // (SMD-2127 scope call). The blanking below runs on the flattened summary.
  const addBlocks = (raw, place) => { if (typeof raw === "string" && raw) for (const b of redactSecrets(raw).blocks) blocks.push({ reason: b.reasons.join(", "), in: place }); };
  for (const p of ep.prompts) addBlocks(p, "a prompt");
  addBlocks(ep.outcome, "the outcome");
  addBlocks(ep.title, "the title");
  const take = (text, place, skip) => {
    if (typeof text !== "string" || !text) return text;
    const r = redactSecrets(text, { skip });
    for (const sp of r.spans) redactions.push({ reason: sp.reasons.join(", "), at: sp.at, in: place });
    return r.text;
  };
  // The DISTINCT prompts, as the summary lists them: a retried prompt is one
  // line in the text and one redaction in the count.
  // The title as the summary shows it, on one line, as the prompts are (SMD-4292 review pass 2, secrets adversary: blanked
  // as written, a quoted value whose closing quote is on the next line was cut there, and the rest shown).
  const redacted = { ...ep, prompts: distinctPrompts(ep.prompts).map((p, i) => take(p, promptLabel(i))), outcome: take(ep.outcome, "the outcome"), title: take(typeof ep.title === "string" ? oneLine(ep.title) : ep.title, "the title") };
  // The rendered text's own pass blanks what reaches it from elsewhere (a path, a link) and what a blanking above
  // exposed, and leaves each run a clip cut as the passes above judged it whole (SMD-4502).
  const rendered = renderSummary(redacted);
  const text = take(rendered, "the text", clipCuts(redacted, rendered));
  return { ep: redacted, text, redactions, blocks };
}
/** The episode's summary as it would be sent under a mode: blanked and re-rendered, or as rendered. */
export function cleanEpisode(ep, onSecret) {
  return onSecret === "redact" ? redactEpisode(ep) : { ep, text: renderSummary(ep), redactions: [], blocks: [] };
}
/**
 * The gate over a cleaned episode, whatever the mode: any MULTI-LINE key block
 * — a pasted key blob the scope call refuses rather than redacts (SMD-2127) —
 * and the single-line secrets the scan still sees in the blanked sources and
 * the text (the net under the redaction). Returns a phrase per finding for the
 * refusal message; empty means the summary may be sent.
 */
export function gateFindings(cleaned, text) {
  const where = (cleaned.blocks ?? []).map((b) => `a multi-line key block (${b.reason}) in ${b.in}`);
  for (const f of scanSummary(cleaned.ep, text)) where.push(`${f.reason} at char ${f.at}`);
  return where;
}

export { anchorOf, boundaryBegan, boundaryEnded, chainOf, distinctPrompts, emptySummary, when };
