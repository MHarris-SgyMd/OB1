#!/usr/bin/env bun
/**
 * board-replay.ts — a day's board, rebuilt from Linear's own history into a
 * throwaway brain, and the agenda asked as of that moment (SMD-3669 PR 3).
 *
 *   bun board-replay.ts --self-check
 *       The rollback rules against hand-made issues and histories in
 *       Linear's shape, the history fetch and the budget read against a stub
 *       of Linear, and the report on a stub agenda. No database, no Linear.
 *
 *   ../db/with-postgres.sh bun board-replay.ts --at 2026-11-02T14:11:00Z [--show SMD-2908,SMD-3602,SMD-1853]
 *       Reads every issue on the initiative's board from Linear now
 *       (LINEAR_API_KEY, as board-sync reads it), and undoes each issue's
 *       history after `--at`: its state, priority, due date, parent,
 *       project, labels, title and relations. An issue created after the
 *       moment is left out, as is one whose project then was not the
 *       initiative's. Plants the board into the throwaway database at
 *       DATABASE_URL (test-support's guards: refuseHeldDatabase, and
 *       resetSchema's loopback rule) by board-sync's own writers: each row
 *       with renderIssue's text and issueFacets' metadata, recordStructure
 *       for its source and links, board-sync declared a priority source by
 *       the operator and its own priority step stating the levels and due
 *       days. Work claims did not exist on every board a replay reads, so a
 *       ticket whose state then was started is claimed by another key, as
 *       today's rule has an agent claim at branch creation (the maintainer,
 *       2026-11-08). Then prints the agenda as of `--at`: its unstarted
 *       tickets in order, each with its terms, and for each `--show` key its
 *       state then and its place, or why it was left out.
 *
 * Nothing of the board is committed: the issues are read at run time. The
 * description cannot be rolled back (Linear's history says only that it
 * changed), so a row's text past its header is today's; the agenda reads
 * none of it. A trashed issue is not on today's census, so it is not
 * replayed; neither is one that has left the initiative since.
 */

import { SQL } from "bun";
import { createAssert, refuseHeldDatabase, resetSchema } from "../db/test-support.ts";
import { loadEnv, describeEnv } from "./env.ts";
import { linearClient, strict, type Gql } from "../db/linear-api.ts";
import { censusOf, fetchIssues, initiativeProjects, priorityStep, ACTOR_NAME as BOARD_SYNC, DEFAULT_INITIATIVE } from "../db/sync-linear.ts";
import { issueFacets, issueLinks, linearAdapter, renderIssue, type LinearIssue } from "../db/ingest-linear.ts";
import { recordStructure } from "../db/ingest-structure.ts";
import { SqlStore } from "../server-portable/store-sql.ts";
import type { AgendaItem, AgendaResult } from "../server-portable/store.ts";

// ── The rollback, pure ──────────────────────────────────────────────────────

/** One entry of an issue's Linear history, the fields the rollback reads. A field left null was not changed. */
export type HistoryEntry = {
  createdAt: string;
  fromState?: { name: string; type: string } | null; toState?: { name: string; type: string } | null;
  fromPriority?: number | null; toPriority?: number | null;
  fromDueDate?: string | null; toDueDate?: string | null;
  fromParent?: { identifier: string } | null; toParent?: { identifier: string } | null;
  fromProject?: { name: string } | null; toProject?: { name: string } | null;
  addedLabels?: { name: string }[] | null; removedLabels?: { name: string }[] | null;
  relationChanges?: { identifier: string; type: string }[] | null;
  fromTitle?: string | null; toTitle?: string | null;
};

/** Linear's priority numbers, as its `priorityLabel` names them. */
export const PRIORITY_LABELS = ["No priority", "Urgent", "High", "Medium", "Low"] as const;

/**
 * A relation-change code, as Linear's history writes it (read off the board's own history, 2026-11-08): an action
 * (`a` added, `r` removed) then a type, seen from this issue — `x` it blocks, `b` it is blocked by, `r` related,
 * `d` it duplicates, `m` it is duplicated by. `xr`/`br` and `xo`/`bo` are Linear's notes that a blocker was
 * resolved or reopened, not a change to the relation: in every case on the board the relation stood after them.
 */
export function relationCode(code: string): { action: "add" | "remove"; type: string } | "note" | null {
  if (/^[xb][ro]$/.test(code)) return "note";
  const m = /^([ar])([xbrdm])$/.exec(code);
  return m ? { action: m[1] === "a" ? "add" : "remove", type: m[2] } : null;
}

/** An issue's relations as a set of `type:identifier`, the types relationCode's, from Linear's two connections. */
export function relationSet(issue: Pick<LinearIssue, "relations" | "inverseRelations">): Set<string> {
  const held: Record<string, string> = { blocks: "x", related: "r", duplicate: "d" };
  const inverse: Record<string, string> = { blocks: "b", related: "r", duplicate: "m" };
  const out = new Set<string>();
  for (const r of issue.relations?.nodes ?? []) if (held[r.type] && r.relatedIssue) out.add(`${held[r.type]}:${r.relatedIssue.identifier}`);
  for (const r of issue.inverseRelations?.nodes ?? []) if (inverse[r.type] && r.issue) out.add(`${inverse[r.type]}:${r.issue.identifier}`);
  return out;
}

export class UnknownChange extends Error {}

/**
 * The issue as it stood at `at`, or null when it was created after: each history entry after `at` undone, newest
 * first. An unknown relation code throws, naming it: a replay that skipped it would plant a board that never was.
 */
