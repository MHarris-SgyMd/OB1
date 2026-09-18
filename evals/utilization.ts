/**
 * utilization.ts — the pure part of the memory-utilization report (SMD-1719):
 * given the query log's rows, which returned ids did the caller go on to USE?
 *
 * Every retrieval number in evals/ asks whether the right rows came back. MERIT
 * (arXiv 2609.05441) measured the next layer — whether a retrieved fact changed
 * what the agent did — and found agents ignore 45–53% of correctly retrieved
 * facts. This module computes that layer from the opt-in query log (migration
 * 034): a search row per call with the ids it returned, and an action row per
 * follow-up touch of an id by the same agent. Two kinds of touch are told apart
 * by the `tool` that wrote the action row:
 *
 *   cited  — the tool is `<writer>/<pointer>`: a write named the id as its source
 *            and the database accepted the pointer — `capture_thought/derived_from`,
 *            `capture_thought/supersedes`, `update_thought/supersedes` today; a new
 *            writer that cites names itself the same way and is counted here
 *            without a change. This is MERIT's "memory utilization" signal: the
 *            fact reached a write.
 *   opened — a plain tool name — `fetch`, `update_thought`, `delete_thought`: the
 *            caller went and looked at, or touched, the row. Click-through
 *            relevance (SMD-1295).
 *
 * Attribution is the export's rule (evals/export-queries.ts), unchanged: an
 * action belongs to the MOST RECENT prior search by the same agent, within the
 * window, whose result set contained the id. A NULL agent is its own bucket. The
 * log carries no request token, so this is the only join there is (FORK.md
 * change 65).
 *
 * What is reported, per arm (the search tool and its arguments) and overall:
 *   searches, ids returned, ids used (cited ∪ opened, distinct per search),
 *   utilization = used / returned, use rate = searches with ≥ 1 use / searches,
 *   the cited and opened splits, and — when the search rows carry a token
 *   estimate for what they returned — tokens per used id, MERIT's cost-adjusted
 *   utility in this fork's units. With a gold map (query text → relevant ids,
 *   from a hand-labelled fixture), the ignore rate: searches whose results held
 *   a gold id the caller never used.
 *
 * What it refuses to pretend: with no action rows at all the report says so
 * ("n/a") instead of printing 0% over an empty join, and actions that attribute
 * to no search are counted and shown, not dropped.
 *
 * Pure: no database, no I/O. eval-utilization.ts reads the log and calls this;
 * db/test-schema.ts drives it over fixtures.
 */

import { parsePgUuidArray } from "./query-log.ts";

export type SearchRow = {
  id: string;
  agentId: string | null;
  loggedAt: Date | string;
  /**
   * `logged_at` in microseconds since the epoch, when the reader has it. The
   * SQL join compares timestamptz at microsecond grain; a JS Date is
   * milliseconds, so two rows under 1 ms apart would order differently in the
   * two. eval-utilization.ts reads this from the log; a fixture may omit it.
   */
  atUs?: number;
  tool: string;
  query: string | null;
  matchCount: number | null;
  threshold: number | null;
  recencyWeight: number | null;
  resultIds: string[];
  /** Approximate tokens of the content returned (chars / 4 over the ids as stored now); null when unknown. */
  resultTokens?: number | null;
};

export type ActionRow = {
  agentId: string | null;
  loggedAt: Date | string;
  /** As on SearchRow. */
  atUs?: number;
  tool: string;
  targetId: string;
};

/**
 * The shape eval-utilization.ts's SELECT hands back, one row per search. Kept
 * as a type here so the coercion below is testable without a database.
 */
export type SearchDbRow = {
  id: string;
  agent_id: string | null;
  logged_at: Date | string;
  at_us: string | number | bigint;
  tool: string;
  query: string | null;
  match_count: number | null;
  threshold: number | null;
  recency_weight: number | null;
  /** uuid[] as the driver returns it: an array, or the `{a,b}` literal. */
  result_ids: unknown;
  /** sum(length(content)) over the returned ids still stored — bigint, so possibly a string. */
  chars: string | number | bigint | null;
  /** count of the returned ids still stored. */
  surviving: string | number | bigint;
  /** cardinality(result_ids). */
  returned_n: string | number | bigint;
};

export type ActionDbRow = {
  agent_id: string | null;
  logged_at: Date | string;
  at_us: string | number | bigint;
  tool: string;
  target_id: string;
};

/**
 * A search row from the database → a SearchRow. The token estimate is whole or
 * absent: chars/4 when every returned id is still stored, null when any has
 * since been deleted (a partial sum would read as a cheaper search than it was)
 * or when nothing was returned. bigint columns arrive as strings under Bun.
 */
