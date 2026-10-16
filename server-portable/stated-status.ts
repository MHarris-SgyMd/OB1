/**
 * stated-status.ts — which tickets a search hit no longer tells right
 * (SMD-2540): the reading evals/eval-stated-status.ts measured and chose,
 * moved-session-settled. No imports: both searches call it (core/reads.ts's
 * movedAmong, SMD-2540 PR 2b) over a hit's text and migration 095's
 * ticket_status_inputs; the eval's self-check holds it to
 * evals/stated-status.ts's labelsOf("moved-session-settled", …) on hand cases
 * and a fuzz, so the label shipped is the label measured.
 *
 * A thought names a ticket by its key (`SMD-2306`, 077's reading) or by a list
 * step after a key (`SMD-2287, 2286, 2306`: the bare number continues the
 * list). It was written when its session ended (the session hook's last line,
 * `Session <uuid>, A → B.`), else when its row was stored — a re-captured
 * summary is stored days after its session. A ticket it names has MOVED when
 * its status type then differs from its status type now; but not when the
 * ticket already held its current type an hour after the note was written:
 * that is the writer's own move reaching the brain after the note (board-sync
 * passes every 5 minutes), and the note may already say so.
 *
 * Known hazards, inside the measured precision (29 of 30 held out): a list
 * step takes a count with the key's digit count as a ticket (`SMD-2306, 1006
 * summaries` reads SMD-1006 — labelled only if that ticket exists and moved),
 * and a ticket's history is the events of the rows now carrying a named key
 * while its status now is the head's. The measured population is thoughts
 * with no lifecycle of their own that nothing supersedes (the eval sampled
 * no superseded thought, so a label on one is unmeasured).
 */

/** A ticket key, whole word: 077's lookarounds. */
const KEY_RE = /(?<![A-Za-z0-9_])([A-Z][A-Z0-9]+)-([0-9]+)(?![A-Za-z0-9_])/g;
/** One list step after a key: a separator, then a bare number that is a whole token and not a date, time, version or range; kept only at the key's own digit count. */
const STEP_RE = /^\s*(?:,|\/|→|\+|&|and(?![A-Za-z])|or(?![A-Za-z]))\s*([0-9]{2,6})(?![A-Za-z0-9_]|[-:./–][0-9])/;
/** The session hook's last line: `Session <uuid>, 2026-10-02 21:54 → 2026-10-03 03:02.` (UTC). */
const SESSION_RE = /^Session [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}, \d{4}-\d{2}-\d{2} \d{2}:\d{2} → (\d{4}-\d{2}-\d{2}) (\d{2}):(\d{2})\.$/gm;

/** The writer's own move reaching the brain late: a ticket at its current type this long after the note is not labelled. */
export const SETTLE_MS = 60 * 60 * 1000;
/**
 * The tickets read per hit: its first this many named, by key. Stable's most
 * on one thought is 12; a hit naming thousands (a write key's, or a huge
 * board's) would make the line and 095's call grow without bound — 10,000 keys
 * took a second (the maintainer's call, review pass 2).
 */
export const MOVED_READ = 50;
/** The tickets `text` names by key or list step, each once, sorted (byte order). */
export function ticketsNamed(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(KEY_RE)) {
    const team = m[1], digits = m[2].length;
    out.add(`${team}-${m[2]}`);
    let at = m.index! + m[0].length;
    for (;;) {
      const s = STEP_RE.exec(text.slice(at));
      if (!s || s[1].length !== digits) break;
      out.add(`${team}-${s[1]}`);
      at += s[0].length;
    }
  }
  return [...out].sort();
}

/** When the thought was written, ms since the epoch: the end of the session its hook line records (the last second of that minute, UTC), else `stored`. */
export function writtenAt(text: string, stored: number): number {
  let last: RegExpMatchArray | undefined;
  for (const m of text.matchAll(SESSION_RE)) last = m;
  return last ? Date.parse(`${last[1]}T${last[2]}:${last[3]}:59.999Z`) : stored;
}

/** A status a ticket holds: its name and its type. */
export type Status = { name: string; type: string };
/** One status a ticket's rows held, from the event that recorded it (ms), in the log's order. */
export type Change = Status & { at: number };

/** The status a ticket held at `t`: the last change, in the log's order, whose time is at or before it; undefined when none is. */
export function statusAt(history: readonly Change[], t: number): Status | undefined {
  let s: Status | undefined;
  for (const c of history) if (c.at <= t) s = { name: c.name, type: c.type };
  return s;
}