export function issueAt(issue: LinearIssue, history: readonly HistoryEntry[], at: string): LinearIssue | null {
  const t = Date.parse(at);
  if (Date.parse(issue.createdAt) > t) return null;
  const was: LinearIssue = { ...issue, labels: { nodes: [...issue.labels.nodes] } };
  const rel = relationSet(issue);
  const labels = new Set(issue.labels.nodes.map((l) => l.name));
  for (const h of [...history].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))) {
    if (Date.parse(h.createdAt) <= t) break;
    if (h.fromState || h.toState) { if (!h.fromState) throw new UnknownChange(`${issue.identifier}: a state change at ${h.createdAt} names no state before it`); was.state = { name: h.fromState.name, type: h.fromState.type as LinearIssue["state"]["type"] }; }
    if ((h.toPriority ?? null) !== null && (h.fromPriority ?? null) === null) throw new UnknownChange(`${issue.identifier}: a priority change at ${h.createdAt} names no priority before it`);
    if (h.fromPriority !== null && h.fromPriority !== undefined) {
      const label = PRIORITY_LABELS[h.fromPriority];
      if (!label) throw new UnknownChange(`${issue.identifier}: priority ${h.fromPriority} at ${h.createdAt} is not one of Linear's`);
      was.priorityLabel = label;
    }
    if (h.fromDueDate !== undefined && h.toDueDate !== undefined && (h.fromDueDate !== null || h.toDueDate !== null)) was.dueDate = h.fromDueDate;
    if ((h.fromParent ?? null) !== null || (h.toParent ?? null) !== null) was.parent = h.fromParent ? { identifier: h.fromParent.identifier } : null;
    if ((h.fromProject ?? null) !== null || (h.toProject ?? null) !== null) was.project = h.fromProject ? { id: "", name: h.fromProject.name } : null;
    for (const l of h.addedLabels ?? []) labels.delete(l.name);
    for (const l of h.removedLabels ?? []) labels.add(l.name);
    if (h.fromTitle !== null && h.fromTitle !== undefined) was.title = h.fromTitle;
    for (const c of h.relationChanges ?? []) {
      const code = relationCode(c.type);
      if (code === null) throw new UnknownChange(`${issue.identifier}: relation change "${c.type}" with ${c.identifier} at ${h.createdAt} is no code this replay knows`);
      if (code === "note") continue;
      const key = `${code.type}:${c.identifier}`;
      if (code.action === "add") rel.delete(key); else rel.add(key);
    }
  }
  was.labels = { nodes: [...labels].sort().map((name) => ({ name })) };
  const node = (k: string) => k.slice(k.indexOf(":") + 1);
  const ofType = (t2: string) => [...rel].filter((k) => k.startsWith(`${t2}:`)).map(node).sort();
  was.relations = { nodes: [...ofType("x").map((id) => ({ type: "blocks", relatedIssue: { identifier: id } })), ...ofType("r").map((id) => ({ type: "related", relatedIssue: { identifier: id } })), ...ofType("d").map((id) => ({ type: "duplicate", relatedIssue: { identifier: id } }))] };
  was.inverseRelations = { nodes: [...ofType("b").map((id) => ({ type: "blocks", issue: { identifier: id } })), ...ofType("m").map((id) => ({ type: "duplicate", issue: { identifier: id } }))] };
  if (was.archivedAt && Date.parse(was.archivedAt) > t) was.archivedAt = null;
  if (Date.parse(was.updatedAt) > t) was.updatedAt = new Date(t).toISOString();
  return was;
}

/**
 * `--at` as an ISO instant: a day, a time to the minute or finer, and Z or an offset; refused when the day does not
 * exist (Date.parse rolls 02-30 over to 03-02) or the string is anything less (review pass 3: "1Z" read as 2001).
 */
