/**
 * stated-status.ts — the pure readings of SMD-2540: which tickets a thought
 * names (with the bare numbers that continue a list of keys), when its content
 * was written, a ticket's status at a time, and the candidates that label a
 * ticket whose status the thought no longer tells right. No imports:
 * evals/eval-stated-status.ts measures the candidates with them, and the label
 * PR 2 ships is held to the one chosen.
 *
 * Keys are read as 077's ticket_references reads them, `TEAM-123` between ASCII
 * lookarounds. What this adds is the list: `(SMD-2287, 2286, 2382, 2306; 2306
 * is in progress)` names four tickets, and its last clause speaks of SMD-2306
 * by its number alone.
 */

/** A ticket key, whole word: the lookarounds are 077's. */
const KEY_RE = /(?<![A-Za-z0-9_])([A-Z][A-Z0-9]+)-([0-9]+)(?![A-Za-z0-9_])/g;
/**
 * One step of a list after a key: a separator, then a bare number that is a
 * whole token and not the start of a date, time, version or range (`2026-10-03`,
 * `10:30`, `1.2`, `3/4`, `2283–2285`). The caller keeps it only when it has as
 * many digits as the key's own number, so `SMD-1234, 42 tests` names no SMD-42.
 */
const STEP_RE = /^\s*(?:,|\/|→|\+|&|and(?![A-Za-z])|or(?![A-Za-z]))\s*([0-9]{2,6})(?![A-Za-z0-9_]|[-:./–][0-9])/;
/** A bare number anywhere: not inside a key (`-` before it), an id or a version, and not a PR or issue number (`#`). */
const BARE_RE = /(?<![A-Za-z0-9_\-.:/#])([0-9]{2,6})(?![A-Za-z0-9_]|[-:./–][0-9])/g;
/** The session hook's last line: `Session <uuid>, 2026-10-02 21:54 → 2026-10-03 03:02.` (UTC). */
const SESSION_RE = /^Session [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}, \d{4}-\d{2}-\d{2} \d{2}:\d{2} → (\d{4}-\d{2}-\d{2}) (\d{2}):(\d{2})\.$/gm;
/** How far after a mention a stated status may sit, and where a clause ends first. */
export const STATED_SPAN = 60;
const CLAUSE_END = /[.;!?\n]/;

/** How a mention named its ticket: the key itself, a list step after a key, or a bare number repeating a key the thought names. */
export type How = "key" | "list" | "bare";
export type Mention = { key: string; start: number; end: number; how: How };

/** Every ticket mention in `text`, in order: keys, list steps after them, and bare numbers that repeat a key named either way. */
export function mentionsOf(text: string): Mention[] {
  const out: Mention[] = [];
  for (const m of text.matchAll(KEY_RE)) {
    const team = m[1], digits = m[2].length;
    out.push({ key: `${team}-${m[2]}`, start: m.index!, end: m.index! + m[0].length, how: "key" });
    let at = m.index! + m[0].length;
    for (;;) {
      const s = STEP_RE.exec(text.slice(at));
      if (!s || s[1].length !== digits) break;
      const end = at + s[0].length;
      out.push({ key: `${team}-${s[1]}`, start: end - s[1].length, end, how: "list" });
      at = end;
    }
  }
  // A bare number repeats a key only when the thought names that key, and only
  // for one team: two teams with the same number leave it unread.
  const byNumber = new Map<string, Set<string>>();
  for (const x of out) {
    const n = x.key.slice(x.key.lastIndexOf("-") + 1);
    byNumber.set(n, (byNumber.get(n) ?? new Set()).add(x.key));
  }
  const taken = new Set(out.map((x) => x.start));
  for (const m of text.matchAll(BARE_RE)) {
    const keys = byNumber.get(m[1]);
    if (keys?.size !== 1 || taken.has(m.index!)) continue;
    out.push({ key: [...keys][0], start: m.index!, end: m.index! + m[1].length, how: "bare" });
  }
  return out.sort((a, b) => a.start - b.start);
}

/** The distinct keys among `mentions`, sorted (byte order). `how` limits them to those named by these readings. */
export function keysOf(mentions: Mention[], how: readonly How[] = ["key", "list", "bare"]): string[] {
  return [...new Set(mentions.filter((m) => how.includes(m.how)).map((m) => m.key))].sort();
}

/** The end of the session a hook summary records, as ms since the epoch (the last second of that minute, UTC); undefined when the text carries no session line. */
export function sessionEnd(content: string): number | undefined {
  let last: RegExpExecArray | undefined;
  for (const m of content.matchAll(SESSION_RE)) last = m as RegExpExecArray;
  if (!last) return undefined;
  return Date.parse(`${last[1]}T${last[2]}:${last[3]}:59.999Z`);
}

/** A row's place in its supersedes chain: when it was stored, and the row it supersedes. */
export type ChainRow = { created: number; supersedes: string | null };

/** When the oldest row of `id`'s supersedes chain was stored; a cycle or a missing row ends the walk. */
export function chainRoot(id: string, rows: ReadonlyMap<string, ChainRow>): number | undefined {
  const seen = new Set<string>();
  let cur = rows.get(id), at = cur?.created;
  while (cur && cur.supersedes && !seen.has(cur.supersedes)) {
    seen.add(cur.supersedes);
    cur = rows.get(cur.supersedes);
    if (cur && cur.created < at!) at = cur.created;
  }
  return at;
}

/** A status a ticket held: its name, its type, and from when (ms, the event that recorded it). */
export type Status = { name: string; type: string };
export type Change = Status & { at: number };

/** The status a ticket held at `t`: the last change at or before it; undefined before the first. `timeline` is in recorded order. */
export function statusAt(timeline: readonly Change[], t: number): Status | undefined {
  let s: Status | undefined;
  for (const c of timeline) { if (c.at > t) break; s = { name: c.name, type: c.type }; }
  return s;
}

/**
 * The first status `text` states for the mention ending at `end`: a status name
 * the vocabulary knows, whole word, case-insensitive, after the mention and
 * within STATED_SPAN characters, before its clause ends. Undefined when none.
 */
export function statedAfter(text: string, end: number, vocabulary: ReadonlyMap<string, string>): Status | undefined {
  let tail = text.slice(end, end + STATED_SPAN);
  const stop = CLAUSE_END.exec(tail);
  if (stop) tail = tail.slice(0, stop.index);
  let best: { at: number; s: Status } | undefined;
  for (const [name, type] of vocabulary) {
    const re = new RegExp(`(?<![A-Za-z])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+")}(?![A-Za-z])`, "i");
    const m = re.exec(tail);
    if (m && (!best || m.index < best.at)) best = { at: m.index, s: { name, type } };
  }
  return best?.s;
}

/**
 * The candidates, pre-registered (evals/eval-stated-status.ts's header says how
 * one is chosen):
 *   moved-stored         — each ticket the thought names whose status type
 *                          differs now from when the thought was STORED;
 *   moved-chain          — the same, "written" being when its supersedes
 *                          chain's oldest row was stored;
 *   moved-session        — the same, "written" being the session's end its
 *                          hook line records, else when it was stored;
 *   moved-session-stated — moved-session, only for a ticket some mention of
 *                          which is followed by a stated status (any): the
 *                          note says something of its state, and the claim
 *                          is still the history's, not the text's;
 *   stated-keys          — a status the text states after a key, whose type
 *                          differs from the ticket's now;
 *   stated-lists         — the same over list steps and bare numbers too.
 * Each reads a thought with no lifecycle of its own only (node_state's open IS
 * NULL): the caller never passes a ticket row or a note filed under one.
 */
export const CANDIDATES = ["moved-stored", "moved-chain", "moved-session", "moved-session-stated", "stated-keys", "stated-lists"] as const;
/**
 * The second registration (written after the first's grades, before it ran):
 *   moved-session-lag — moved-session, its "then" read LAG_MS after the
 *                       written time: a ticket that moved within the hour
 *                       after the note is taken as moved by it. Every wrong
 *                       label moved-session made among the graded ones was a
 *                       note written 0–18 minutes before board-sync (a pass
 *                       every 5 minutes) recorded a move its writer had just
 *                       made. The lag can only take a label away.
 */
export const SECOND = ["moved-session-lag"] as const;
/**
 * The third registration (written after the second failed, before it ran;
 * chosen by the maintainer over stopping):
 *   moved-session-settled — moved-session's "then", read at the written time,
 *                           and no label when the ticket already held its
 *                           current status type LAG_MS after it: the writer's
 *                           own move reaching the brain late. moved-session-lag
 *                           read "then" an hour late instead, and so put a move
 *                           the note never knew of into its claim (45144934:
 *                           SMD-2294 started a minute after the session ended).
 */
export const THIRD = ["moved-session-settled"] as const;
export type Candidate = (typeof CANDIDATES)[number] | (typeof SECOND)[number] | (typeof THIRD)[number];
/** moved-session-lag's allowance for the writer's own move reaching the brain: one hour. */
export const LAG_MS = 60 * 60 * 1000;

/** A label: the ticket, what the thought had (`then`: its status when written; `stated`: what the text says), and its status now. */
export type Label = { key: string; kind: "moved" | "stated"; claim: Status; now: Status };

/** What a candidate reads of a thought. `head` is the ticket's status now, undefined when the brain holds no head or the type is not a lifecycle type. */
export type Reading = {
  content: string;
  stored: number;
  chainRoot: number;
  head: (key: string) => Status | undefined;
  timeline: (key: string) => readonly Change[];
  vocabulary: ReadonlyMap<string, string>;
};

/** When a moved-* candidate takes the thought as written — the time its "then" status is read at. */
export function writtenAt(candidate: Candidate, r: Pick<Reading, "content" | "stored" | "chainRoot">): number {
  if (candidate === "moved-stored") return r.stored;
  if (candidate === "moved-chain") return r.chainRoot;
  return (sessionEnd(r.content) ?? r.stored) + (candidate === "moved-session-lag" ? LAG_MS : 0);
}

/** The labels `candidate` puts on one thought, one per ticket at most, sorted by key. */
export function labelsOf(candidate: Candidate, r: Reading): Label[] {
  const mentions = mentionsOf(r.content);
  const out: Label[] = [];
  if (candidate.startsWith("moved-")) {
    const written = writtenAt(candidate, r);
    const said = candidate === "moved-session-stated" ? new Set(mentions.filter((m) => statedAfter(r.content, m.end, r.vocabulary)).map((m) => m.key)) : null;
    for (const key of keysOf(mentions, ["key", "list"])) {
      if (said && !said.has(key)) continue;
      const now = r.head(key), then = statusAt(r.timeline(key), written);
      if (candidate === "moved-session-settled" && now && statusAt(r.timeline(key), written + LAG_MS)?.type === now.type) continue;
      if (now && then && then.type !== now.type) out.push({ key, kind: "moved", claim: then, now });
    }
    return out;
  }
  const how: readonly How[] = candidate === "stated-keys" ? ["key"] : ["key", "list", "bare"];
  const seen = new Set<string>();
  for (const m of mentions) {
    if (!how.includes(m.how) || seen.has(m.key)) continue;
    const now = r.head(m.key), stated = statedAfter(r.content, m.end, r.vocabulary);
    if (!now || !stated || stated.type === now.type) continue;
    seen.add(m.key);
    out.push({ key: m.key, kind: "stated", claim: stated, now });
  }
  return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}