export function toSearchRow(r: SearchDbRow): SearchRow {
  const surviving = Number(r.surviving);
  const returned = Number(r.returned_n);
  const whole = r.chars !== null && returned > 0 && surviving === returned;
  return {
    id: r.id,
    agentId: r.agent_id,
    loggedAt: r.logged_at,
    atUs: Number(r.at_us),
    tool: r.tool,
    query: r.query,
    matchCount: r.match_count,
    threshold: r.threshold,
    recencyWeight: r.recency_weight,
    resultIds: parsePgUuidArray(r.result_ids),
    resultTokens: whole ? Math.round(Number(r.chars) / 4) : null,
  };
}

export function toActionRow(r: ActionDbRow): ActionRow {
  return { agentId: r.agent_id, loggedAt: r.logged_at, atUs: Number(r.at_us), tool: r.tool, targetId: r.target_id };
}

/**
 * A gold map from a fixture in export-queries.ts's shape: query text → the ids
 * a hand-labelled set calls relevant. `relevant` is an array in a fresh export
 * and may be the `{a,b}` literal in a re-serialised one; both read.
 */
export function goldFromFixture(fx: { queries?: { query: string; relevant: unknown }[] }): Map<string, Set<string>> {
  const gold = new Map<string, Set<string>>();
  for (const q of fx.queries ?? []) gold.set(q.query, new Set(parsePgUuidArray(q.relevant)));
  return gold;
}

/**
 * The plain tool names the server logs as an open — click-through relevance
 * (034). Any plain tool name is COUNTED as opened (never dropped); one outside
 * this set is also reported as unknown, so a new writer that forgot the
 * `<writer>/<pointer>` convention, or a renamed tool, is seen rather than
 * silently folded into "opened".
 */
export const OPEN_TOOLS: ReadonlySet<string> = new Set(["fetch", "update_thought", "delete_thought"]);

/** `<writer>/<pointer>` → the pointer the write set (`derived_from`, `supersedes`); null for a plain (opened) tool. */
export function citePointerOf(tool: string): string | null {
  const i = tool.indexOf("/");
  return i > 0 && i < tool.length - 1 ? tool.slice(i + 1) : null;
}

export type Uses = { used: Set<string>; cited: Set<string>; opened: Set<string> };

export type Attribution = {
  /** search id → the ids of its results the caller used, split by how. */
  bySearch: Map<string, Uses>;
  /** Action rows that matched no search (no prior search by that agent, in the window, returning the id). */
  unattributed: ActionRow[];
  /** Plain tool names seen that are not in OPEN_TOOLS — counted as opened, reported as unknown. */
  unknownTools: Map<string, number>;
};

/**
 * A row's instant in microseconds: `atUs` when the reader supplied it (the
 * log's own grain), else the Date's milliseconds × 1000. The SQL join orders
 * and bounds at microsecond grain, so the report matches it exactly when read
 * from the log; a fixture in whole seconds or minutes is unaffected.
 */
const tick = (r: { loggedAt: Date | string; atUs?: number }): number =>
  typeof r.atUs === "number" && Number.isFinite(r.atUs) ? r.atUs : (r.loggedAt instanceof Date ? r.loggedAt.getTime() : new Date(r.loggedAt).getTime()) * 1000;

/**
 * Each action → the most recent prior search by the same agent (NULL agent is
 * its own bucket), within `windowMinutes` before the action, whose result_ids
 * contain the target. The export's join, in TypeScript so it is testable
 * without a database and so the report and the fixture agree by construction.
 *
 * Searches are grouped by agent and sorted newest first with their times parsed
 * once, so each action scans only its own agent's searches and stops at the
 * window's edge — a 30-day log attributes in milliseconds, not by re-parsing
 * every timestamp per action.
 */
export function attribute(searches: SearchRow[], actions: ActionRow[], windowMinutes: number): Attribution {
  const bySearch = new Map<string, Uses>();
  const unattributed: ActionRow[] = [];
  const unknownTools = new Map<string, number>();
  const windowUs = windowMinutes * 60_000_000;

  const byAgent = new Map<string | null, { s: SearchRow; at: number; ids: Set<string> }[]>();
  for (const s of searches) {
    const list = byAgent.get(s.agentId) ?? [];
    list.push({ s, at: tick(s), ids: new Set(s.resultIds) });
    byAgent.set(s.agentId, list);
  }
  for (const list of byAgent.values()) list.sort((a, b) => b.at - a.at); // newest first

  for (const act of actions) {
    if (citePointerOf(act.tool) === null && !OPEN_TOOLS.has(act.tool)) unknownTools.set(act.tool, (unknownTools.get(act.tool) ?? 0) + 1);
    const at = tick(act);
    let hit: SearchRow | undefined;
    for (const c of byAgent.get(act.agentId) ?? []) {
      if (c.at > at) continue; // a later search cannot have produced this touch
      if (c.at < at - windowUs) break; // sorted newest first: everything after this is older still
      if (c.ids.has(act.targetId)) {
        hit = c.s;
        break;
      }
    }
    if (!hit) {
      unattributed.push(act);
      continue;
    }
    const uses = bySearch.get(hit.id) ?? { used: new Set(), cited: new Set(), opened: new Set() };
    uses.used.add(act.targetId);
    if (citePointerOf(act.tool) !== null) uses.cited.add(act.targetId);
    else uses.opened.add(act.targetId); // any plain tool, known or not, touched the id; counted as opened, never dropped
    bySearch.set(hit.id, uses);
  }
  return { bySearch, unattributed, unknownTools };
}

