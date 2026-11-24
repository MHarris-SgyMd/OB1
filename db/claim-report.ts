#!/usr/bin/env bun
/**
 * claim-report.ts — how long work claims run, from claim to release (SMD-4540 PR 2).
 *
 * A claim's lease says its holder is still there, not when its work will be
 * done. Every row of work_claims (migration 115) keeps when it was claimed and
 * when it ended, and why; since migration 152 how many of its renewals landed.
 * This report reads them as durations, so SMD-4541 can decide whether a claim
 * should state when its work will be done.
 *
 *   bun db/claim-report.ts --from FILE [--sizes FILE] [--now ISO] [--json]
 *   bun db/claim-report.ts --url postgres://… [--sizes FILE] [--now ISO] [--json]
 *   bun db/claim-report.ts --self-check
 *
 * --from reads claims as list_claims answers them, with include_ended: a JSON
 * array of claims, a page (an object with a `claims` array: REST's
 * `GET /v1/claims` body), or an array of pages walked to the end (each page's
 * `cursor` as the next call's `after`); the server's camelCase or work_claims'
 * snake_case. An MCP tool result is unwrapped (its `structuredContent`, else its
 * text; a JSON-RPC answer's `result`). A page that says `truncated` as the last
 * one read is refused: the rest of the brain is missing; pages that hold fewer
 * claims than the first page counted are warned of. A walk without include_ended
 * holds live claims alone. A brain's claims reach it that way through any
 * client holding a read key, with no database credentials.
 * --url reads work_claims directly (SELECT on it, the `claims` group's). Give
 * one of the two.
 * --sizes reads merged PRs' sizes: `gh pr list --state merged --limit 500 --json
 * number,additions,deletions` as it prints them, or an object by number,
 *   { "869": { "additions": 540, "deletions": 23 } }
 * A merged claim's PRs are read from its release reason's first sentence (split
 * at a full stop before a capital): each "OB1 PR N" and the list that follows one
 * ("OB1 PR 705, PR 710 and PR 719"), summed; else its last "PR N". Other wordings
 * ("OB1 PR 705, 710 and 719", "OB1 PR 832/847") read the first PR alone.
 * --now dates the report, an ISO time with its zone (2026-11-23T19:15:00Z; a
 * time without one is refused): a claim made after it is left out, one released
 * after it reads as unreleased, and lapsed or live is read against it. Unset,
 * the clock: give a saved dump the time it was read, or a claim live then whose
 * lease has since ended reads as lapsed. A row keeps only its last lease and
 * count, so a claim renewed after --now reads with that renewal.
 * --json prints the report's numbers, and what it cannot see, instead of its table.
 *
 * How a claim ended (ENDINGS), read from its release:
 *   merged                 its holder released it saying "merged", in a clause
 *                          (to the next . ; : or ,) that doesn't deny it first
 *                          with "not", "never", "without", "unless", "until",
 *                          "yet", "be" or "n't" (the claim rule's "Merged: OB1 PR
 *                          N → main …"). A merge of something else ("merged main
 *                          into the branch, then dropped") reads as one too.
 *   closed by board-sync   released as its ticket closed, by the server's own
 *                          test (closedBySync: the claim's ticket, 118's reason)
 *   taken over             lapsed, and another claim on its work took it over
 *   force-released         another key released it (an operator's force; an
 *                          operator's release after a merge reads here too)
 *   released (other)       its holder released it for another reason: a split
 *                          into pieces, a drop, a test
 *   lapsed, never released past its lease, released by nobody (timed to its
 *                          lease's end, which is no end of its work)
 *   live                   neither (left out)
 * The durations by client, by shape and by size are of merged claims alone:
 * the claims whose work is known to have finished.
 *
 * What it cannot see is NOT_SEEN, printed under the table and carried in --json.
 * On the renewal count's pace: a Claude Code agent renews at each commit, push
 * and long test run, its session hook at compactions and the session's end and,
 * with the claims hook pasted, each quarter of the lease; the agent runner when
 * it publishes. So counts compare within one client.
 *
 * --url reads work_claims' columns by name, renewals only where the column is
 * there (before migration 152 every claim reads uncounted); a role without
 * SELECT on it is told which grant it lacks.
 */
import { readFileSync } from "node:fs";
import { commandLine } from "./cli.ts";
import { closedBySync, TAKEN_OVER } from "../server-portable/core/claims.ts";
import { closeThenExit, databaseUrl, openSql } from "./connect.ts";

/** One claim as the report reads it, from either input. */
export type ClaimRow = {
  id: string; issue: string; piece: string | null; holder: string; holderKind: string | null; label: string | null;
  claimedAt: string; renewedAt: string | null; expiresAt: string; releasedAt: string | null;
  releasedBy: string | null; releasedByKind: string | null; releaseReason: string | null;
  /** Migration 152's count; null where uncounted (a claim from before 152, or a brain before it). */
  renewals: number | null;
};

export const ENDINGS = ["merged", "closed by board-sync", "taken over", "force-released", "released (other)", "lapsed, never released", "live"] as const;
export type Ending = (typeof ENDINGS)[number];
/**
 * A merge named in a release reason: "Merged: OB1 PR 869 → main …", "SMD-3379 PR 2b-2a merged: OB1 PR 706 …". The
 * word, not a PR's number: a split's reason names its pieces ("Split into PR 1 … and PR 2 …").
 */