export function instantOf(s: string): string | null {
  const m = /^(\d{4})-(\d\d)-(\d\d)T\d\d:\d\d(:\d\d(\.\d+)?)?(Z|[+-]\d\d:?\d\d)$/.exec(s);
  if (!m) return null;
  const day = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (day.getUTCFullYear() !== Number(m[1]) || day.getUTCMonth() !== Number(m[2]) - 1 || day.getUTCDate() !== Number(m[3])) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/** Who holds the stand-in claim on a ticket started at the moment: another agent's key, not the replay's own. */
export const REPLAY_CLAIMANT = "board-replay-other-agent";

// ── Linear ──────────────────────────────────────────────────────────────────

/**
 * The history a replay undoes: each issue's entries newest first, until one at or before `at` — the rollback stops
 * there, so older pages are never asked for. HISTORY_PAGE entries a page, HISTORY_BATCH issues a request: Linear
 * charges a connection by the page asked for, not the entries returned, refuses a query past 10,000 points, and
 * allows 3,000,000 an hour to the key board-sync shares (measured 2026-11-09: a hundred-entry page cost about 1,500 an
 * issue, and one such run over the board spent the hour's budget).
 */
const HISTORY_PAGE = 25;
const HISTORY_BATCH = 20;
const HISTORY_FIELDS = "createdAt fromState { name type } toState { name type } fromPriority toPriority fromDueDate toDueDate fromParent { identifier } toParent { identifier } fromProject { name } toProject { name } addedLabels { name } removedLabels { name } relationChanges { identifier type } fromTitle toTitle";
type HistoryPage = { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: HistoryEntry[] };

/** Linear's history order broken: the stop rule reads newest first, and a page out of order would stop it early, silently. */
export class HistoryOrder extends Error {}

export async function historiesOf(gql: Gql, identifiers: readonly string[], at: string): Promise<Map<string, HistoryEntry[]>> {
  const t = Date.parse(at);
  const out = new Map<string, HistoryEntry[]>(identifiers.map((id) => [id, []]));
  let pending: { id: string; after: string | null }[] = identifiers.map((id) => ({ id, after: null }));
  while (pending.length) {
    const next: typeof pending = [];
    for (let i = 0; i < pending.length; i += HISTORY_BATCH) {
      const batch = pending.slice(i, i + HISTORY_BATCH);
      const vars = Object.fromEntries(batch.flatMap((b, j) => [[`i${j}`, b.id], [`c${j}`, b.after]]));
      const q = `query(${batch.map((_, j) => `$i${j}: String!, $c${j}: String`).join(", ")}) { ${batch.map((_, j) => `a${j}: issue(id: $i${j}) { history(first: ${HISTORY_PAGE}, after: $c${j}) { pageInfo { hasNextPage endCursor } nodes { ${HISTORY_FIELDS} } } }`).join("\n")} }`;
      const d = await strict<Record<string, { history: HistoryPage }>>(gql, q, vars);
      batch.forEach((b, j) => {
        const page = d[`a${j}`].history;
        const had = out.get(b.id)!;
        const times = [...(had.length ? [had[had.length - 1].createdAt] : []), ...page.nodes.map((n) => n.createdAt)].map(Date.parse);
        if (times.some((x, k) => k > 0 && x > times[k - 1])) throw new HistoryOrder(`${b.id}'s history came back out of order (newest first expected): the replay stops paging at the moment, so it refuses rather than stop early`);
        had.push(...page.nodes);
        const reached = page.nodes.some((n) => Date.parse(n.createdAt) <= t);
        if (page.pageInfo.hasNextPage && !reached) next.push({ id: b.id, after: page.pageInfo.endCursor });
      });
    }
    pending = next;
  }
  return out;
}

// ── The replay ──────────────────────────────────────────────────────────────

const showTerms = (it: { terms: readonly { term: string; value: number }[] }) => it.terms.map((t) => `${t.term} ${t.value >= 0 ? "+" : ""}${t.value}`).join(", ");

/**
 * What Linear has left this hour for the key, read off a one-field query's headers through the shared client (its
 * auth rule, its redirect refusal and its HTTP messages; review pass 2: a hand copy sent a bare token and read a
 * missing header as 0). A replay below either floor refuses before it reads any history: the key is board-sync's too,
 * and a run cut short by a limit keeps nothing. A replay further back reads more history pages, so the points floor
 * is about twice the 11-02 run's ~470,000, not a bound.
 */
export const REPLAY_POINTS = 1_000_000;
export const REPLAY_REQUESTS = 300;
export type Budget = { points: number | null; requests: number | null; resetAt: string | null };
export async function budgetOf(key: string, fetchImpl: typeof fetch = fetch): Promise<Budget> {
  let headers: Headers | null = null;
  const probe = linearClient(key, (async (input: RequestInfo | URL, init?: RequestInit) => { const r = await fetchImpl(input, init); headers = r.headers; return r; }) as typeof fetch);
  let failure: Error | null = null;
  try { await strict(probe, "{ viewer { id } }"); } catch (e) { failure = e as Error; }
  const read = (name: string) => { const raw = (headers as Headers | null)?.get(name) ?? null; const n = raw === null || raw.trim() === "" ? NaN : Number(raw); return Number.isFinite(n) ? n : null; };
  const reset = read("x-ratelimit-complexity-reset");
  const b: Budget = { points: read("x-ratelimit-complexity-remaining"), requests: read("x-ratelimit-requests-remaining"), resetAt: reset === null ? null : new Date(reset).toISOString() };
  // A probe refused for the limit itself still carries the budget: said as a short one, with its reset (review pass 3).
  if (failure && !((b.points !== null && b.points < REPLAY_POINTS) || (b.requests !== null && b.requests < REPLAY_REQUESTS))) throw failure;
  return b;
}

/** Why a budget is too short to start a replay, or null when it is enough. Pure. */
export function budgetShort(b: Budget): string | null {
  const when = b.resetAt ? `; the hour resets at ${b.resetAt}` : "";
  if (b.points === null || b.requests === null) return `Linear's answer carried no ${b.points === null ? "complexity" : "request"} budget, so the replay cannot tell it will finish${when}`;
  if (b.points < REPLAY_POINTS) return `Linear has ${b.points.toLocaleString("en")} complexity points left this hour for this key, which board-sync shares; a replay waits for ${REPLAY_POINTS.toLocaleString("en")}${when}`;
  if (b.requests < REPLAY_REQUESTS) return `Linear has ${b.requests} requests left this hour for this key, which board-sync shares; a replay waits for ${REPLAY_REQUESTS}${when}`;
  return null;
}

/** A `--show` key's reasons the agenda left it out, read by the replay from the database: its live claims, its open blockers, its score. */
export type LeftOutWhy = { claimedBy: string[]; blockers: string[]; score: { effective: number; terms: { term: string; value: number }[] } | null };

export type ReportInput = {
  initiative: string; at: string; boardNow: number; then: readonly LinearIssue[]; stated: number; claimant: string;
  agenda: Pick<AgendaResult, "items" | "total" | "unknown" | "leftOut">; settled: readonly string[]; shows: readonly string[];
  leftOutWhy: ReadonlyMap<string, LeftOutWhy>;
};

/**
 * The report, pure (review pass 2: the logic where pass 1 found two bugs ran only against Linear): the board then,
 * the agenda's unstarted tickets in order, and each `--show` key's place or why it was left out.
 */
export function reportLines(r: ReportInput): string[] {
  const out: string[] = [];
  const stateOf = new Map(r.then.map((i) => [i.identifier, i] as const));
  const started = r.then.filter((i) => i.state.type === "started").length;
  // Unstarted: a candidate neither started nor settled as the brain reads settled (058, 105's duplicate among them).
  const unstarted = r.agenda.items.filter((it) => { const type = stateOf.get(it.key)?.state.type ?? ""; return it.kind === "ticket" && type !== "" && type !== "started" && !r.settled.includes(type); });
  const byType = r.then.reduce<Record<string, number>>((a, i) => ({ ...a, [i.state.type]: (a[i.state.type] ?? 0) + 1 }), {});
  out.push(`board replay: ${r.initiative} as of ${r.at} — ${r.then.length} issues then (${Object.entries(byType).map(([k, v]) => `${v} ${k}`).join(", ")}), of ${r.boardNow} on the board now`);
  out.push(`planted: ${r.stated} Linear levels stated by board-sync's priority step; ${started} started ticket(s) claimed by ${r.claimant}`);
  out.push(`the agenda then: ${r.agenda.total} startable and unclaimed, ${r.agenda.unknown} with no priority; left out ${r.agenda.leftOut.blocked} blocked, ${r.agenda.leftOut.claimed} claimed (a claimed ticket also blocked counts as blocked), ${r.agenda.leftOut.waiting} waiting`);
  out.push("", `Unstarted tickets, in the agenda's order (rank among them, the agenda's own rank):`);
  unstarted.slice(0, 15).forEach((it, i) => {
    const was = stateOf.get(it.key)!;
    out.push(`  ${String(i + 1).padStart(2)}. (${it.rank}) ${it.key} ${it.effective} — ${was.priorityLabel}, ${was.state.name}${was.dueDate ? `, due ${was.dueDate}` : ""}: ${showTerms(it)}`);
  });
  for (const k of r.shows) {
    out.push("");
    const was = stateOf.get(k);
    if (!was) { out.push(`${k}: not replayed — created after the moment, not then in one of today's initiative projects, or gone from today's board`); continue; }
    out.push(`${k}: ${was.priorityLabel}, ${was.state.name} (${was.state.type})${was.dueDate ? `, due ${was.dueDate}` : ", no due date"}${was.parent ? `, parent ${was.parent.identifier}` : ""}`);
    const listed = r.agenda.items.find((it) => it.key === k);
    if (listed) {
      const u = unstarted.findIndex((it) => it.key === k);
      const tied = r.agenda.items.filter((it) => it.effective === listed.effective);
      const ahead = tied.filter((it) => it.rank < listed.rank).length;
      // A tie that reaches the read's last item may run on past it (review pass 1: "tied with 72" was a floor).
      const more = tied[tied.length - 1] === r.agenda.items[r.agenda.items.length - 1] && r.agenda.total > r.agenda.items.length ? "at least " : "";
      out.push(`  listed: rank ${listed.rank} of ${r.agenda.total}${u >= 0 ? `, ${u + 1} among the unstarted` : ""}, effective ${listed.effective} (${showTerms(listed)})${tied.length > 1 ? `; tied with ${more}${tied.length - 1} at ${listed.effective}, ${ahead} of them ahead by the agenda's tie-break` : ""}`);
    } else if (r.settled.includes(was.state.type)) {
      out.push(`  not a candidate: settled then`);
    } else {
      const w = r.leftOutWhy.get(k);
      // Blocked first, as the agenda counts a ticket both blocked and claimed (review pass 3), and each reason said.
      const reasons = w ? [...(w.blockers.length ? [`blocked by ${w.blockers.join(", ")}`] : []), ...(w.claimedBy.length ? [`claimed by ${w.claimedBy.join(", ")}`] : [])] : [];
      const why = !w ? "not read" : reasons.length ? `left out: ${reasons.join(", and ")}` : `not in the agenda's first ${r.agenda.items.length}`;
      out.push(`  ${why}; effective ${w?.score?.effective ?? "?"} (${w?.score ? showTerms(w.score) : "not read"})`);
    }
  }
  return out;
}

async function replay(at: string, shows: readonly string[]): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error("DATABASE_URL is not set. Try: ../db/with-postgres.sh bun board-replay.ts --at <instant>"); process.exit(2); }
  const sources = loadEnv();
  const key = process.env.LINEAR_API_KEY?.trim();
  if (!key) { console.error(`LINEAR_API_KEY is not set, and no .env file supplied it. Read: ${describeEnv(sources)}`); process.exit(2); }
  const gql = linearClient(key);
  // The database first, then Linear's budget: a held database or a short hour refuses before any point is spent
  // (review pass 1: the guards ran after the reads).
  await refuseHeldDatabase(url, "board-replay.ts");
  await resetSchema(url, { dim: 1024, model: "board-replay" });
  let budget: Budget;
  try { budget = await budgetOf(key); } catch (e) { console.error(`Linear's budget could not be read: ${(e as Error).message}`); process.exit(2); }
  const short = budgetShort(budget);
  if (short) { console.error(`${short}. Try again then.`); process.exit(2); }

  const board = await initiativeProjects(gql, process.env.OB1_LINEAR_INITIATIVE?.trim() || DEFAULT_INITIATIVE);
  const census = await censusOf(gql, board.projects.map((p) => p.id));
  const { issues, failed } = await fetchIssues(gql, census.map((c) => c.identifier));
  if (failed.length) { console.error(`Linear did not return ${failed.length} issue(s): ${failed.slice(0, 5).map((f) => `${f.identifier} (${f.error})`).join("; ")}`); process.exit(1); }
  // An issue created after the moment is not replayed, so its history is never asked for.
  const histories = await historiesOf(gql, issues.filter((i) => Date.parse(i.createdAt) <= Date.parse(at)).map((i) => i.identifier), at);
  const projectId = new Map(board.projects.map((p) => [p.name, p.id] as const));
  const then: LinearIssue[] = [];
  for (const issue of issues) {
    const was = issueAt(issue, histories.get(issue.identifier) ?? [], at);
    if (!was || !was.project || !projectId.has(was.project.name)) continue;
    then.push({ ...was, project: { id: projectId.get(was.project.name)!, name: was.project.name } });
  }
  then.sort((a, b) => a.identifier.localeCompare(b.identifier, "en", { numeric: true }));

  const sql = new SQL({ url, max: 1 });
  const store = new SqlStore(url, { max: 1 });
  try {
    // The row as a raw insert under board-sync's actor (no embedding: the agenda reads none), then board-sync's own
    // structure writer and priority step.
    const run = `board-replay@${at}`;
    for (const issue of then) {
      await sql.begin(async (tx) => {
        await tx`SELECT set_config('ob1.actor', ${JSON.stringify({ name: BOARD_SYNC })}, true)`;
        const [row] = (await tx`INSERT INTO thoughts (content, content_fingerprint, metadata, created_at)
                               VALUES (${renderIssue(issue)}, content_fingerprint_of(${renderIssue(issue)}), (${JSON.stringify(issueFacets(issue))}::text)::jsonb, ${issue.createdAt}::timestamptz)
                               RETURNING id`) as { id: string }[];
        await recordStructure(tx, row.id, linearAdapter.map(issue), run, { take: true });
      });
    }
    const [declared] = (await sql`SELECT declare_priority_source(${BOARD_SYNC}, true) AS r`) as { r: { ok: boolean; error?: string } }[];
    if (!declared.r.ok) throw new Error(`declare_priority_source(${BOARD_SYNC}): ${declared.r.error}`);
    const step = await priorityStep(sql, { name: BOARD_SYNC });
    if (!("step" in step)) throw new Error(`board-sync's priority step is off: ${step.off}`);
    const tally = await step.step.run({ dryRun: false });
    if (tally.refused.length) throw new Error(`board-sync's priority step was refused: ${tally.refused.join(", ")}`);
    for (const issue of then.filter((i) => i.state.type === "started")) {
      const r = await store.claimWork({ issue: issue.identifier, label: "stand-in: started at the replayed moment", leaseSeconds: 86_400, actor: { name: REPLAY_CLAIMANT } });
      if (r.outcome !== "claimed") throw new Error(`claim_work(${issue.identifier}): ${r.outcome} ${r.code ?? ""}`);
    }

    const agenda = await store.agenda({ limit: 100, includeBlocked: false, includeClaimed: false, includeProposed: false, now: at });
    // Settled as the brain reads it, not a list kept here (review pass 1: a Duplicate was misreported).
    const settled = ((await sql`SELECT node_settled_types() AS t`)[0] as { t: string[] }).t;
    // A shown key not listed and not settled: its reasons read as the agenda reads them (the first 11-02 run's lookup
    // read only the agenda's first 100, and a left-out ticket fell past them).
    const leftOutWhy = new Map<string, LeftOutWhy>();
    const stateOf = new Map(then.map((i) => [i.identifier, i] as const));
    for (const k of shows) {
      const was = stateOf.get(k);
      if (!was || agenda.items.some((it) => it.key === k) || settled.includes(was.state.type)) continue;
      const [claims] = (await sql`SELECT COALESCE(array_agg(holder_name ORDER BY holder_name), '{}') AS holders FROM work_claims
                                   WHERE issue = ${k} AND released_at IS NULL AND expires_at > ${at}::timestamptz`) as { holders: string[] }[];
      const [blocked] = (await sql`SELECT ob1_item_blockers('ticket', ${k}) AS blockers`) as { blockers: string[] }[];
      const [score] = await store.effectivePriority([{ kind: "ticket", key: k }], { now: at });
      leftOutWhy.set(k, { claimedBy: claims.holders, blockers: blocked.blockers, score: score ? { effective: score.effective, terms: score.terms } : null });
    }
    for (const line of reportLines({ initiative: board.initiative, at, boardNow: issues.length, then, stated: tally.asserted, claimant: REPLAY_CLAIMANT, agenda, settled, shows, leftOutWhy })) console.log(line);
  } finally {
    await store.close();
    await sql.close();
  }
}