/** A `real` column decoded to a double carries float32 noise (0.3 → 0.30000001192092896); six significant digits is the column's own precision. */
const fmt = (x: number | null): string => (x === null ? "?" : String(Number(x.toPrecision(6))));

/** The arm a search row ran under: the tool and the arguments the log recorded. */
export function armOf(s: SearchRow): string {
  return `${s.tool} k=${s.matchCount ?? "?"} thr=${fmt(s.threshold)} rw=${fmt(s.recencyWeight)}`;
}

export type ArmStats = {
  searches: number;
  returned: number;
  used: number;
  cited: number;
  opened: number;
  searchesUsed: number;
  /** used / returned; null when nothing was returned. */
  utilization: number | null;
  /** searchesUsed / searches; null when no searches. */
  useRate: number | null;
  tokensReturned: number;
  /** Searches that carried a token estimate — the denominator tokensPerUsed is honest over. */
  searchesWithTokens: number;
  /** tokens returned (over searches that carry an estimate) / ids used in those searches; null when no use or no estimate. */
  tokensPerUsed: number | null;
  /** Only with a gold map: searches whose results held a gold id, and how many of those used none of them. */
  gold: { withGold: number; ignored: number; ignoreRate: number | null } | null;
};

export type Summary = {
  overall: ArmStats;
  arms: Map<string, ArmStats>;
  agents: Map<string, ArmStats>;
  actionsTotal: number;
  unattributed: number;
  /** Plain tool names outside OPEN_TOOLS, with counts — counted as opened, flagged in the report. */
  unknownTools: Map<string, number>;
  windowMinutes: number;
};

function emptyStats(withGold: boolean): ArmStats {
  return {
    searches: 0, returned: 0, used: 0, cited: 0, opened: 0, searchesUsed: 0,
    utilization: null, useRate: null, tokensReturned: 0, searchesWithTokens: 0, tokensPerUsed: null,
    gold: withGold ? { withGold: 0, ignored: 0, ignoreRate: null } : null,
  };
}

function finish(st: ArmStats, usedWithTokens: number): ArmStats {
  st.utilization = st.returned > 0 ? st.used / st.returned : null;
  st.useRate = st.searches > 0 ? st.searchesUsed / st.searches : null;
  st.tokensPerUsed = st.searchesWithTokens > 0 && usedWithTokens > 0 ? st.tokensReturned / usedWithTokens : null;
  if (st.gold) st.gold.ignoreRate = st.gold.withGold > 0 ? st.gold.ignored / st.gold.withGold : null;
  return st;
}

/**
 * Roll the attribution up per arm, per agent and overall. `gold` maps a query's
 * text to the ids a hand-labelled fixture calls relevant; when given, the ignore
 * rate is computed over searches whose results contained at least one gold id.
 */
