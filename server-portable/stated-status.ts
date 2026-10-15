/**
 * stated-status.ts — which tickets a search hit no longer tells right
 * (SMD-2540): the reading evals/eval-stated-status.ts measured and chose,
 * moved-session-settled. No imports: the core calls it over a hit's text and
 * migration 092's ticket_status_inputs, and the eval's self-check holds it to
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
 * and a ticket's history is every row's carrying its key while its status now
 * is the head's.
 */

/** A ticket key, whole word: 077's lookarounds. */
const KEY_RE = /(?<![A-Za-z0-9_])([A-Z][A-Z0-9]+)-([0-9]+)(?![A-Za-z0-9_])/g;
/** One list step after a key: a separator, then a bare number that is a whole token and not a date, time, version or range; kept only at the key's own digit count. */
const STEP_RE = /^\s*(?:,|\/|→|\+|&|and(?![A-Za-z])|or(?![A-Za-z]))\s*([0-9]{2,6})(?![A-Za-z0-9_]|[-:./–][0-9])/;
/** The session hook's last line: `Session <uuid>, 2026-10-02 21:54 → 2026-10-03 03:02.` (UTC). */
const SESSION_RE = /^Session [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}, \d{4}-\d{2}-\d{2} \d{2}:\d{2} → (\d{4}-\d{2}-\d{2}) (\d{2}):(\d{2})\.$/gm;

/** The writer's own move reaching the brain late: a ticket at its current type this long after the note is not labelled. */
export const SETTLE_MS = 60 * 60 * 1000;
/** How many moved tickets a hit's text line names before "+N more" (3 is the measured p90 per labelled thought; the structured field carries all). */
export const MOVED_SHOWN = 3;

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
 * log's order. The caller never asks for a thought with a lifecycle of its
 * own: its status is its own.
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

/** The hit's text line: `⚠ Moved since written: SMD-2306 In Progress → Done; … (+N more)`, or null when nothing moved. */
export function movedLine(moved: readonly Moved[]): string | null {
  if (moved.length === 0) return null;
  const shown = moved.slice(0, MOVED_SHOWN).map((m) => `${m.ticket} ${m.then.name} → ${m.now.name}`).join("; ");
  const more = moved.length - MOVED_SHOWN;
  return `⚠ Moved since written: ${shown}${more > 0 ? ` (+${more} more)` : ""}`;
}