const MERGED_RE = /(?<!\b(?:not|never|without|unless|until|yet|be)\b[^.;:,]*|n['’]t\b[^.;:,]*)\bmerged\b/i;
/** The repository's PRs, as the claim rule writes them ("OB1 PR 869"), each with the list that follows it ("…, PR 710 and PR 719"); else any "PR N". */
const OB1_PR_RE = /\bOB1 PR (\d+)((?:,? (?:and )?PR \d+\b)*)/g;
const PR_RE = /\bPR (\d+)\b/g;
/** An ISO time with its zone, as --now takes it: a time without one would be read in the machine's own. */
const ISO_ZONED = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/i;
/** --now's text as ms, NaN where it is no ISO time with its zone. */
export const nowOf = (text: string) => (ISO_ZONED.test(text) ? Date.parse(text) : NaN);
export const SIZE_BUCKETS = ["under 100 lines", "100 to 499 lines", "500 to 1,999 lines", "2,000 lines or more", "size unknown"] as const;

/** A claim read from one list_claims entry or one work_claims row, or null where it is not one. */
export function rowOf(o: unknown): ClaimRow | null {
  if (!o || typeof o !== "object") return null;
  const r = o as Record<string, unknown>;
  const pick = (...keys: string[]) => { for (const k of keys) if (r[k] !== undefined) return r[k]; return undefined; };
  const text = (...keys: string[]) => { const v = pick(...keys); return typeof v === "string" ? v : null; };
  const time = (...keys: string[]) => {
    const v = pick(...keys);
    const d = v instanceof Date ? v : typeof v === "string" ? new Date(v) : null;
    return d && Number.isFinite(d.getTime()) ? d.toISOString() : null;
  };
  const id = text("id"), issue = text("issue"), holder = text("holder", "holder_name");
  const claimedAt = time("claimedAt", "claimed_at"), expiresAt = time("expiresAt", "expires_at");
  if (!id || !issue || !holder || !claimedAt || !expiresAt) return null;
  const n = pick("renewals");
  const count = typeof n === "number" ? n : typeof n === "string" && /^\d+$/.test(n) ? Number(n) : null;
  return {
    id, issue, piece: text("piece"), holder, holderKind: text("holderKind", "holder_kind"), label: text("label"),
    claimedAt, renewedAt: time("renewedAt", "renewed_at"), expiresAt, releasedAt: time("releasedAt", "released_at"),
    releasedBy: text("releasedBy", "released_by"), releasedByKind: text("releasedByKind", "released_by_kind"),
    releaseReason: text("releaseReason", "release_reason"),
    renewals: count !== null && Number.isInteger(count) && count >= 0 ? count : null,
  };
}

/** How a claim ended, at `now` (ms). */
export function endingOf(c: ClaimRow, now: number): Ending {
  if (c.releasedAt === null) return Date.parse(c.expiresAt) <= now ? "lapsed, never released" : "live";
  const why = c.releaseReason ?? "";
  if (why === TAKEN_OVER) return "taken over";
  if (closedBySync(c.issue, why, c.releasedByKind)) return "closed by board-sync";
  if (c.releasedBy !== null && c.releasedBy !== c.holder) return "force-released";
  if (MERGED_RE.test(why)) return "merged";
  return "released (other)";
}

/** The client a claim's holder ran, by its label's first word before '@' ("claude-code@mac …"), else its key's name. */
export function clientOf(c: ClaimRow): string {
  const first = (c.label ?? "").trim().split(/\s+/)[0] ?? "";
  const at = first.indexOf("@");
  return at > 0 ? first.slice(0, at).toLowerCase() : c.holder;
}

/**
 * The merged PRs' numbers, from the reason's first sentence: each it writes "OB1 PR N", the claim rule's form, with the
 * list that follows one ("OB1 PR 705, PR 710 and PR 719"); else the last "PR N" it names. A piece's own name comes
 * either side ("SMD-1723 PR 1 merged: OB1 PR 776", "OB1 PR 869 → main (SMD-4540 PR 1)"), and a later sentence may name
 * earlier pieces' PRs ("PR 3b-2 merged: OB1 PR 860 … . PR 3b is done: 3b-1 (OB1 PR 839) …"), which are not this claim's.
 */
export function prsOf(c: ClaimRow): number[] {
  const first = (c.releaseReason ?? "").split(/\.\s+(?=[A-Z])/)[0];
  const ob1 = [...first.matchAll(OB1_PR_RE)].flatMap((m) => [m[1], ...[...m[2].matchAll(/\d+/g)].map((x) => x[0])]).map(Number);
  if (ob1.length) return [...new Set(ob1)];
  const all = [...first.matchAll(PR_RE)].map((m) => Number(m[1]));
  return all.length ? [all[all.length - 1]] : [];
}

/** A PR's changed lines as a bucket. */
export function sizeBucket(lines: number | null): (typeof SIZE_BUCKETS)[number] {
  if (lines === null || !Number.isFinite(lines)) return "size unknown";
  return lines < 100 ? "under 100 lines" : lines < 500 ? "100 to 499 lines" : lines < 2000 ? "500 to 1,999 lines" : "2,000 lines or more";
}

export type Stats = { n: number; p25: number | null; median: number | null; p75: number | null; max: number | null };
/** Quartiles by linear interpolation between ranks (n − 1 spacing), so an even count's median is the middle two's mean. */
export function stats(values: number[]): Stats {
  const v = [...values].filter(Number.isFinite).sort((a, b) => a - b);
  const q = (p: number) => {
    if (!v.length) return null;
    const i = (v.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);
    return v[lo] + (v[hi] - v[lo]) * (i - lo);
  };
  return { n: v.length, p25: q(0.25), median: q(0.5), p75: q(0.75), max: v.length ? v[v.length - 1] : null };
}

export type Group = { key: string; hours: Stats; renewals: Stats; uncounted: number };
export type Report = {
  at: string; claims: number; byEnding: Record<Ending, number>;
  endings: Group[]; clients: Group[]; shapes: Group[]; sizes: Group[] | null;
  unreadSizes: number;
  /** Claims made after `at`, left out. */
  later: number;
};

/** Each claim's hours from claim to release (or, lapsed and never released, to its lease's end). */
const hoursOf = (c: ClaimRow) => (Date.parse(c.releasedAt ?? c.expiresAt) - Date.parse(c.claimedAt)) / 3_600_000;

function groupsOf(rows: ClaimRow[], keyOf: (c: ClaimRow) => string, order?: readonly string[]): Group[] {
  const by = new Map<string, ClaimRow[]>();
  for (const c of rows) { const k = keyOf(c); const g = by.get(k); if (g) g.push(c); else by.set(k, [c]); }
  const keys = order ? order.filter((k) => by.has(k)) : [...by.keys()].sort((a, b) => by.get(b)!.length - by.get(a)!.length || a.localeCompare(b));
  return keys.map((key) => {
    const cs = by.get(key)!;
    const counted = cs.filter((c) => c.renewals !== null).map((c) => c.renewals as number);
    return { key, hours: stats(cs.map(hoursOf)), renewals: stats(counted), uncounted: cs.length - counted.length };
  });
}

/** The report over `rows` at `now` (ms), sizes by PR number where given. */
export function report(all: ClaimRow[], now: number, sizes?: Record<string, { additions?: number; deletions?: number }>): Report {
  // As the brain stood at `now`: a claim not yet made left out, a release still to come not read.
  const rows = all.filter((c) => Date.parse(c.claimedAt) <= now)
    .map((c) => (c.releasedAt !== null && Date.parse(c.releasedAt) > now ? { ...c, releasedAt: null, releasedBy: null, releasedByKind: null, releaseReason: null } : c));
  const ended = rows.map((c) => ({ c, e: endingOf(c, now) }));
  const byEnding = Object.fromEntries(ENDINGS.map((e) => [e, ended.filter((x) => x.e === e).length])) as Record<Ending, number>;
  const timed = ended.filter((x) => x.e !== "live").map((x) => x.c);
  const endingKey = new Map(ended.map((x) => [x.c, x.e]));
  const merged = ended.filter((x) => x.e === "merged").map((x) => x.c);
  /** The changed lines of every PR the claim names, summed; null where any is not in --sizes with numeric additions and deletions. */
  const linesOf = (c: ClaimRow) => {
    const prs = prsOf(c);
    if (!prs.length || !sizes) return null;
    let sum = 0;
    for (const pr of prs) {
      const s = sizes[String(pr)];
      if (!s || typeof s.additions !== "number" || typeof s.deletions !== "number") return null;
      sum += s.additions + s.deletions;
    }
    return sum;
  };
  const lines = new Map(merged.map((c) => [c, linesOf(c)]));
  return {
    at: new Date(now).toISOString(), claims: rows.length, byEnding,
    endings: groupsOf(timed, (c) => endingKey.get(c)!, ENDINGS),
    clients: groupsOf(merged, clientOf),
    shapes: groupsOf(merged, (c) => (c.piece ? "one piece" : "whole ticket"), ["whole ticket", "one piece"]),
    sizes: sizes ? groupsOf(merged, (c) => sizeBucket(lines.get(c)!), SIZE_BUCKETS) : null,
    unreadSizes: sizes ? merged.filter((c) => lines.get(c) === null).length : 0,
    later: all.length - rows.length,
  };
}

const h = (v: number | null) => (v === null ? "—" : v < 0.995 ? v.toFixed(2) : v < 9.95 ? v.toFixed(1) : String(Math.round(v)));
const r1 = (v: number | null) => (v === null ? "—" : Number.isInteger(v) ? String(v) : v.toFixed(1));
function table(title: string, groups: Group[]): string[] {
  const head = `  ${"".padEnd(26)}${"claims".padStart(7)}${"p25 h".padStart(8)}${"median h".padStart(10)}${"p75 h".padStart(8)}${"max h".padStart(8)}${"renewals, median".padStart(18)}${"uncounted".padStart(11)}`;
  return [title, head, ...groups.map((g) =>
    `  ${g.key.slice(0, 25).padEnd(26)}${String(g.hours.n).padStart(7)}${h(g.hours.p25).padStart(8)}${h(g.hours.median).padStart(10)}${h(g.hours.p75).padStart(8)}${h(g.hours.max).padStart(8)}${(g.renewals.n ? `${r1(g.renewals.median)} (${g.renewals.n})` : "—").padStart(18)}${String(g.uncounted).padStart(11)}`)];
}

/** The report as the table it prints. */
export function render(rep: Report): string {
  const lines = [
    `Work claims, as of ${rep.at}: ${rep.claims} read, ${rep.byEnding.live} live (left out)${rep.later ? `, ${rep.later} made after it (left out)` : ""}.`,
    ...(rep.claims > 0 && rep.byEnding.live === rep.claims ? ["Every claim read is live: list_claims without include_ended lists live claims alone."] : []),
    "",
    ...table("By how each ended (hours from claim to release; lapsed, never released: to its lease's end):", rep.endings),
    "",
    ...table("Merged claims, by client (the label's first word before '@', else the key's name):", rep.clients),
    "",
    ...table("Merged claims, by shape:", rep.shapes),
  ];
  if (rep.sizes) lines.push("", ...table("Merged claims, by the PR's changed lines (--sizes):", rep.sizes), ...(rep.unreadSizes ? [`  ${rep.unreadSizes} merged claim(s) "size unknown": the reason names no PR, or --sizes has no additions and deletions for one it names.`] : []));
  lines.push("", ...NOT_SEEN);
  return lines.join("\n");
}

/** What the report cannot see, printed under its table and carried in --json. */
export const NOT_SEEN = [
  "Not seen here: a claim runs to its release, at its merge, so its hours hold the waits for review and for the word to merge,",
  "not work alone; a claim made late, just before its merge, reads short; a PR that closed two claims is counted under each;",
  "a renewal count says how often a claim was renewed, not when, and each client renews at its own pace, so counts compare",
  "within one client; a claim made before migration 152 is uncounted; a claim taken over hides the work done before its",
  "lapse; a claim board-sync closed is timed to that pass, not to its merge, and is left out of the merged tables.",
];

type Page = { claims: unknown[]; truncated?: unknown; remaining?: unknown };
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
/**
 * A list_claims page as a client saved it, unwrapped: the page itself (REST's body, or what a program reads), an MCP
 * tool result (its `structuredContent`, else its first text content as JSON), or a JSON-RPC answer (its `result`).
 */
function pageOf(v: unknown, depth = 0): Page | null {
  if (!isObject(v) || depth > 3) return null;
  if (Array.isArray(v.claims)) return v as Page;
  if (isObject(v.result)) return pageOf(v.result, depth + 1);
  if (isObject(v.structuredContent)) return pageOf(v.structuredContent, depth + 1);
  const text = Array.isArray(v.content) ? (v.content as { type?: unknown; text?: unknown }[]).find((c) => c?.type === "text" && typeof c.text === "string")?.text : undefined;
  if (typeof text === "string") { try { return pageOf(JSON.parse(text), depth + 1); } catch { return null; } }
  return null;
}
export type FromFile = { rows: ClaimRow[]; unread: number; warning: string | null };
/**
 * Claims from a --from file's text: an array of claims, a page, or an array of pages, a page as pageOf unwraps it;
 * null where it is none of them, "truncated" where the last page says more follow. A claim on two pages counts once.
 * Pages holding fewer claims than the first page counted (its claims and `remaining`) are warned of: a page missed.
 */
export function claimsFromText(text: string): FromFile | null | "truncated" {
  let v: unknown;
  try { v = JSON.parse(text); } catch { return null; }
  const one = pageOf(v);
  const many = Array.isArray(v) && v.length > 0 ? v.map((x) => pageOf(x)) : null;
  const pages = one ? [one] : many && many.every((p) => p !== null) ? (many as Page[]) : null;
  if (pages && pages[pages.length - 1].truncated === true) return "truncated";
  const list = pages ? pages.flatMap((p) => p.claims) : Array.isArray(v) ? v : null;
  if (!list) return null;
  const read = list.map(rowOf);
  const rows = [...new Map(read.filter((x): x is ClaimRow => x !== null).map((c) => [c.id, c])).values()];
  const first = pages?.[0];
  const promised = first && typeof first.remaining === "number" ? first.claims.length + first.remaining : null;
  const unread = read.filter((x) => x === null).length;
  const warnings = [
    // Every entry the pages hold, read or not: an unreadable one is counted apart, not as a page missing.
    promised !== null && rows.length + unread < promised ? `the pages hold ${rows.length + unread} entries where the first page counted ${promised}: a page is missing, or claims ended during the walk` : null,
    rows.length && !list.some((x) => isObject(x) && "renewals" in x) ? "no claim carries a renewal count (list_work_claims' own rows, or a brain before migration 152): every claim reads uncounted" : null,
  ].filter((w): w is string => w !== null);
  return { rows, unread, warning: warnings.length ? warnings.join("; ") : null };
}

/** --sizes as `gh pr list --json number,additions,deletions` prints it, or an object by number; null where it is neither. */
export function sizesOf(v: unknown): Record<string, { additions?: number; deletions?: number }> | null {
  if (Array.isArray(v)) {
    if (!v.every((x) => isObject(x) && typeof x.number === "number")) return null;
    return Object.fromEntries((v as { number: number; additions?: number; deletions?: number }[]).map((x) => [String(x.number), { additions: x.additions, deletions: x.deletions }]));
  }
  // An object by number: every key a PR number, every value an object (`gh pr view`'s one PR, or a claims page, is not).
  return isObject(v) && Object.entries(v).every(([k, x]) => /^\d+$/.test(k) && isObject(x)) ? (v as Record<string, { additions?: number; deletions?: number }>) : null;
}

export function selfCheck(): number {
  let pass = 0, fail = 0;
  const ok = (cond: boolean, msg: string) => { if (cond) pass++; else { fail++; } console.log(`  ${cond ? "✓" : "✗"}  ${msg}`); };
  const NOW = Date.parse("2026-11-23T12:00:00Z");
  const H = 3_600_000;
  const at = (hoursBefore: number) => new Date(NOW - hoursBefore * H).toISOString();
  const claim = (o: Partial<ClaimRow> & { id: string }): ClaimRow => ({
    issue: "SMD-1", piece: null, holder: "claude-code", holderKind: "agent", label: "claude-code@mac smd-1", claimedAt: at(10), renewedAt: null,
    expiresAt: at(-14), releasedAt: null, releasedBy: null, releasedByKind: null, releaseReason: null, renewals: 0, ...o,
  });
  console.log("claim-report.ts --self-check");

  // How each ended.
  const merged = claim({ id: "m", releasedAt: at(2), releasedBy: "claude-code", releaseReason: "Merged: OB1 PR 869 → main 3d32906b", renewals: 4 });
  const pieceMerged = claim({ id: "pm", piece: "PR 2b-2a", releasedAt: at(4), releasedBy: "claude-code", releaseReason: "SMD-3379 PR 2b-2a merged: OB1 PR 706 → main 05da5499", renewals: null });
  const closed = claim({ id: "c", releasedAt: at(1), releasedBy: "board-sync", releasedByKind: "ingested", releaseReason: "SMD-1 closed: Done (completed); db/sync-linear.ts@2026-11-23T11:00:00.000Z" });
  const taken = claim({ id: "t", releasedAt: at(3), releasedBy: "codex", releaseReason: "lapsed; taken over" });
  const forced = claim({ id: "f", releasedAt: at(5), releasedBy: "op", releasedByKind: "operator", releaseReason: "stuck" });
  const split = claim({ id: "s", releasedAt: at(9), releasedBy: "claude-code", releaseReason: "Split into PR 1 and PR 2: claiming the pieces" });
  const lapsed = claim({ id: "l", expiresAt: at(1) });
  const live = claim({ id: "v" });
  const e = (c: ClaimRow) => endingOf(c, NOW);
  ok(e(merged) === "merged" && e(pieceMerged) === "merged" && e(closed) === "closed by board-sync" && e(taken) === "taken over" && e(forced) === "force-released" && e(lapsed) === "lapsed, never released" && e(live) === "live",
    `each ending read from its release: merged (twice, a piece's too), closed by board-sync, taken over, force-released, lapsed never released, live (${[merged, pieceMerged, closed, taken, forced, lapsed, live].map(e).join(", ")})`);
  ok(e(split) === "released (other)", `a split's reason, naming its pieces "PR 1" and "PR 2" but no merge, reads as released (other) (${e(split)})`);
  const dropped = claim({ id: "d", releasedAt: at(1), releasedBy: "claude-code", releaseReason: "dropped: the user chose another fix" });
  const negated = ["Dropped, not merged: OB1 PR 870 closed", "never merged; dropped", "not yet merged; dropped", "wasn’t merged", "won't be merged: superseded",
    "has not been merged; dropped", "Never got merged", "PR closed without being merged"]
    .map((r, i) => e(claim({ id: `nm${i}`, releasedAt: at(1), releasedBy: "claude-code", releaseReason: r })));
  ok(e(dropped) === "released (other)" && negated.every((x) => x === "released (other)"), `a release naming no merge, or one its clause denies first ("not", "never", "yet", "n't", "be", "without"), reads as released (other) (${e(dropped)}; ${negated.join(", ")})`);
  const kept = ["Merged: OB1 PR 869; PR 2 not started", "the fix not split, merged as OB1 PR 9", "SMD-1 PR 1 merged: OB1 PR 776. PR 2 not yet merged"]
    .map((r, i) => e(claim({ id: `mk${i}`, releasedAt: at(1), releasedBy: "claude-code", releaseReason: r })));
  ok(kept.every((x) => x === "merged"), `a denial in another clause leaves a merge standing (${kept.join(", ")})`);
  // Board-sync by the server's own test: an operator's or a holder's reason worded alike is theirs.
  const opClosed = claim({ id: "oc", releasedAt: at(1), releasedBy: "op", releasedByKind: "operator", releaseReason: "SMD-1 closed: Done (completed); by hand" });
  const ownClosed = claim({ id: "hc", releasedAt: at(1), releasedBy: "claude-code", releasedByKind: "agent", releaseReason: "SMD-1 closed: Done (completed); merged as OB1 PR 9" });
  const otherTicket = claim({ id: "ot", releasedAt: at(1), releasedBy: "board-sync", releasedByKind: "ingested", releaseReason: "SMD-2 closed: Done (completed); db/sync-linear.ts@x" });
  ok(e(opClosed) === "force-released" && e(ownClosed) === "merged" && e(otherTicket) === "force-released",
    `board-sync only as the server reads it: an operator's (force-released), the holder's own (merged), another ticket's (force-released) (${[opClosed, ownClosed, otherTicket].map(e).join(", ")})`);
  ok(endingOf(claim({ id: "le", expiresAt: at(0) }), NOW) === "lapsed, never released", "a claim whose lease ends at the report's time has lapsed");
  const noReleaser = claim({ id: "nr", releasedAt: at(1), releasedBy: null, releaseReason: "Merged: OB1 PR 5" });
  const lapsedWords = claim({ id: "lw", releasedAt: at(1), releasedBy: "claude-code", releaseReason: "lapsed while the session was away; dropped" });
  ok(e(noReleaser) === "merged" && e(lapsedWords) === "released (other)",
    `a release naming no releaser is not a force, and only 115's exact reason is a takeover (${e(noReleaser)}, ${e(lapsedWords)})`);

  // The PRs, the client, the size.
  const pieceAfter = claim({ id: "pa", releasedAt: at(2), releasedBy: "claude-code", releaseReason: "Merged: OB1 PR 869 → main 3d32906b (SMD-4540 PR 1, the renewal counter)" });
  const bare = claim({ id: "b", releasedAt: at(2), releasedBy: "claude-code", releaseReason: "SMD-1 PR 2 merged as PR 412" });
  const three = claim({ id: "3", releaseReason: "Piece PR 2 done: 2a (OB1 PR 832), 2b (OB1 PR 847) and 2c (OB1 PR 865 -> 35b49c9b) merged" });
  const list = claim({ id: "li", releaseReason: "SMD-3668's three PRs merged: OB1 PR 705, PR 710 and PR 719 (main 410e28a0)" });
  const later = claim({ id: "la", releaseReason: "PR 3b-2 merged: OB1 PR 860 -> 7f8a1c4a. PR 3b is done: 3b-1 (OB1 PR 839), the measurement" });
  const twice = claim({ id: "tw", releaseReason: "Merged: OB1 PR 869 → main (OB1 PR 869's second commit)" });
  const prs = [merged, pieceMerged, pieceAfter, bare, closed, three, list, later, twice].map((c) => prsOf(c).join("+") || "none");
  ok(prs.join() === "869,706,869,412,none,832+847+865,705+710+719,860,869",
    `the PRs are the first sentence's "OB1 PR N" with any list after one, a piece's own name and a later sentence's PRs passed over, else its last "PR N" (${prs.join()})`);
  ok(clientOf(merged) === "claude-code" && clientOf(claim({ id: "x", label: "Codex@laptop codex/smd-1" })) === "codex" && clientOf(claim({ id: "y", label: null, holder: "runner-key" })) === "runner-key",
    "the client is the label's first word before '@', lower-cased, else the key's name");
  const buckets = [99, 100, 499, 500, 1999, 2000, null].map(sizeBucket);
  ok(buckets.join("|") === "under 100 lines|100 to 499 lines|100 to 499 lines|500 to 1,999 lines|500 to 1,999 lines|2,000 lines or more|size unknown",
    "sizes bucket at 100, 500 and 2,000 changed lines, unknown where unread");

  // The statistics: [10, 9, 1, 2] sorts differently as text.
  const s4 = stats([10, 9, 1, 2]);
  ok(s4.n === 4 && s4.median === 5.5 && s4.p25 === 1.75 && s4.p75 === 9.25 && s4.max === 10 && stats([]).median === null,
    `quartiles interpolate between ranks, sorted as numbers: [1,2,9,10] → 1.75, 5.5, 9.25, max 10; none → null (${JSON.stringify(s4)})`);

  // The report.
  const multi = claim({ id: "mu", piece: "PR 3", releasedAt: at(6), releasedBy: "claude-code", releaseReason: "PR 3 merged: OB1 PR 1 and PR 2" });
  const sizes = { "869": { additions: 500, deletions: 40 }, "1": { additions: 1500, deletions: 0 }, "2": { additions: 300, deletions: 200 } };
  const rep = report([merged, pieceMerged, multi, closed, taken, forced, split, dropped, lapsed, live], NOW, sizes);
  const halfSized = report([merged], NOW, { "869": { additions: 500 } });
  ok(halfSized.unreadSizes === 1 && halfSized.sizes?.map((g) => g.key).join() === "size unknown",
    `a size without its deletions reads unknown, counted as unread (${halfSized.unreadSizes})`);
  const listed = sizesOf([{ number: 869, additions: 500, deletions: 40 }]);
  ok(listed?.["869"]?.deletions === 40 && sizesOf({ "869": { additions: 1, deletions: 2 } }) !== null && sizesOf([{ additions: 1 }]) === null && sizesOf("x") === null
    && sizesOf({ additions: 540, deletions: 23, number: 869 }) === null && sizesOf({ claims: [] }) === null,
    "--sizes reads gh pr list's array by its numbers, or an object by number; a string, an array without numbers, gh pr view's one PR or a claims page is refused");
  const mergedGroup = rep.endings.find((g) => g.key === "merged");
  ok(rep.claims === 10 && rep.byEnding.live === 1 && rep.byEnding.merged === 3 && mergedGroup?.hours.n === 3 && mergedGroup.hours.median === 6 && mergedGroup.uncounted === 1 && mergedGroup.renewals.median === 2,
    `the endings' table: 10 claims, 1 live left out, 3 merged at a median 6 h, one of them uncounted, renewals median 2 of the two counted (${JSON.stringify(mergedGroup)})`);
  ok(!rep.endings.some((g) => g.key === "live") && rep.endings.find((g) => g.key === "lapsed, never released")?.hours.median === 9,
    "live claims are left out of every table, and a lapsed one is timed to its lease's end");
  ok(rep.shapes.map((g) => `${g.key}:${g.hours.n}`).join() === "whole ticket:1,one piece:2" && rep.clients[0].key === "claude-code" && rep.clients[0].hours.n === 3,
    `merged claims by shape and by client (${rep.shapes.map((g) => `${g.key}:${g.hours.n}`).join()}; ${rep.clients.map((g) => `${g.key}:${g.hours.n}`).join()})`);
  const bySize = rep.sizes?.map((g) => `${g.key}:${g.hours.n}`).join();
  ok(bySize === "500 to 1,999 lines:1,2,000 lines or more:1,size unknown:1" && rep.unreadSizes === 1,
    `by size: PR 869's 540 lines in 500 to 1,999, PRs 1 and 2 summed (1,500 + 500) in 2,000 or more, the one naming no PR --sizes holds unknown (${bySize})`);
  ok(/Every claim read is live/.test(render(report([live], NOW))) && !/Every claim read is live/.test(render(report([live, merged], NOW))),
    "a read of live claims alone says include_ended was likely left off");
  ok(report([merged], NOW).sizes === null && !render(report([merged], NOW)).includes("--sizes"), "without --sizes no size table is printed");
  const text = render(rep);
  ok(/^Work claims, as of 2026-11-23T12:00:00\.000Z: 10 read, 1 live \(left out\)\./.test(text) && /each client renews at its own pace/.test(text) && /the waits for review and for the word to merge/.test(text) && text.includes(NOT_SEEN.join("\n")) && /uncounted/.test(text),
    "the table says when, how many and what it cannot see");
  // Dated in the past: a claim made later is left out, a release still to come is not read.
  const past = report([merged, claim({ id: "new", claimedAt: at(-1), expiresAt: at(-20) })], NOW - 3 * H);
  ok(past.claims === 1 && past.later === 1 && past.byEnding.live === 1 && past.byEnding.merged === 0,
    `--now in the past: the claim made after it left out, the merge after it not yet read (${JSON.stringify(past.byEnding)}, ${past.later} later)`);
  ok(nowOf("2026-11-23T12:00:00Z") === NOW && nowOf("2026-11-23T07:00:00-05:00") === NOW && [nowOf("2026-11-23T12:00:00"), nowOf("1"), nowOf("Nov 23 2026")].every(Number.isNaN),
    "--now takes an ISO time with its zone, Z or an offset; one without a zone, or other text Date.parse takes, is refused");
  const edge = report([claim({ id: "made", claimedAt: at(0) }), claim({ id: "done", releasedAt: at(0), releasedBy: "claude-code", releaseReason: "Merged: OB1 PR 1" })], NOW);
  ok(edge.claims === 2 && edge.later === 0 && edge.byEnding.live === 1 && edge.byEnding.merged === 1,
    `a claim made, or released, at --now itself counts as made, or released (${JSON.stringify(edge.byEnding)})`);

  // The inputs.
  const camel = claimsFromText(JSON.stringify({ claims: [{ id: "a", issue: "SMD-2", piece: null, holder: "h", claimedAt: at(3), expiresAt: at(1), releasedAt: at(2), releaseReason: "Merged: OB1 PR 1", renewals: 2 }, { nope: true }] }));
  const snakeRow = { id: "b", issue: "SMD-3", piece: "PR 2", holder_name: "h", holder_kind: "agent", claimed_at: at(3), renewed_at: at(2.5), expires_at: at(1),
    released_at: at(2), released_by: "op", released_by_kind: "operator", release_reason: "Merged: OB1 PR 7", renewals: "5" };
  const snake = claimsFromText(JSON.stringify([snakeRow]));
  const sr = snake && snake !== "truncated" ? snake.rows[0] : null;
  ok(camel !== null && camel !== "truncated" && camel.rows.length === 1 && camel.unread === 1 && camel.rows[0].renewals === 2 && camel.rows[0].releaseReason === "Merged: OB1 PR 1",
    "a list_claims page reads, an entry it cannot read counted apart");
  ok(sr !== null && sr.holder === "h" && sr.holderKind === "agent" && sr.piece === "PR 2" && sr.renewedAt === at(2.5) && sr.releasedAt === at(2) && sr.releasedBy === "op" && sr.releasedByKind === "operator" && sr.releaseReason === "Merged: OB1 PR 7" && sr.renewals === 5 && endingOf(sr, NOW) === "force-released",
    `work_claims rows (snake_case, as --url reads them) read every field: holder, kind, piece, renewal, release, its releaser and reason, the count (${sr && endingOf(sr, NOW)})`);
  const page = (ids: string[], truncated: boolean) => ({ claims: ids.map((id) => ({ id, issue: "SMD-5", holder: "h", claimedAt: at(3), expiresAt: at(-1), renewals: 0 })), truncated });
  const walked = claimsFromText(JSON.stringify([page(["p1", "p2"], true), page(["p2", "p3"], false)]));
  ok(walked !== null && walked !== "truncated" && walked.rows.map((c) => c.id).join() === "p1,p2,p3" && claimsFromText(JSON.stringify(page(["p1"], true))) === "truncated" && claimsFromText(JSON.stringify([page(["p1"], false), page(["p2"], true)])) === "truncated",
    "pages walked to the end read as one list, a claim on two counted once; a last page saying more follow is refused");
  const pg = page(["w1", "w2"], false);
  const mcp = { content: [{ type: "text", text: JSON.stringify(pg) }], structuredContent: pg };
  const forms = [mcp, { content: [{ type: "text", text: "2 claims: …" }], structuredContent: pg }, { content: mcp.content }, { jsonrpc: "2.0", id: 1, result: mcp }, [mcp]].map((f) => {
    const got = claimsFromText(JSON.stringify(f));
    return got && got !== "truncated" ? got.rows.map((c) => c.id).join("+") : String(got);
  });
  ok(forms.every((f) => f === "w1+w2"), `an MCP tool result (structuredContent, or its text alone), a JSON-RPC answer and an array of results unwrap to their page (${forms.join(", ")})`);
  const gap = claimsFromText(JSON.stringify([{ ...page(["g1", "g2"], true), remaining: 4 }, page(["g5", "g6"], false)]));
  const whole = claimsFromText(JSON.stringify([{ ...page(["g1", "g2"], true), remaining: 2 }, page(["g3", "g4"], false)]));
  const junk = claimsFromText(JSON.stringify({ ...page(["j1"], false), claims: [...page(["j1"], false).claims, { junk: 1 }], remaining: 0 }));
  ok(gap !== null && gap !== "truncated" && /first page counted 6/.test(gap.warning ?? "") && whole !== null && whole !== "truncated" && whole.warning === null
    && junk !== null && junk !== "truncated" && junk.unread === 1 && junk.warning === null,
    `pages holding fewer entries than the first page counted are warned of; a whole walk, or one with an unreadable entry, is not (${gap && gap !== "truncated" ? gap.warning : gap})`);
  const noCount = claimsFromText(JSON.stringify([{ id: "n1", issue: "SMD-6", holder: "h", claimedAt: at(3), expiresAt: at(-1) }]));
  ok(noCount !== null && noCount !== "truncated" && /no claim carries a renewal count/.test(noCount.warning ?? ""),
    "claims with no renewals key at all (list_work_claims' own rows) are warned of as uncounted");
  ok(claimsFromText("not json") === null && claimsFromText(JSON.stringify({ claims: "x" })) === null && rowOf({ id: "z", issue: "SMD-4", holder: "h", claimedAt: at(1), expiresAt: at(0), renewals: -1 })?.renewals === null,
    "text that is not a claims list is refused, and a count below 0 reads uncounted");

  console.log(`${pass + fail} assertions: ${pass} passed, ${fail} failed`);
  return fail === 0 ? 0 : 1;
}

async function main(): Promise<number> {
  const cli = commandLine("claim-report.ts", { from: "one", url: "one", sizes: "one", now: "one", json: "none", "self-check": "none" }, {
    hints: { from: "<claims.json>", url: "<postgres://…>", sizes: "<sizes.json>", now: "<ISO time>" },
    note: "--from or --url; --self-check alone",
  });
  if (cli.has("self-check")) {
    if ((["from", "url", "sizes", "now", "json"] as const).some((f) => cli.has(f))) { console.error("claim-report.ts: --self-check takes no other flag"); return 2; }
    return selfCheck();
  }
  if (cli.has("from") === cli.has("url")) { console.error("claim-report.ts: give --from <claims.json> or --url <postgres://…>, one of the two"); return 2; }
  const nowText = cli.value("now");
  const now = nowText === undefined ? Date.now() : nowOf(nowText);
  if (!Number.isFinite(now)) { console.error("claim-report.ts: --now is an ISO time with its zone: 2026-11-23T12:00:00Z, or 2026-11-23T07:00:00-05:00"); return 2; }
  let sizes: Record<string, { additions?: number; deletions?: number }> | undefined;
  if (cli.has("sizes")) {
    let v: unknown;
    let text: string;
    try { text = readFileSync(cli.value("sizes")!, "utf8"); } catch (e) { console.error(`claim-report.ts: --sizes could not be read (${(e as NodeJS.ErrnoException).code ?? "unreadable"})`); return 2; }
    try { v = JSON.parse(text); } catch { console.error("claim-report.ts: --sizes is not JSON"); return 2; }
    const got = sizesOf(v);
    if (!got) { console.error("claim-report.ts: --sizes is `gh pr list --state merged --json number,additions,deletions` as it prints it, or an object of PRs by number: { \"869\": { \"additions\": 540, \"deletions\": 23 } }"); return 2; }
    sizes = got;
  }
  const print = (rows: ClaimRow[], unread: number, warning: string | null = null) => {
    if (!rows.length && unread) { console.error(`claim-report.ts: none of the ${unread} entries read as a claim: give list_claims' page (an MCP result's structuredContent or text, REST's body), its claims, or work_claims' rows`); return 2; }
    const rep = report(rows, now, sizes);
    console.log(cli.has("json") ? JSON.stringify({ ...rep, unreadClaims: unread, warning, notSeen: NOT_SEEN.join(" ") }, null, 2)
      : render(rep) + (unread ? `\n${unread} entr${unread === 1 ? "y" : "ies"} in --from read as no claim, left out.` : "") + (warning ? `\nWarning: ${warning}.` : ""));
    return 0;
  };
  if (cli.has("from")) {
    let text: string;
    try { text = readFileSync(cli.value("from")!, "utf8"); } catch (e) { console.error(`claim-report.ts: --from could not be read (${(e as NodeJS.ErrnoException).code ?? "unreadable"})`); return 2; }
    const got = claimsFromText(text);
    if (got === "truncated") { console.error("claim-report.ts: --from's last page says more claims follow (truncated): call list_claims again with `after` set to its cursor, to the end, and give the pages as one JSON array"); return 2; }
    if (!got) { console.error("claim-report.ts: --from is no claims list: a JSON array of claims, a page (an object with a `claims` array; an MCP tool result or JSON-RPC answer holding one), or an array of pages, as list_claims answers"); return 2; }
    return print(got.rows, got.unread, got.warning);
  }
  const sql = openSql(databaseUrl(cli.value("url")), { max: 1 });
  return closeThenExit(sql, async () => {
    let rows: Record<string, unknown>[];
    try {
      // Columns by name, so a role granted every column but token_hash reads them; renewals only where 152 made it.
      const [t] = await sql`SELECT to_regclass('work_claims') IS NOT NULL AS has_table,
        EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass('work_claims') AND attname = 'renewals' AND NOT attisdropped) AS has_count` as { has_table: boolean; has_count: boolean }[];
      if (!t.has_table) { console.error("claim-report.ts: this database has no work_claims: migration 115 is not applied"); return 2; }
      rows = t.has_count
        ? await sql`SELECT id::text, issue, piece, holder_name, holder_kind, label, claimed_at, renewed_at, expires_at,
                           released_at, released_by, released_by_kind, release_reason, renewals FROM work_claims`
        : await sql`SELECT id::text, issue, piece, holder_name, holder_kind, label, claimed_at, renewed_at, expires_at,
                           released_at, released_by, released_by_kind, release_reason, NULL::int AS renewals FROM work_claims`;
    } catch (e) {
      if (((e as { errno?: string }).errno ?? (e as { code?: string }).code) === "42501") { console.error("claim-report.ts: this role cannot read work_claims: grant it the claims group (bun migrate.ts --grant <role> --groups claims)"); return 2; }
      throw e;
    }
    const read = rows.map(rowOf);
    return print(read.filter((x): x is ClaimRow => x !== null), read.filter((x) => x === null).length);
  });
}

if (import.meta.main) process.exit(await main());
