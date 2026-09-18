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
 * by the tool that wrote the action row:
 *
 *   cited  — a write that names the id as a source: `capture_thought` with
 *            `derived_from` (025) or `supersedes`, one row per id named. This is
 *            the MERIT "memory utilization" signal: the fact reached a write.
 *   opened — `fetch`, `update_thought`, `delete_thought`: the caller went and
 *            looked at, or touched, the row. Click-through relevance (SMD-1295).
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

export type SearchRow = {
  id: string;
  agentId: string | null;
  loggedAt: Date | string;
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
  tool: string;
  targetId: string;
};

/** A write that names the id as a source — the fact reached a write. */
export const CITE_TOOLS: ReadonlySet<string> = new Set(["capture_thought"]);
/** The caller opened or touched the row — click-through relevance (034). */
export const OPEN_TOOLS: ReadonlySet<string> = new Set(["fetch", "update_thought", "delete_thought"]);

export type Uses = { used: Set<string>; cited: Set<string>; opened: Set<string> };

export type Attribution = {
  /** search id → the ids of its results the caller used, split by how. */
  bySearch: Map<string, Uses>;
  /** Action rows that matched no search (no prior search by that agent, in the window, returning the id). */
  unattributed: ActionRow[];
};

const ms = (t: Date | string): number => (t instanceof Date ? t.getTime() : new Date(t).getTime());

/**
 * Each action → the most recent prior search by the same agent (NULL agent is
 * its own bucket), within `windowMinutes` before the action, whose result_ids
 * contain the target. The export's join, in TypeScript so it is testable
 * without a database and so the report and the fixture agree by construction.
 */
export function attribute(searches: SearchRow[], actions: ActionRow[], windowMinutes: number): Attribution {
  const bySearch = new Map<string, Uses>();
  const unattributed: ActionRow[] = [];
  const windowMs = windowMinutes * 60_000;
  // Newest first, so the first match in scan order is the most recent prior search.
  const ordered = [...searches].sort((a, b) => ms(b.loggedAt) - ms(a.loggedAt));
  for (const act of actions) {
    const at = ms(act.loggedAt);
    const hit = ordered.find(
      (s) =>
        s.agentId === act.agentId &&
        ms(s.loggedAt) <= at &&
        ms(s.loggedAt) >= at - windowMs &&
        s.resultIds.includes(act.targetId),
    );
    if (!hit) {
      unattributed.push(act);
      continue;
    }
    const uses = bySearch.get(hit.id) ?? { used: new Set(), cited: new Set(), opened: new Set() };
    uses.used.add(act.targetId);
    if (CITE_TOOLS.has(act.tool)) uses.cited.add(act.targetId);
    else if (OPEN_TOOLS.has(act.tool)) uses.opened.add(act.targetId);
    else uses.opened.add(act.targetId); // an unknown tool still touched the id; counted as opened, never dropped
    bySearch.set(hit.id, uses);
  }
  return { bySearch, unattributed };
}

/** The arm a search row ran under: the tool and the arguments the log recorded. */
export function armOf(s: SearchRow): string {
  const k = s.matchCount ?? "?";
  const thr = s.threshold ?? "?";
  const rw = s.recencyWeight ?? "?";
  return `${s.tool} k=${k} thr=${thr} rw=${rw}`;
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
  const { bySearch, unattributed } = attribute(searches, actions, windowMinutes);
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
    for (const st of [overall, armSt, agSt]) {
      st.searches++;
      st.returned += s.resultIds.length;
      st.used += used;
      st.cited += uses?.cited.size ?? 0;
      st.opened += uses?.opened.size ?? 0;
      if (used > 0) st.searchesUsed++;
      if (typeof s.resultTokens === "number" && Number.isFinite(s.resultTokens)) {
        st.tokensReturned += s.resultTokens;
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
    if (typeof s.resultTokens === "number" && Number.isFinite(s.resultTokens)) {
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
  return { overall, arms, agents, actionsTotal: actions.length, unattributed: unattributed.length, windowMinutes };
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
    `${label.slice(0, 44).padEnd(44)} ${String(st.searches).padStart(8)} ${String(st.returned).padStart(8)} ${String(st.used).padStart(5)} ${pct(st.utilization)} ${pct(st.useRate).padStart(8)} ${String(st.cited).padStart(5)} ${String(st.opened).padStart(6)} ${num(st.tokensPerUsed).padStart(8)}` +
    (st.gold ? ` ${String(st.gold.withGold).padStart(5)} ${pct(st.gold.ignoreRate).padStart(7)}` : "");
  lines.push(`window ${sum.windowMinutes} min; ${sum.actionsTotal} action row(s), ${sum.unattributed} attributed to no search`);
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
    "util = ids used / ids returned (MERIT's memory utilization); use-rate = searches with ≥1 use; cited = ids a write named as a source; opened = ids fetched, edited or deleted;",
    "tok/used = approx. tokens returned per id used, over searches with an estimate (content as stored now, chars/4). Attribution: same agent, most recent prior search in the window that returned the id.",
  );
  if (sum.overall.gold) lines.push("gold = searches whose results held a hand-labelled relevant id; ignored = of those, the share where none was used (MERIT's ignore rate).");
  return lines.join("\n");
}
