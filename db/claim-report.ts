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
 * array of claims, or an object with a `claims` array (one page), the server's
 * camelCase or work_claims' snake_case. A brain's claims reach it that way
 * through any client holding a read key, with no database credentials.
 * --url reads work_claims directly (SELECT on it, the `claims` group's). Give
 * one of the two.
 * --sizes reads a JSON object of merged PRs' sizes, by number:
 *   { "869": { "additions": 540, "deletions": 23, "commits": 6 } }
 * (`gh pr view N --json additions,deletions,commits` gives each). A merged
 * claim's PR is read from its release reason ("… PR 869 …").
 * --now dates the report (lapsed or live is read against it); unset, the clock.
 * --json prints the report's numbers instead of its table.
 *
 * How a claim ended (ENDINGS), read from its release:
 *   merged                 its holder released it saying "merged" (the claim
 *                          rule's "Merged: OB1 PR N → main <sha>")
 *   closed by board-sync   released as its ticket closed ("<ticket> closed: …")
 *   taken over             lapsed, and another claim on its work took it over
 *   force-released         another key released it (an operator's force)
 *   released (other)       its holder released it for another reason: a split
 *                          into pieces, a drop
 *   lapsed, never released past its lease, released by nobody (counted, not
 *                          timed: its lease's end is no end of its work)
 *   live                   neither (left out)
 * The durations by client, by shape and by size are of merged claims alone:
 * the claims whose work is known to have finished.
 *
 * What it cannot see, said under the table: a claim runs to its release, at its
 * merge, so its hours hold the waits for review and for the word to merge, not
 * work alone; a renewal count says how often a
 * claim was renewed, not when, and each client renews at its own pace (a Claude
 * Code agent at each commit, push and long test run, its session hook at
 * compactions and the session's end and, with the claims hook pasted, each
 * quarter of the lease; the agent runner when it publishes), so counts compare
 * within one client; a claim made before migration 152 is uncounted; a claim
 * taken over hides the work done before its lapse; a claim from before a week
 * lease at PR open ran under a shorter one.
 */
import { readFileSync } from "node:fs";
import { commandLine } from "./cli.ts";
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
/** 115's reason for a lapsed claim the next claim on its work closed. */
const TAKEN_OVER = "lapsed; taken over";
/** Board-sync's reason as it releases a closed ticket's claims (SMD-3600). */
const CLOSED_RE = /^[A-Z][A-Z0-9]*-\d+ closed: /i;
/**
 * A merge named in a release reason: "Merged: OB1 PR 869 → main …", "SMD-3379 PR 2b-2a merged: OB1 PR 706 …". The
 * word, not a PR's number: a split's reason names its pieces ("Split into PR 1 … and PR 2 …").
 */
const MERGED_RE = /\bmerged\b/i;
/** The repository's PR, as the claim rule writes it ("OB1 PR 869"), else any "PR N". */
const OB1_PR_RE = /\bOB1 PR (\d+)\b/;
const PR_RE = /\bPR (\d+)\b/g;
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
  if (CLOSED_RE.test(why)) return "closed by board-sync";
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
 * The merged PR's number: the one the reason writes "OB1 PR N", the claim rule's form; else the last "PR N" it names.
 * A piece's own name comes either side of it ("SMD-1723 PR 1 merged: OB1 PR 776", "OB1 PR 869 → main (SMD-4540 PR 1)").
 */
export function prOf(c: ClaimRow): number | null {
  const why = c.releaseReason ?? "";
  const ob1 = OB1_PR_RE.exec(why);
  if (ob1) return Number(ob1[1]);
  const all = [...why.matchAll(PR_RE)].map((m) => Number(m[1]));
  return all.length ? all[all.length - 1] : null;
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
};

/** Each claim's hours from claim to release (or, lapsed and never released, to its lease's end). */
const hoursOf = (c: ClaimRow) => (Date.parse(c.releasedAt ?? c.expiresAt) - Date.parse(c.claimedAt)) / 3_600_000;

function groupsOf(rows: ClaimRow[], keyOf: (c: ClaimRow) => string, order?: readonly string[]): Group[] {
  const by = new Map<string, ClaimRow[]>();
  for (const c of rows) { const k = keyOf(c); by.set(k, [...(by.get(k) ?? []), c]); }
  const keys = order ? order.filter((k) => by.has(k)) : [...by.keys()].sort((a, b) => by.get(b)!.length - by.get(a)!.length || a.localeCompare(b));
  return keys.map((key) => {
    const cs = by.get(key)!;
    const counted = cs.filter((c) => c.renewals !== null).map((c) => c.renewals as number);
    return { key, hours: stats(cs.map(hoursOf)), renewals: stats(counted), uncounted: cs.length - counted.length };
  });
}

/** The report over `rows` at `now` (ms), sizes by PR number where given. */
export function report(rows: ClaimRow[], now: number, sizes?: Record<string, { additions?: number; deletions?: number }>): Report {
  const ended = rows.map((c) => ({ c, e: endingOf(c, now) }));
  const byEnding = Object.fromEntries(ENDINGS.map((e) => [e, ended.filter((x) => x.e === e).length])) as Record<Ending, number>;
  const timed = ended.filter((x) => x.e !== "live").map((x) => x.c);
  const endingKey = new Map(ended.map((x) => [x.c.id, x.e]));
  const merged = ended.filter((x) => x.e === "merged").map((x) => x.c);
  const linesOf = (c: ClaimRow) => {
    const pr = prOf(c);
    const s = pr === null || !sizes ? undefined : sizes[String(pr)];
    return s && typeof s.additions === "number" && typeof s.deletions === "number" ? s.additions + s.deletions : null;
  };
  return {
    at: new Date(now).toISOString(), claims: rows.length, byEnding,
    endings: groupsOf(timed, (c) => endingKey.get(c.id)!, ENDINGS),
    clients: groupsOf(merged, clientOf),
    shapes: groupsOf(merged, (c) => (c.piece === null ? "whole ticket" : "one piece"), ["whole ticket", "one piece"]),
    sizes: sizes ? groupsOf(merged, (c) => sizeBucket(linesOf(c)), SIZE_BUCKETS) : null,
    unreadSizes: sizes ? merged.filter((c) => linesOf(c) === null).length : 0,
  };
}

const h = (v: number | null) => (v === null ? "—" : v < 10 ? v.toFixed(1) : String(Math.round(v)));
const r1 = (v: number | null) => (v === null ? "—" : Number.isInteger(v) ? String(v) : v.toFixed(1));
function table(title: string, groups: Group[]): string[] {
  const head = `  ${"".padEnd(26)}${"claims".padStart(7)}${"p25 h".padStart(8)}${"median h".padStart(10)}${"p75 h".padStart(8)}${"max h".padStart(8)}${"renewals, median".padStart(18)}${"uncounted".padStart(11)}`;
  return [title, head, ...groups.map((g) =>
    `  ${g.key.slice(0, 25).padEnd(26)}${String(g.hours.n).padStart(7)}${h(g.hours.p25).padStart(8)}${h(g.hours.median).padStart(10)}${h(g.hours.p75).padStart(8)}${h(g.hours.max).padStart(8)}${(g.renewals.n ? `${r1(g.renewals.median)} (${g.renewals.n})` : "—").padStart(18)}${String(g.uncounted).padStart(11)}`)];
}

/** The report as the table it prints. */
export function render(rep: Report): string {
  const lines = [
    `Work claims, as of ${rep.at}: ${rep.claims} read, ${rep.byEnding.live} live (left out).`,
    "",
    ...table("By how each ended (hours from claim to release; lapsed, never released: to its lease's end):", rep.endings),
    "",
    ...table("Merged claims, by client (the label's first word before '@', else the key's name):", rep.clients),
    "",
    ...table("Merged claims, by shape:", rep.shapes),
  ];
  if (rep.sizes) lines.push("", ...table("Merged claims, by the PR's changed lines (--sizes):", rep.sizes), ...(rep.unreadSizes ? [`  ${rep.unreadSizes} merged claim(s) name no PR --sizes holds: "size unknown".`] : []));
  lines.push("",
    "Not seen here: a claim runs to its release, at its merge, so its hours hold the waits for review and for the word to merge,",
    "not work alone; a renewal count says how often a claim was renewed, not when, and each client renews at its own pace, so",
    "counts compare within one client; a claim made before migration 152 is uncounted; a claim taken over hides the work done",
    "before its lapse; a claim made before the week lease at a PR's opening ran under a shorter lease.");
  return lines.join("\n");
}

/** Claims from a --from file's text: an array, or an object with a `claims` array; null where it is neither. */
export function claimsFromText(text: string): { rows: ClaimRow[]; unread: number } | null {
  let v: unknown;
  try { v = JSON.parse(text); } catch { return null; }
  const list = Array.isArray(v) ? v : v && typeof v === "object" && Array.isArray((v as { claims?: unknown }).claims) ? (v as { claims: unknown[] }).claims : null;
  if (!list) return null;
  const rows = list.map(rowOf);
  return { rows: rows.filter((x): x is ClaimRow => x !== null), unread: rows.filter((x) => x === null).length };
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
  const closed = claim({ id: "c", releasedAt: at(1), releasedBy: "board-sync", releaseReason: "SMD-1 closed: Done" });
  const taken = claim({ id: "t", releasedAt: at(3), releasedBy: "codex", releaseReason: "lapsed; taken over" });
  const forced = claim({ id: "f", releasedAt: at(5), releasedBy: "op", releaseReason: "stuck" });
  const split = claim({ id: "s", releasedAt: at(9), releasedBy: "claude-code", releaseReason: "Split into PR 1 and PR 2: claiming the pieces" });
  const lapsed = claim({ id: "l", expiresAt: at(1) });
  const live = claim({ id: "v" });
  const e = (c: ClaimRow) => endingOf(c, NOW);
  ok(e(merged) === "merged" && e(pieceMerged) === "merged" && e(closed) === "closed by board-sync" && e(taken) === "taken over" && e(forced) === "force-released" && e(lapsed) === "lapsed, never released" && e(live) === "live",
    `each ending read from its release: merged (twice, a piece's too), closed by board-sync, taken over, force-released, lapsed never released, live (${[merged, pieceMerged, closed, taken, forced, lapsed, live].map(e).join(", ")})`);
  ok(e(split) === "released (other)", `a split's reason, naming its pieces "PR 1" and "PR 2" but no merge, reads as released (other) (${e(split)})`);
  const dropped = claim({ id: "d", releasedAt: at(1), releasedBy: "claude-code", releaseReason: "dropped: the user chose another fix" });
  ok(e(dropped) === "released (other)", `a release naming no PR and no merge reads as released (other) (${e(dropped)})`);

  // The PR, the client, the size.
  const pieceAfter = claim({ id: "pa", releasedAt: at(2), releasedBy: "claude-code", releaseReason: "Merged: OB1 PR 869 → main 3d32906b (SMD-4540 PR 1, the renewal counter)" });
  const bare = claim({ id: "b", releasedAt: at(2), releasedBy: "claude-code", releaseReason: "SMD-1 merged as PR 412" });
  ok(prOf(merged) === 869 && prOf(pieceMerged) === 706 && prOf(pieceAfter) === 869 && prOf(bare) === 412 && prOf(closed) === null,
    `the PR is the reason's "OB1 PR N", a piece's own name before or after it passed over, else its last "PR N" (${[merged, pieceMerged, pieceAfter, bare, closed].map(prOf).join(", ")})`);
  ok(clientOf(merged) === "claude-code" && clientOf(claim({ id: "x", label: "Codex@laptop codex/smd-1" })) === "codex" && clientOf(claim({ id: "y", label: null, holder: "runner-key" })) === "runner-key",
    "the client is the label's first word before '@', lower-cased, else the key's name");
  ok(sizeBucket(99) === "under 100 lines" && sizeBucket(100) === "100 to 499 lines" && sizeBucket(1999) === "500 to 1,999 lines" && sizeBucket(2000) === "2,000 lines or more" && sizeBucket(null) === "size unknown",
    "sizes bucket at 100, 500 and 2,000 changed lines, unknown where unread");

  // The statistics.
  const s4 = stats([4, 1, 3, 2]);
  ok(s4.n === 4 && s4.median === 2.5 && s4.p25 === 1.75 && s4.p75 === 3.25 && s4.max === 4 && stats([]).median === null,
    `quartiles interpolate between ranks: [1,2,3,4] → 1.75, 2.5, 3.25, max 4; none → null (${JSON.stringify(s4)})`);

  // The report.
  const rep = report([merged, pieceMerged, closed, taken, forced, split, dropped, lapsed, live], NOW, { "869": { additions: 500, deletions: 40 } });
  const mergedGroup = rep.endings.find((g) => g.key === "merged");
  ok(rep.claims === 9 && rep.byEnding.live === 1 && rep.byEnding.merged === 2 && mergedGroup?.hours.n === 2 && mergedGroup.hours.median === 7 && mergedGroup.uncounted === 1 && mergedGroup.renewals.median === 4,
    `the endings' table: 9 claims, 1 live left out, 2 merged at a median 7 h, one of them uncounted, renewals median 4 of the one counted (${JSON.stringify(mergedGroup)})`);
  ok(!rep.endings.some((g) => g.key === "live") && rep.endings.find((g) => g.key === "lapsed, never released")?.hours.median === 9,
    "live claims are left out of every table, and a lapsed one is timed to its lease's end");
  ok(rep.shapes.map((g) => `${g.key}:${g.hours.n}`).join() === "whole ticket:1,one piece:1" && rep.clients[0].key === "claude-code" && rep.clients[0].hours.n === 2,
    `merged claims by shape and by client (${rep.shapes.map((g) => `${g.key}:${g.hours.n}`).join()}; ${rep.clients.map((g) => `${g.key}:${g.hours.n}`).join()})`);
  ok(rep.sizes?.find((g) => g.key === "500 to 1,999 lines")?.hours.n === 1 && rep.sizes?.find((g) => g.key === "size unknown")?.hours.n === 1 && rep.unreadSizes === 1,
    `by size: PR 869's 540 lines in 500 to 1,999, the one naming no PR --sizes holds unknown (${JSON.stringify(rep.sizes?.map((g) => [g.key, g.hours.n]))})`);
  ok(report([merged], NOW).sizes === null && !render(report([merged], NOW)).includes("--sizes"), "without --sizes no size table is printed");
  const text = render(rep);
  ok(/^Work claims, as of 2026-11-23T12:00:00\.000Z: 9 read, 1 live \(left out\)\./.test(text) && /each client renews at its own pace/.test(text) && /the waits for review and for the word to merge/.test(text) && /uncounted/.test(text),
    "the table says when, how many and what it cannot see");

  // The inputs.
  const camel = claimsFromText(JSON.stringify({ claims: [{ id: "a", issue: "SMD-2", piece: null, holder: "h", claimedAt: at(3), expiresAt: at(1), releasedAt: at(2), releaseReason: "Merged: OB1 PR 1", renewals: 2 }, { nope: true }] }));
  const snake = claimsFromText(JSON.stringify([{ id: "b", issue: "SMD-3", holder_name: "h", claimed_at: at(3), expires_at: at(1), released_at: null, renewals: "5" }]));
  ok(camel?.rows.length === 1 && camel.unread === 1 && camel.rows[0].renewals === 2 && snake?.rows[0].holder === "h" && snake.rows[0].renewals === 5 && snake.rows[0].releasedAt === null,
    "a list_claims page (camelCase, an entry it cannot read counted apart) and work_claims rows (snake_case) read alike");
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
    if (["from", "url", "sizes", "now", "json"].some((f) => cli.has(f as "from"))) { console.error("claim-report.ts: --self-check takes no other flag"); return 2; }
    return selfCheck();
  }
  if (cli.has("from") === cli.has("url")) { console.error("claim-report.ts: give --from <claims.json> or --url <postgres://…>, one of the two"); return 2; }
  const now = cli.has("now") ? Date.parse(cli.value("now")!) : Date.now();
  if (!Number.isFinite(now)) { console.error("claim-report.ts: --now is no time this script can read (an ISO time, 2026-11-23T12:00:00Z)"); return 2; }
  let sizes: Record<string, { additions?: number; deletions?: number }> | undefined;
  if (cli.has("sizes")) {
    let v: unknown;
    try { v = JSON.parse(readFileSync(cli.value("sizes")!, "utf8")); } catch (e) { console.error(`claim-report.ts: --sizes could not be read as JSON (${(e as NodeJS.ErrnoException).code ?? "not JSON"})`); return 2; }
    if (!v || typeof v !== "object" || Array.isArray(v)) { console.error("claim-report.ts: --sizes is an object of PRs by number: { \"869\": { \"additions\": 540, \"deletions\": 23 } }"); return 2; }
    sizes = v as typeof sizes;
  }
  const print = (rows: ClaimRow[], unread: number) => {
    const rep = report(rows, now, sizes);
    console.log(cli.has("json") ? JSON.stringify({ ...rep, unreadClaims: unread }, null, 2) : render(rep) + (unread ? `\n${unread} entr${unread === 1 ? "y" : "ies"} in --from read as no claim, left out.` : ""));
    return 0;
  };
  if (cli.has("from")) {
    let text: string;
    try { text = readFileSync(cli.value("from")!, "utf8"); } catch (e) { console.error(`claim-report.ts: --from could not be read (${(e as NodeJS.ErrnoException).code ?? "unreadable"})`); return 2; }
    const got = claimsFromText(text);
    if (!got) { console.error("claim-report.ts: --from is no claims list: a JSON array of claims, or an object with a `claims` array, as list_claims answers"); return 2; }
    return print(got.rows, got.unread);
  }
  const sql = openSql(databaseUrl(cli.value("url")), { max: 1 });
  return closeThenExit(sql, async () => {
    // The count through the row's jsonb: null on a brain before migration 152 (store-sql.ts's rule).
    const rows = await sql`
      SELECT id::text, issue, piece, holder_name, holder_kind, label, claimed_at, renewed_at, expires_at,
             released_at, released_by, released_by_kind, release_reason, (to_jsonb(c) ->> 'renewals')::int AS renewals
        FROM work_claims c` as Record<string, unknown>[];
    const read = rows.map(rowOf);
    return print(read.filter((x): x is ClaimRow => x !== null), read.filter((x) => x === null).length);
  });
}

if (import.meta.main) process.exit(await main());