/** A ticket a hit no longer tells right: its status when the thought was written, and now. */
export type Moved = { ticket: string; then: Status; now: Status };

/**
 * The tickets `text` names that moved since it was written (moved-session-
 * settled), sorted by key. `head` is a ticket's status now, undefined when
 * the brain holds no head with a known type; `history` its changes in the
 * log's order. Not for a thought with a lifecycle of its own (a ticket row,
 * a note filed under one): its status is its own, and the measurement never
 * labelled one.
 */
export function movedSince(text: string, stored: number, head: (ticket: string) => Status | undefined, history: (ticket: string) => readonly Change[]): Moved[] {
  const written = writtenAt(text, stored);
  const out: Moved[] = [];
  for (const ticket of ticketsNamed(text)) {
    const now = head(ticket);
    if (!now) continue;
    const h = history(ticket), then = statusAt(h, written);
    if (!then || then.type === now.type) continue;
    if (statusAt(h, written + SETTLE_MS)?.type === now.type) continue;
    out.push({ ticket, then, now });
  }
  return out;
}

/** What the label reads, as migration 095 answers it (store.ts's TicketStatusInputs; spelled here so this module imports nothing). */
export type MovedInputs = { lifecycle: ReadonlySet<string>; heads: ReadonlyMap<string, Status>; history: ReadonlyMap<string, readonly Change[]> };

/**
 * Each hit's moved tickets, by id — only the hits the measurement labelled:
 * none `superseded` names (the eval sampled no superseded thought) and none
 * with a lifecycle of its own. Nor a ticket row (`metadata.issue`) whose type
 * gives it none: a duplicate's row is lifecycle-less to node_state (16 of
 * stable's 721 rows), so the measurement labelled the tickets its body
 * quotes, but a ticket row tells its own status, never others'. A hit whose
 * stored time does not parse is read at its session line, and with none is
 * labelled nothing (no change is at or before an unknown time); one with
 * nothing moved is absent.
 */
export function movedAmong(hits: readonly { id: string; content: string; created_at: string | null; metadata?: Record<string, unknown> | null }[], superseded: Readonly<Record<string, string>>, inputs: MovedInputs): Record<string, Moved[]> {
  const out: Record<string, Moved[]> = {};
  for (const h of hits) {
    if (superseded[h.id] || inputs.lifecycle.has(h.id.toLowerCase()) || h.metadata?.issue !== undefined) continue;
    // Its first MOVED_READ named only, as movedOf reads them: another hit's may be among the heads.
    const read = new Set(ticketsNamed(h.content).slice(0, MOVED_READ));
    const moved = movedSince(h.content, Date.parse(h.created_at ?? ""), (t) => (read.has(t) ? inputs.heads.get(t) : undefined), (t) => inputs.history.get(t) ?? []);
    if (moved.length > 0) out[h.id] = moved;
  }
  return out;
}

/**
 * A status as a reply prints it: a fixed word for its type, never the board's
 * name. The name is a ticket row's free text, and any write key can write a
 * ticket row — even one stamped agent or ingested — so printed beside another
 * thought's `By:` line, past the caller's min_trust, it would be words no one
 * vouched for; an allowlist leaves nothing to clean (the maintainer's call,
 * review pass 2). The six are node_lifecycle_types() (068), the only types 095
 * returns; a custom state reads as its type's word ("In Review" as In
 * Progress). The REST answer keeps each status's name for a caller that wants it.
 */
export const TYPE_WORDS: Readonly<Record<string, string>> = { triage: "Triage", backlog: "Backlog", unstarted: "Todo", started: "In Progress", completed: "Done", canceled: "Canceled" };
const word = (type: string) => TYPE_WORDS[type] ?? "?";

/**
 * The moved tickets in words — `SMD-2306 In Progress → Done; …` — every one
 * read, by key (stable's dd70dccc names seven, and the one its reader came for,
 * SMD-2306, is the fifth: the maintainer's call), and how many named tickets
 * past MOVED_READ were not read; null when none moved and none went unread.
 */
export function movedWords(moved: readonly Moved[], notRead = 0): string | null {
  const unread = notRead > 0 ? `${notRead} more named, not read` : "";
  if (moved.length === 0) return unread ? `none of the first ${MOVED_READ} named; ${unread}` : null;
  const words = moved.map((m) => `${m.ticket} ${word(m.then.type)} → ${word(m.now.type)}`).join("; ");
  return unread ? `${words}; ${unread}` : words;
}

/** How many tickets `text` names past the MOVED_READ that are read. */
export const notReadIn = (text: string) => Math.max(0, ticketsNamed(text).length - MOVED_READ);