export function summarise(
  searches: SearchRow[],
  actions: ActionRow[],
  windowMinutes: number,
  gold?: Map<string, Set<string>>,
): Summary {
  const { bySearch, unattributed, unknownTools } = attribute(searches, actions, windowMinutes);
  const withGold = gold !== undefined;
  const overall = emptyStats(withGold);
  const arms = new Map<string, ArmStats>();
  const agents = new Map<string, ArmStats>();
  const usedWithTokens = { overall: 0, arms: new Map<string, number>(), agents: new Map<string, number>() };

  for (const s of searches) {
    const uses = bySearch.get(s.id);
    const used = uses?.used.size ?? 0;
    const arm = armOf(s);
    const agent = s.agentId ?? "(anonymous)";
    const armSt = arms.get(arm) ?? emptyStats(withGold);
    const agSt = agents.get(agent) ?? emptyStats(withGold);
    const hasTokens = typeof s.resultTokens === "number" && Number.isFinite(s.resultTokens);
    for (const st of [overall, armSt, agSt]) {
      st.searches++;
      st.returned += s.resultIds.length;
      st.used += used;
      st.cited += uses?.cited.size ?? 0;
      st.opened += uses?.opened.size ?? 0;
      if (used > 0) st.searchesUsed++;
      if (hasTokens) {
        st.tokensReturned += s.resultTokens as number;
        st.searchesWithTokens++;
      }
      if (st.gold && gold && s.query !== null) {
        const g = gold.get(s.query);
        if (g && s.resultIds.some((id) => g.has(id))) {
          st.gold.withGold++;
          if (!s.resultIds.some((id) => g.has(id) && uses?.used.has(id))) st.gold.ignored++;
        }
      }
    }
    if (hasTokens) {
      usedWithTokens.overall += used;
      usedWithTokens.arms.set(arm, (usedWithTokens.arms.get(arm) ?? 0) + used);
      usedWithTokens.agents.set(agent, (usedWithTokens.agents.get(agent) ?? 0) + used);
    }
    arms.set(arm, armSt);
    agents.set(agent, agSt);
  }

  finish(overall, usedWithTokens.overall);
  for (const [k, st] of arms) finish(st, usedWithTokens.arms.get(k) ?? 0);
  for (const [k, st] of agents) finish(st, usedWithTokens.agents.get(k) ?? 0);
  return { overall, arms, agents, actionsTotal: actions.length, unattributed: unattributed.length, unknownTools, windowMinutes };
}

const pct = (x: number | null): string => (x === null ? "  n/a" : `${(100 * x).toFixed(0).padStart(3)}%`);
const num = (x: number | null, digits = 0): string => (x === null ? "n/a" : x.toFixed(digits));

/** The report as text. Says "n/a" where a number would be a lie. */
export function renderReport(sum: Summary): string {
  const lines: string[] = [];
  if (sum.actionsTotal === 0) {
    lines.push(
      `utilization: n/a — the log holds ${sum.overall.searches} search row(s) and NO action rows.`,
      `  Is OB1_QUERY_LOG=on, and has anyone cited (capture_thought with derived_from) or opened (fetch) a returned id?`,
    );
    return lines.join("\n");
  }
  const head = `${"arm".padEnd(44)} ${"searches".padStart(8)} ${"returned".padStart(8)} ${"used".padStart(5)} ${"util".padStart(5)} ${"use-rate".padStart(8)} ${"cited".padStart(5)} ${"opened".padStart(6)} ${"tok/used".padStart(8)}${sum.overall.gold ? ` ${"gold".padStart(5)} ${"ignored".padStart(7)}` : ""}`;
  const row = (label: string, st: ArmStats): string =>
    `${label.slice(0, 44).padEnd(44)} ${String(st.searches).padStart(8)} ${String(st.returned).padStart(8)} ${String(st.used).padStart(5)} ${pct(st.utilization).padStart(5)} ${pct(st.useRate).padStart(8)} ${String(st.cited).padStart(5)} ${String(st.opened).padStart(6)} ${num(st.tokensPerUsed).padStart(8)}` +
    (st.gold ? ` ${String(st.gold.withGold).padStart(5)} ${pct(st.gold.ignoreRate).padStart(7)}` : "");
  lines.push(`window ${sum.windowMinutes} min; ${sum.actionsTotal} action row(s), ${sum.unattributed} attributed to no search; token estimate for ${sum.overall.searchesWithTokens} of ${sum.overall.searches} search(es) (a search with a since-deleted result carries none)`);
  if (sum.unknownTools.size > 0) {
    lines.push(`  WARN ${[...sum.unknownTools].map(([t, n]) => `${t} ×${n}`).join(", ")}: plain tool name(s) outside {${[...OPEN_TOOLS].join(", ")}} — counted as opened; a writer that cites must log <writer>/<pointer>`);
  }
  lines.push(head);
  lines.push("─".repeat(head.length));
  for (const [arm, st] of [...sum.arms.entries()].sort((a, b) => b[1].searches - a[1].searches)) lines.push(row(arm, st));
  lines.push(row("all", sum.overall));
  if (sum.agents.size > 1) {
    lines.push("", "by agent");
    for (const [ag, st] of [...sum.agents.entries()].sort((a, b) => b[1].searches - a[1].searches)) lines.push(row(ag, st));
  }
  lines.push(
    "",
    "util = ids used / ids returned (MERIT's memory utilization); use-rate = searches with ≥1 use; cited = ids a write named as a source (tool <writer>/<pointer>); opened = ids fetched, edited or deleted;",
    "tok/used = approx. tokens returned per id used, over searches with an estimate (content as stored now, chars/4). Attribution: same agent, most recent prior search in the window that returned the id.",
  );
  if (sum.overall.gold) lines.push("gold = searches whose results held a hand-labelled relevant id; ignored = of those, the share where none was used (MERIT's ignore rate).");
  return lines.join("\n");
}