// ── The self-check ──────────────────────────────────────────────────────────

/** A history entry as Linear sends it: every field the replay asks for, null where nothing changed. */
const entry = (createdAt: string, changed: Partial<HistoryEntry> = {}): HistoryEntry => ({
  createdAt, fromState: null, toState: null, fromPriority: null, toPriority: null, fromDueDate: null, toDueDate: null, fromParent: null, toParent: null,
  fromProject: null, toProject: null, addedLabels: null, removedLabels: null, relationChanges: null, fromTitle: null, toTitle: null, ...changed,
});

async function selfCheck(): Promise<void> {
  const { assert: ok, report } = createAssert();
  const base: LinearIssue = {
    identifier: "ZQ-9", title: "Now", description: "", url: "https://linear.app/x/issue/ZQ-9", createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-11-07T00:00:00.000Z", archivedAt: "2026-11-07T00:00:00.000Z", priorityLabel: "Medium", dueDate: null,
    state: { name: "Done", type: "completed" }, project: { id: "p2", name: "Later project" }, parent: { identifier: "ZQ-1" },
    labels: { nodes: [{ name: "added-later" }] },
    relations: { nodes: [{ type: "blocks", relatedIssue: { identifier: "ZQ-5" } }, { type: "related", relatedIssue: { identifier: "ZQ-6" } }, { type: "duplicate", relatedIssue: { identifier: "ZQ-10" } }] },
    inverseRelations: { nodes: [{ type: "blocks", issue: { identifier: "ZQ-7" } }, { type: "related", issue: { identifier: "ZQ-11" } }, { type: "duplicate", issue: { identifier: "ZQ-12" } }] },
  };
  // Linear's shape: every field on every entry, null where it did not change (review pass 1: the first fixture left
  // them out, so the null-means-unchanged guards were never read). Newest first, as Linear sends it.
  const AT = "2026-11-02T12:00:00.000Z";
  const history: HistoryEntry[] = [
    entry("2026-11-07T00:00:00.000Z"),
    entry("2026-11-06T00:00:00.000Z", { fromState: { name: "Backlog", type: "backlog" }, toState: { name: "Done", type: "completed" } }),
    entry("2026-11-05T00:00:00.000Z", { fromPriority: 2, toPriority: 3, fromDueDate: "2026-11-03", toDueDate: null }),
    entry("2026-11-04T00:00:00.000Z", { fromParent: null, toParent: { identifier: "ZQ-1" }, fromProject: { name: "Early project" }, toProject: { name: "Later project" }, addedLabels: [{ name: "added-later" }], removedLabels: [{ name: "removed-later" }], fromTitle: "Then", toTitle: "Now" }),
    entry("2026-11-03T00:00:00.000Z", { relationChanges: [{ identifier: "ZQ-5", type: "ax" }, { identifier: "ZQ-8", type: "rx" }, { identifier: "ZQ-7", type: "br" }, { identifier: "ZQ-6", type: "ar" }] }),
    entry(AT, { fromPriority: 4, toPriority: 2 }),
    entry("2026-11-01T00:00:00.000Z", { fromPriority: 1, toPriority: 4 }),
  ];
  const was = issueAt(base, history, AT)!;
  ok(was.state.type === "backlog" && was.priorityLabel === "High" && was.dueDate === "2026-11-03", `state, priority and due date undone to the moment, an entry at the moment itself kept (${was.state.type}, ${was.priorityLabel}, ${was.dueDate})`);
  ok(was.parent === null && was.project?.name === "Early project" && was.title === "Then" && JSON.stringify(was.labels.nodes) === JSON.stringify([{ name: "removed-later" }]),
    `parent, project, title and labels undone (${JSON.stringify(was.parent)}, ${was.project?.name}, ${was.title}, ${JSON.stringify(was.labels.nodes)})`);
  const links = issueLinks(was).map((l) => `${l.relation} ${l.target}`).sort();
  ok(JSON.stringify(links) === JSON.stringify(["blocked_by ZQ-7", "blocks ZQ-8", "duplicate_of ZQ-10", "relates_to ZQ-11"]) && was.inverseRelations?.nodes.some((r) => r.type === "duplicate" && r.issue?.identifier === "ZQ-12") === true,
    `the links board-sync would record then: a later add removed, a later removal restored, a resolution note leaving its relation, an inverse related kept, a duplicate held and one inverse (which the adapter drops) (${links})`);
  ok(was.archivedAt === null && was.updatedAt === AT, "an archive after the moment undone; updatedAt no later than the moment");
  const still = issueAt(base, [entry("2026-11-07T00:00:00.000Z")], AT)!;
  ok(still.title === "Now" && still.priorityLabel === "Medium" && still.dueDate === null && still.parent?.identifier === "ZQ-1" && still.project?.name === "Later project" && still.state.type === "completed" && JSON.stringify(issueLinks(still)) === JSON.stringify(issueLinks(base)),
    "an entry with every field null, as Linear sends one that changed nothing the replay reads, leaves the issue as it is");
  ok(JSON.stringify(issueAt(base, [...history].reverse(), AT)) === JSON.stringify(was), "a history given oldest first undoes to the same issue");
  ok(issueAt(base, history, "2026-09-30T00:00:00Z") === null, "an issue created after the moment is not on the board");
  const atNow = issueAt(base, history, "2026-11-08T00:00:00Z")!;
  ok(atNow.state.type === "completed" && atNow.priorityLabel === "Medium" && atNow.title === "Now", "with no change after the moment the issue is today's");
  ok(issueAt(base, [entry("2026-11-05T00:00:00Z", { fromPriority: 0, toPriority: 2 })], "2026-11-02T00:00:00Z")!.priorityLabel === "No priority", "priority 0 is No priority, not a missing value");
  ok(issueAt(base, [entry("2026-11-05T00:00:00Z", { fromDueDate: null, toDueDate: "2026-11-09" })], "2026-11-02T00:00:00Z")!.dueDate === null, "a due date set after the moment is cleared");
  const refused = (h: HistoryEntry) => { try { issueAt(base, [h], "2026-11-02T00:00:00Z"); return ""; } catch (e) { return (e as Error).message; } };
  ok(/"zz"/.test(refused(entry("2026-11-05T00:00:00Z", { relationChanges: [{ identifier: "ZQ-2", type: "zz" }] }))), "an unknown relation code is refused by name, never skipped");
  ok(/no state before it/.test(refused(entry("2026-11-05T00:00:00Z", { toState: { name: "Done", type: "completed" } }))) && /no priority before it/.test(refused(entry("2026-11-05T00:00:00Z", { toPriority: 2 }))),
    "a state or priority change naming nothing before it is refused, never skipped");
  ok(JSON.stringify(["ab", "ad", "am", "ar", "ax", "rb", "rr", "rx"].map((c) => relationCode(c))) === JSON.stringify([
      { action: "add", type: "b" }, { action: "add", type: "d" }, { action: "add", type: "m" }, { action: "add", type: "r" }, { action: "add", type: "x" },
      { action: "remove", type: "b" }, { action: "remove", type: "r" }, { action: "remove", type: "x" }]) && ["xr", "br", "xo", "bo"].every((c) => relationCode(c) === "note"),
    "every code on the board reads: an action and a type, or a resolution note");

  // The fetch, against a stub of Linear: batches, a further page only while no entry has reached the moment, and the
  // order checked.
  const pages: Record<string, Record<string, HistoryPage>> = {};
  const page = (nodes: HistoryEntry[], next: string | null): HistoryPage => ({ pageInfo: { hasNextPage: next !== null, endCursor: next }, nodes });
  const ids = Array.from({ length: 21 }, (_, i) => `ZQ-${100 + i}`);
  for (const id of ids) pages[id] = { start: page([entry("2026-11-01T00:00:00.000Z")], null) };
  pages["ZQ-100"] = { start: page([entry("2026-11-05T00:00:00.000Z")], "p2"), p2: page([entry("2026-11-03T00:00:00.000Z"), entry("2026-11-01T00:00:00.000Z")], "p3"), p3: page([entry("2026-10-01T00:00:00.000Z")], null) };
  pages["ZQ-101"] = { start: page([entry("2026-11-04T00:00:00.000Z"), entry("2026-11-02T00:00:00.000Z")], "never") };
  const calls: number[] = [];
  const stub = (async (_q: string, vars?: Record<string, unknown>) => {
    const v = vars ?? {};
    const n = Object.keys(v).filter((k) => k.startsWith("i")).length;
    calls.push(n);
    const data = Object.fromEntries(Array.from({ length: n }, (_, j) => [`a${j}`, { history: pages[String(v[`i${j}`])][String(v[`c${j}`] ?? "start")] }]));
    return { data, errors: [] };
  }) as unknown as Gql;
  const got = await historiesOf(stub, ids, "2026-11-02T12:00:00.000Z");
  ok(JSON.stringify(calls) === JSON.stringify([20, 1, 1]) && got.get("ZQ-100")!.length === 3 && got.get("ZQ-101")!.length === 2,
    `history fetched ${HISTORY_BATCH} issues a request, a further page only for an issue whose page has not reached the moment, and none past it (${calls}; ${got.get("ZQ-100")!.length}, ${got.get("ZQ-101")!.length})`);
  pages["ZQ-120"] = { start: page([entry("2026-11-01T00:00:00.000Z"), entry("2026-11-05T00:00:00.000Z")], null) };
  let order = "";
  try { await historiesOf(stub, ["ZQ-120"], "2026-11-02T12:00:00.000Z"); } catch (e) { order = e instanceof HistoryOrder ? (e as Error).message : `other: ${(e as Error).message}`; }
  ok(/out of order/.test(order), `a page out of newest-first order is refused, as the stop rule reads it newest first (${order})`);
  // Review pass 2's gaps: the order across two pages, equal times allowed, and the moment itself kept for creation and archive.
  pages["ZQ-121"] = { start: page([entry("2026-11-06T00:00:00.000Z"), entry("2026-11-05T00:00:00.000Z")], "q2"), q2: page([entry("2026-11-07T00:00:00.000Z")], null) };
  let across = "";
  try { await historiesOf(stub, ["ZQ-121"], "2026-11-02T12:00:00.000Z"); } catch (e) { across = (e as Error).message; }
  pages["ZQ-122"] = { start: page([entry("2026-11-05T00:00:00.000Z"), entry("2026-11-05T00:00:00.000Z"), entry("2026-11-01T00:00:00.000Z")], null) };
  const equal = await historiesOf(stub, ["ZQ-122"], "2026-11-02T12:00:00.000Z");
  ok(/out of order/.test(across) && equal.get("ZQ-122")!.length === 3, "a second page newer than the first's last entry is refused; two entries at one time are not");
  ok(issueAt({ ...base, createdAt: AT }, [], AT) !== null && issueAt({ ...base, archivedAt: AT }, [], AT)!.archivedAt === AT,
    "an issue created at the moment is on the board, and one archived at the moment stays archived");

  // The budget: read through the shared client, a missing header unread (not 0), a refusal said with its status.
  const answer = (status: number, headers: Record<string, string>) => (async () => new Response(JSON.stringify({ data: { viewer: { id: "v" } } }), { status, headers })) as unknown as typeof fetch;
  const full = await budgetOf("lin_api_x", answer(200, { "x-ratelimit-complexity-remaining": "2999999", "x-ratelimit-requests-remaining": "2400", "x-ratelimit-complexity-reset": "1794195912579" }));
  const bare = await budgetOf("lin_api_x", answer(200, {}));
  let denied = "";
  try { await budgetOf("lin_api_x", answer(401, {})); } catch (e) { denied = (e as Error).message; }
  ok(full.points === 2999999 && full.requests === 2400 && full.resetAt === "2026-11-09T03:45:12.579Z" && bare.points === null && bare.requests === null && /401/.test(denied),
    `the budget read off Linear's headers, a missing one unread rather than 0, and a refusal named by its status (${JSON.stringify(full)}; ${JSON.stringify(bare)}; ${denied.slice(0, 60)})`);
  ok(budgetShort(full) === null && /no complexity budget/.test(budgetShort(bare) ?? "") && /waits for 1,000,000/.test(budgetShort({ ...full, points: 400_000 }) ?? "") && /requests left/.test(budgetShort({ ...full, requests: 50 }) ?? ""),
    "a replay starts with enough of both budgets, and refuses an unread one or a short one by name");

  // The report, on a stub agenda: the tie line, the unstarted list, and each --show branch.
  const t = (key: string, type: string, label = "Medium"): LinearIssue => ({ ...base, identifier: key, title: key, priorityLabel: label, dueDate: null, parent: null, state: { name: type, type: type as LinearIssue["state"]["type"] } });
  const it = (key: string, rank: number, effective: number) => ({ rank, kind: "ticket", key, effective, terms: [{ term: "level", value: effective, detail: {} }] }) as unknown as AgendaItem;
  const then = [t("ZQ-201", "backlog", "High"), t("ZQ-202", "backlog"), t("ZQ-203", "backlog"), t("ZQ-204", "started"), t("ZQ-205", "duplicate"), t("ZQ-206", "backlog")];
  const items = [it("ZQ-201", 1, 3), it("ZQ-202", 2, 2), it("ZQ-203", 3, 2)];
  const settledTypes = ["completed", "canceled", "duplicate"];
  const lines = (total: number, shows: string[], why = new Map<string, LeftOutWhy>()) => reportLines({ initiative: "Board", at: AT, boardNow: 7, then, stated: 5, claimant: REPLAY_CLAIMANT,
    agenda: { items, total, unknown: 0, leftOut: { blocked: 1, claimed: 1, waiting: 0 } }, settled: settledTypes, shows, leftOutWhy: why });
  const cut = lines(40, ["ZQ-202"]).join("\n"), whole = lines(3, ["ZQ-202"]).join("\n");
  ok(/tied with at least 1 at 2, 0 of them ahead/.test(cut) && /tied with 1 at 2, 0 of them ahead/.test(whole) && !/at least/.test(whole),
    "a tie reaching the read's last item says \"at least\" when more were listed past it, and not when the read holds them all");
  const listing = lines(3, []).join("\n");
  ok(/ 1\. \(1\) ZQ-201/.test(listing) && /1 started ticket\(s\) claimed/.test(listing) && /a claimed ticket also blocked counts as blocked/.test(listing),
    "the unstarted list and the claim count, the double-counting said");
  items.push(it("ZQ-204", 4, 2), it("ZQ-205", 5, 1));
  const kept = lines(5, []).join("\n");
  items.splice(3, 2);
  ok(!/ZQ-204/.test(kept) && !/ZQ-205/.test(kept), "a started or settled ticket on the agenda is not listed as unstarted");
  const why = new Map<string, LeftOutWhy>([["ZQ-206", { claimedBy: ["someone"], blockers: [], score: { effective: 2, terms: [{ term: "level", value: 2 }] } }]]);
  const shown = lines(3, ["ZQ-205", "ZQ-206", "ZQ-299"], why).join("\n");
  ok(/ZQ-205: Medium, duplicate \(duplicate\)[^\n]*\n  not a candidate: settled then/.test(shown) && /ZQ-206[^\n]*\n  left out: claimed by someone; effective 2 \(level \+2\)/.test(shown) && /ZQ-299: not replayed/.test(shown),
    "a --show key settled then (a Duplicate among them), one left out with its reason, and one not on the replayed board are each said as they are");
  const more = new Map<string, LeftOutWhy>([
    ["ZQ-206", { claimedBy: [], blockers: ["ZQ-1"], score: { effective: 2, terms: [{ term: "level", value: 2 }] } }],
    ["ZQ-207", { claimedBy: [], blockers: [], score: { effective: 1, terms: [{ term: "level", value: 1 }] } }],
    ["ZQ-208", { claimedBy: ["someone"], blockers: ["ZQ-1"], score: null }],
  ]);
  then.push(t("ZQ-207", "backlog"), t("ZQ-208", "started"));
  const other = lines(3, ["ZQ-206", "ZQ-207", "ZQ-208", "ZQ-203"], more).join("\n");
  then.splice(then.length - 2, 2);
  ok(/ZQ-206[^\n]*\n  left out: blocked by ZQ-1; effective 2/.test(other) && /ZQ-207[^\n]*\n  not in the agenda's first 3; effective 1/.test(other)
      && /ZQ-208[^\n]*\n  left out: blocked by ZQ-1, and claimed by someone; effective \? \(not read\)/.test(other) && /ZQ-203[^\n]*\n  listed: rank 3 of 3, 3 among the unstarted/.test(other),
    "a key left out as blocked, one past the read's first items, one both blocked and claimed (blocked first, as the agenda counts it), and a listed key's place among the unstarted");
  const many = Array.from({ length: 20 }, (_, i) => it(`ZQ-${300 + i}`, i + 1, 3));
  then.push(...many.map((m) => t(m.key, "backlog")));
  const sixteen = reportLines({ initiative: "Board", at: AT, boardNow: 30, then, stated: 0, claimant: REPLAY_CLAIMANT, agenda: { items: many, total: 20, unknown: 0, leftOut: { blocked: 0, claimed: 0, waiting: 0 } }, settled: settledTypes, shows: [], leftOutWhy: new Map() });
  then.splice(then.length - 20, 20);
  ok(sixteen.filter((l) => /^ +\d+\. \(\d+\) ZQ-3/.test(l)).length === 15 && sixteen.some((l) => /^ +15\. \(15\) ZQ-314 /.test(l)), "the unstarted list stops at fifteen");
  const limited = await budgetOf("lin_api_x", answer(400, { "x-ratelimit-complexity-remaining": "0", "x-ratelimit-requests-remaining": "2400", "x-ratelimit-complexity-reset": "1794195912579" }));
  ok(limited.points === 0 && /waits for 1,000,000; the hour resets at 2026-11-09T03:45:12.579Z/.test(budgetShort(limited) ?? ""), "a probe Linear refuses for the limit is said as a short budget, with when the hour resets");
  ok(instantOf("2026-11-02T14:11:00Z") === "2026-11-02T14:11:00.000Z" && instantOf("2026-11-02T14:11+01:00") === "2026-11-02T13:11:00.000Z"
      && ["2026-11-02", "2026-11-02Z", "1Z", "2026-02-30T00:00Z", "2026-11-02T14:11", "yesterday"].every((x) => instantOf(x) === null),
    "--at takes an instant to the minute with Z or an offset, and refuses a bare day, a year alone, a day that does not exist, or no zone");
  report();
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  if (args.includes("--self-check")) await selfCheck();
  const at = instantOf(flag("--at") ?? "");
  if (!at) { console.error("usage: bun board-replay.ts --self-check | --at <ISO instant: YYYY-MM-DDTHH:MM[:SS], then Z or an offset> [--show KEY,KEY]"); process.exit(2); }
  // A moment ahead of now would outlive the stand-in claims' one-day lease, and no board stood there yet.
  if (Date.parse(at) > Date.now()) { console.error(`--at ${at} is in the future: a replay reads a board that stood`); process.exit(2); }
  await replay(at, (flag("--show") ?? "").split(",").map((s) => s.trim()).filter(Boolean));
  process.exit(0);
}
