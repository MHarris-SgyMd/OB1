// plan_context (SMD-2684): what the brain holds for a request, in one read, so a client starting work judges whether it
// can and plans with it. Not a planner: no model call, no verdict. Sections, each present or said not available:
//   knowledge   search_thoughts' hybrid arm with prefer_current, each hit labelled as search_thoughts labels it;
//   board       the tickets those hits name, in one agenda call (migration 126's keys scope: the maintainer's choice,
//               2026-11-09, so one ranking serves both reads), and the named ones it does not list — settled or of an
//               unknown status type, not yet startable, or unknown to the brain — so each named ticket is said once;
//   specs       not available: SMD-2683 (a spec record) has not landed; deliverables (SMD-1715) are recorded, and read
//               through deliverable_history, not here;
//   procedures  not available: SMD-1721 has not landed;
//   tools       what this key's scope may call here, core and plugin, and that other servers' tools are unknown to it;
//   gaps        what it could not find, as values: no hit at all, every hit superseded or ingested, a named ticket the
//               brain does not hold, tickets past the board's reach, semantic search unavailable, a board not read.
// Bounded: one deadline, held by the two calls that wait on something else — the query's embedding (the provider),
// stopped early enough to leave the board its reserve, and the board's agenda call (its statement timeout, what is
// left). An embedding past its stop answers by exact matches alone, as a provider that did not answer does; a board
// past the deadline, or failing, is a gap. The search's own SQL and the labels run under the database's statement
// timeout, as every read does.
// Logged as one query_log row of its own kind (126): the request, the hits' ids, the board's tickets, why it was not read.

import type { Principal } from "../auth.ts";
import type { AgendaItem, AgendaOther, AgendaWaiting, ThoughtHybridMatch } from "../store.ts";
import { TOOLS, unlocks, visibleToolNames, type ToolScope } from "../tools.ts";
import type { Ctx } from "./context.ts";
import { loadPlugins } from "./plugins.ts";
import { labelHits, runSearch, ticketsNamedBy, type QueryVectorFailed, type SearchHit } from "./reads.ts";
import { ok, refuse, type Outcome, type Refusal } from "./refusal.ts";
import type { Input } from "./schemas.ts";

/** The read's deadline, in ms: the query's embedding and the board's agenda call. */
export const PLAN_DEADLINE_MS = 10_000;
/**
 * What the embedding leaves the board: it is stopped this long before the deadline, or at half of it, whichever is
 * later (review pass 2: a provider slow but alive took the whole deadline, and the board, which needs no provider,
 * was never read).
 */
export const BOARD_RESERVE_MS = 2_000;
/** The board's reach: the agenda's own ceiling of 500 keys (126). Named tickets past it are counted, not read. */
export const BOARD_KEYS = 500;
/** The board's list: the agenda's ceiling of 100 items. Open named tickets past it are counted, not read. */
export const BOARD_LIMIT = 100;

/**
 * The reply's budget (SMD-4191: one canary answer ran to 63,108 characters for 8 hits): about 15,500 characters for that
 * answer's shape at the default 8 hits, 17,200 with claims and every hit's topics; every list capped by count and every
 * item by length, so a reply is bounded — the largest shape tested, 20 hits and every list full of items at their
 * longest, comes to about 55,500. Every cap here is applied in
 * the core, so REST and MCP still give one record, and each cut is counted in the `trimmed` gap.
 * - HIT_TEXT_BUDGET: the knowledge's text, shared across the hits, each at least HIT_TEXT_MIN, cut to its head;
 * - HIT_LABELS: a hit's labels, past which the rest are counted in its `…More`, as search_thoughts counts its own;
 * - BOARD_SHOWN: the open tickets listed, the rest counted; BOARD_TITLE: a title's characters;
 * - OTHERS_TITLED: the settled and unknown-type tickets listed with their titles, the rest by key and status.
 */
export const HIT_TEXT_BUDGET = 1_200;
export const HIT_TEXT_MIN = 100;
export const HIT_LABELS = { claimed: 2, relations: 2, priority: 3 } as const;
/**
 * The lists a thought's metadata and a board line carry (review pass 2: an importer's 30 topics on every hit made a
 * reply of 220,703 characters, and 12 blockers on every open ticket 59,058): a hit's topics, people and action items,
 * and an open ticket's blockers and its live and lapsed claims' holders, each to its first few, the cut counted.
 */
export const HIT_META = { topics: 3, people: 3, action_items: 2 } as const;
/** A metadata item's characters, past which it is cut (the block's own one-line caps are 80 and 200). */
export const HIT_META_ITEM = 60;
/** A board line's blockers and holders. Each is kept whole (review pass 3: a cut identity could not be followed); the text quotes it to 80. */
export const TICKET_LABELS = { blockers: 3, claimed: 1, lapsedClaim: 1 } as const;
/** How many of an open ticket's blockers and holders the budget left out, so its line and the value still count them (review pass 3). */
export type TicketMore = { blockers: number; claimed: number; lapsedClaim: number };
export const BOARD_SHOWN = 15;
export const BOARD_TITLE = 72;
export const OTHERS_TITLED = 5;
/**
 * The lists that grew with the board's reach of 500 keys (review pass 1: 400 settled and 100 waiting tickets made a
 * reply of 68,825 characters): settled and unknown-type tickets listed to OTHERS_LISTED, those not yet startable to
 * WAITING_LISTED, the keys no thought records to MISSING_LISTED, each past it counted.
 */
export const OTHERS_LISTED = 40;
export const WAITING_LISTED = 10;
export const MISSING_LISTED = 20;

/** A string's head of at most `n` UTF-16 units, never ending in half of a surrogate pair (review pass 1: a cut through an emoji left a lone surrogate). */
export function headOf(s: string, n: number): string {
  if (s.length <= n) return s;
  const head = s.slice(0, n);
  const last = head.charCodeAt(head.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? head.slice(0, -1) : head;
}

const shortTitle = (t: string): { title: string; cut: boolean } =>
  t.length <= BOARD_TITLE ? { title: t, cut: false } : { title: `${headOf(t, BOARD_TITLE - 1)}…`, cut: true };

/** A list cut to its first `n`, the rest added to its count of more. */
function capped<T>(list: T[] | null, more: number, n: number): { list: T[] | null; more: number; cut: number } {
  if (list === null || list.length <= n) return { list, more, cut: 0 };
  return { list: list.slice(0, n), more: more + list.length - n, cut: list.length - n };
}

/**
 * The reply held to its budget (SMD-4191): each hit's text cut to its share of HIT_TEXT_BUDGET, each hit's labels to
 * HIT_LABELS, the board's open tickets to BOARD_SHOWN and every title to BOARD_TITLE, the settled ones past
 * OTHERS_TITLED by key and status alone; what was cut said in one `trimmed` gap. Nothing else changes.
 */
export function budgetPlan(v: Omit<PlanContextResult, "knowledge"> & { knowledge: Omit<PlanContextResult["knowledge"], "hits"> & { hits: SearchHit[] } }): PlanContextResult {
  const trimmed: PlanTrimmed = { gap: "trimmed", hitText: 0, labels: 0, boardLabels: 0, tickets: 0, titles: 0, unlisted: 0 };
  const share = v.knowledge.hits.length ? Math.max(HIT_TEXT_MIN, Math.floor(HIT_TEXT_BUDGET / v.knowledge.hits.length)) : HIT_TEXT_BUDGET;
  const hits: PlanHit[] = v.knowledge.hits.map((h) => {
    const contentChars = h.content.length;
    if (contentChars > share) trimmed.hitText++;
    const claimed = capped(h.claimed, h.claimedMore ?? 0, HIT_LABELS.claimed);
    const relations = capped(h.relations, h.relationsMore ?? 0, HIT_LABELS.relations);
    const priority = capped(h.priority, h.priorityMore ?? 0, HIT_LABELS.priority);
    trimmed.labels += claimed.cut + relations.cut + priority.cut;
    // The metadata lists the block prints, each to its first few (a copy: the thought's own metadata is untouched).
    const metadata: Record<string, unknown> = { ...(h.metadata ?? {}) };
    for (const [k, n] of Object.entries(HIT_META)) {
      const list = metadata[k];
      if (!Array.isArray(list)) continue;
      // Only what the block would print (review pass 3: empty entries took the slots of real ones).
      const printable = list.filter((x) => x !== null && x !== undefined && String(x).trim() !== "");
      if (printable.length > n) trimmed.labels += printable.length - n;
      metadata[k] = printable.slice(0, n).map((x) => (typeof x === "string" && x.length > HIT_META_ITEM ? `${headOf(x, HIT_META_ITEM - 1)}…` : x));
    }
    return {
      ...h, metadata, content: headOf(h.content, share), contentChars,
      claimed: claimed.list, claimedMore: claimed.more, relations: relations.list, relationsMore: relations.more, priority: priority.list, priorityMore: priority.more,
    };
  });
  let board = v.board;
  if (board.available) {
    const shown = board.tickets.slice(0, BOARD_SHOWN);
    // Past the list, by key (review pass 1: the agenda tool takes no keys, so a cut ticket was out of reach).
    const moreOpen = board.tickets.slice(BOARD_SHOWN).map((t) => t.key);
    trimmed.tickets = moreOpen.length;
    const ticketMore: Record<string, TicketMore> = {};
    const tickets = shown.map((t) => {
      const c = shortTitle(t.title);
      if (c.cut) trimmed.titles++;
      // A line's blockers and holders to their first few, kept whole; how many were left out kept per ticket (review
      // passes 2 and 3), so the line says "and N more" and the value counts them all.
      const more: TicketMore = { blockers: Math.max(0, t.blockers.length - TICKET_LABELS.blockers), claimed: Math.max(0, t.claimed.length - TICKET_LABELS.claimed),
                                 lapsedClaim: Math.max(0, t.lapsedClaim.length - TICKET_LABELS.lapsedClaim) };
      const n = more.blockers + more.claimed + more.lapsedClaim;
      if (n) { ticketMore[t.key] = more; trimmed.boardLabels += n; }
      return { ...t, blockers: t.blockers.slice(0, TICKET_LABELS.blockers), claimed: t.claimed.slice(0, TICKET_LABELS.claimed),
               lapsedClaim: t.lapsedClaim.slice(0, TICKET_LABELS.lapsedClaim), title: c.title };
    });
    const waitingMore = Math.max(0, board.waiting.length - WAITING_LISTED);
    const waiting = board.waiting.slice(0, WAITING_LISTED).map((t) => { const c = shortTitle(t.title); if (c.cut) trimmed.titles++; return { ...t, title: c.title }; });
    const othersMore = Math.max(0, board.others.length - OTHERS_LISTED);
    const others = board.others.slice(0, OTHERS_LISTED).map((t, i) => {
      if (i >= OTHERS_TITLED) { if (t.title) trimmed.titles++; return { ...t, title: "" }; }
      const c = shortTitle(t.title); if (c.cut) trimmed.titles++; return { ...t, title: c.title };
    });
    trimmed.unlisted = waitingMore + othersMore;
    board = { ...board, tickets, waiting, others, ...(Object.keys(ticketMore).length ? { ticketMore } : {}), ...(moreOpen.length ? { moreOpen } : {}), ...(othersMore ? { othersMore } : {}), ...(waitingMore ? { waitingMore } : {}) };
  }
  const gaps: PlanGap[] = v.gaps.map((g) => {
    if (g.gap !== "tickets_missing" || g.keys.length <= MISSING_LISTED) return g;
    trimmed.unlisted += g.keys.length - MISSING_LISTED;
    return { gap: "tickets_missing", keys: g.keys.slice(0, MISSING_LISTED), more: (g.more ?? 0) + g.keys.length - MISSING_LISTED };
  });
  const cut = trimmed.hitText + trimmed.labels + trimmed.boardLabels + trimmed.tickets + trimmed.titles + trimmed.unlisted > 0;
  return { ...v, knowledge: { ...v.knowledge, hits }, board, gaps: cut ? [...gaps, trimmed] : gaps };
}
/** A ticket key as the agenda takes one (126's `c_key`, 068's form). Kept in step with the SQL: one key it refuses fails the whole call. */
export const AGENDA_KEY = /^[A-Z][A-Z0-9]{1,15}-[1-9][0-9]{0,9}$/;

/** A section this brain cannot fill yet: why, and the tickets whose landing fills it. */
export type NotAvailable = { available: false; reason: string; waitsOn: string[] };
export type BoardNotRead = "deadline" | "failed" | "no_keys_scope";

export type PlanBoard =
  | {
      available: true;
      /** The named tickets the agenda ranks, in its order, blocked, claimed and started ones included (each says so). */
      tickets: AgendaItem[];
      /** The named tickets it does not rank: settled, or a status type this brain does not know. */
      others: AgendaOther[];
      /** The named tickets a not_before ahead keeps out: not yet startable, and when they will be. */
      waiting: AgendaWaiting[];
      /** Per open ticket listed, keyed by its key, how many blockers and holders the budget left out (SMD-4191 review pass 3). */
      ticketMore?: Record<string, TicketMore>;
      /** Held to the reply's budget (SMD-4191): the keys of open tickets past the list's first BOARD_SHOWN, and how many settled or waiting tickets went unlisted. */
      moreOpen?: string[];
      othersMore?: number;
      waitingMore?: number;
      /** False when this role may not read work_claims: no claim is named on a ticket. Null when no ticket was named, so nothing was read. */
      claimsRead: boolean | null;
      /** The live claims this brain records on any ticket; 0 means work claimed through another brain is not seen here. Null when not read. */
      claimsLive: number | null;
      /** board-sync's last heartbeat, so a reader knows how fresh the statuses are. */
      boardSync: { at: string; outcome: unknown } | null;
    }
  | { available: false; reason: BoardNotRead; waitsOn: string[] };

/**
 * Where "the brain has little on this" begins (SMD-4212), measured once in its PR 1 (evals/eval-little.ts; the ticket's
 * comment 7689f339): no knowledge hit with a similarity of LITTLE_BAR or more, on the embedding LITTLE_MEASURED_ON. On
 * 40 held-out requests it scored 0.885 balanced accuracy and 0.789 precision. Similarity is the embedding's own scale,
 * so on any other the bar is not applied and a note says it was not measured there. A request whose ticket the brain
 * holds only as its board record reads as covered: its own record is a close match.
 */
export const LITTLE_BAR = 0.74;
export const LITTLE_MEASURED_ON = "qwen3-embedding:4b@1024";
/**
 * The hits the bar was measured over: the first 8 in the search's order (plan_context's default limit). A larger limit
 * reads its first 8, as measured; a smaller one reads what it has. On the 80 measured requests, the best of the first
 * 1, 3 or 5 hits made the same call as the best of 8 on every one (review pass 1), though an exact-literal hit ranks
 * first whatever its similarity.
 */
export const LITTLE_HITS = 8;

export type PlanGap =
  | { gap: "no_knowledge" }
  | { gap: "all_superseded"; hits: number }
  | { gap: "ingested_only"; hits: number }
  | { gap: "semantic_unavailable"; reason: string }
  /**
   * The best similarity of the first LITTLE_HITS hits under LITTLE_BAR, on the embedding it was measured on: the brain
   * may hold little here. Null: no hit read has a similarity.
   */
  | { gap: "little"; topSimilarity: number | null; bar: number; embeddingId: string }
  /** A note, not a coverage gap: this server's embedding is not the one the bar was measured on, so no bar is applied. */
  | { gap: "little_not_measured"; topSimilarity: number | null; embeddingId: string; measuredOn: string }
  | { gap: "tickets_missing"; keys: string[]; more?: number }
  | { gap: "tickets_not_read"; count: number }
  | { gap: "section_unavailable"; section: "board"; reason: BoardNotRead; named: number }
  | PlanTrimmed;

/**
 * What the reply's budget cut (SMD-4191), so nothing is dropped without a word: hits whose text was cut to its head
 * (`fetch` reads the whole), labels past a hit's caps (`fetch`, `relations` and `list_claims` read them), open tickets
 * past the board's first BOARD_SHOWN (the agenda lists them), and titles shortened or left off.
 */
export type PlanTrimmed = { gap: "trimmed"; hitText: number; labels: number; boardLabels: number; tickets: number; titles: number; unlisted: number };

export type PlanTools = {
  scope: Principal["scope"];
  /** The core tools this key's scope may call, sorted. */
  core: string[];
  /** The enabled plugins' operations this key's scope may call, by MCP tool name, sorted; null when the plugin list could not be read. */
  plugins: string[] | null;
  /** Tools served by another server — a vendored recipe's, an n8n workflow's — are not known here, and none is left out silently. */
  elsewhere: "unknown";
};

/** A knowledge hit as plan_context hands it over: its text perhaps cut to its head, `contentChars` the whole text's length. */
export type PlanHit = SearchHit & { contentChars: number };

export type PlanContextResult = {
  request: string;
  knowledge: { hits: PlanHit[]; preferCurrent: true; vectorFailed?: QueryVectorFailed };
  board: PlanBoard;
  specs: NotAvailable;
  procedures: NotAvailable;
  tools: PlanTools;
  gaps: PlanGap[];
  deadlineMs: number;
};

const SPECS: NotAvailable = { available: false, reason: "this brain records no specs yet, and its deliverables are read through deliverable_history", waitsOn: ["SMD-2683"] };
const PROCEDURES: NotAvailable = { available: false, reason: "this brain records no procedures yet", waitsOn: ["SMD-1721"] };

/**
 * The tickets a page of hits names, as the agenda takes keys: each hit's filed keys, then those its text names, in hit
 * order, once each; the first BOARD_KEYS read, and the distinct keys past them counted (review pass 1: a per-hit count
 * summed counted a key twice, and a key another hit read as not read). A token outside the agenda's key form (SMD-0,
 * a prefix past 16 characters) is no ticket the board can read, and is dropped.
 */
export function boardKeysOf(hits: readonly { content: string; metadata?: Record<string, unknown> | null }[]): { keys: string[]; notRead: number } {
  const seen = new Set<string>();
  for (const h of hits) {
    const { filed, named } = ticketsNamedBy(h);
    for (const key of [...filed, ...named]) if (AGENDA_KEY.test(key)) seen.add(key);
  }
  const all = [...seen];
  return { keys: all.slice(0, BOARD_KEYS), notRead: Math.max(0, all.length - BOARD_KEYS) };
}

/** The tools section: the manifest's tools and the enabled plugins' operations this key's scope unlocks. */
export function toolsFor(ctx: Pick<Ctx, "env">, principal: Pick<Principal, "scope">): PlanTools {
  const core = visibleToolNames(principal).filter((n) => TOOLS.some((t) => t.name === n)).sort();
  let plugins: string[] | null;
  try {
    plugins = loadPlugins(ctx.env().OB1_PLUGINS).flatMap((p) => p.operations).filter((o) => unlocks(principal, o.scope as ToolScope)).map((o) => o.tool).sort();
  } catch {
    // A plugin list the server cannot load is preflight's to say; here, not read.
    plugins = null;
  }
  return { scope: principal.scope, core, plugins, elsewhere: "unknown" };
}

const ingested = (h: { metadata?: Record<string, unknown> | null }) => h.metadata?.trust === "ingested";

/**
 * The gaps the knowledge section shows: no hit at all, every hit superseded, every hit outside text, no vector, and,
 * given the embedding the search ran on (`<model>@<dim>`), little on this (SMD-4212): the best similarity of the first
 * LITTLE_HITS hits under LITTLE_BAR, or a note that no bar is measured for that embedding. A hit with no similarity
 * counts as 0, as the measurement read it, and none having one is said as no similarity. No vector (the hits are exact
 * matches), no hit, or no embedding named: no little gap.
 */
export function knowledgeGaps(hits: readonly Pick<SearchHit, "supersededBy" | "metadata" | "similarity">[], vectorFailed: QueryVectorFailed | undefined, embeddingId?: string): PlanGap[] {
  const gaps: PlanGap[] = [];
  if (vectorFailed) gaps.push({ gap: "semantic_unavailable", reason: vectorFailed.reason });
  if (hits.length === 0) gaps.push({ gap: "no_knowledge" });
  else {
    if (hits.every((h) => h.supersededBy !== null)) gaps.push({ gap: "all_superseded", hits: hits.length });
    if (hits.every(ingested)) gaps.push({ gap: "ingested_only", hits: hits.length });
  }
  if (!vectorFailed && hits.length && embeddingId !== undefined) {
    const sims = hits.slice(0, LITTLE_HITS).map((h) => h.similarity).filter((s): s is number => typeof s === "number");
    const topSimilarity = sims.length ? Math.max(...sims) : null;
    if (embeddingId !== LITTLE_MEASURED_ON) gaps.push({ gap: "little_not_measured", topSimilarity, embeddingId, measuredOn: LITTLE_MEASURED_ON });
    else if ((topSimilarity ?? 0) < LITTLE_BAR) gaps.push({ gap: "little", topSimilarity, bar: LITTLE_BAR, embeddingId });
  }
  return gaps;
}

/** The embedding this server searches with, as `<model>@<dim>` (the form SMD-4212's bar names); undefined when the context can't say. */
export function embeddingIdOf(ctx: Partial<Pick<Ctx, "embedConfig">>): string | undefined {
  if (typeof ctx.embedConfig !== "function") return undefined;
  const c = ctx.embedConfig();
  return `${c.embeddingModel}@${c.embeddingDim}`;
}

const sqlState = (e: unknown) => String((e as { errno?: unknown; code?: unknown })?.errno ?? (e as { code?: unknown })?.code ?? "");

/**
 * The board section: the named tickets in one agenda call (126's keys scope), every flag on so blocked, claimed and
 * started tickets are listed and say so, under what is left of the deadline as its statement timeout. Its gaps: the
 * named keys no thought records, tickets past the reach, and a board not read — out of time (none left, or a statement
 * cancelled, 57014: the deadline, or a stricter timeout the database keeps), an agenda before 126 (which refuses the
 * keys scope by name), or any other failure, which the server's log names. A failure never fails the read.
 */
export async function boardOf(ctx: Pick<Ctx, "store">, given: { keys: string[]; notRead: number }, leftMs: number): Promise<{ board: PlanBoard; gaps: PlanGap[] }> {
  const gaps: PlanGap[] = [];
  let named = given;
  let board: PlanBoard;
  if (named.keys.length === 0) {
    board = { available: true, tickets: [], others: [], waiting: [], claimsRead: null, claimsLive: null, boardSync: null };
  } else if (leftMs <= 0) {
    board = { available: false, reason: "deadline", waitsOn: [] };
  } else {
    try {
      const a = await (await ctx.store()).agenda({
        scope: { keys: named.keys }, limit: BOARD_LIMIT, includeBlocked: true, includeClaimed: true, includeProposed: false, includeStarted: true, timeoutMs: leftMs,
      });
      // An agenda before 126 refuses a keys scope (below), so an answer without `keyed` is a fault.
      if (a.keyed === null) throw new Error("agenda answered no keyed tickets for a keys scope");
      board = { available: true, tickets: a.items, others: a.keyed.others, waiting: a.keyed.waiting, claimsRead: a.claimsRead, claimsLive: a.claimsLive, boardSync: a.boardSync };
      if (a.keyed.missing.length) gaps.push({ gap: "tickets_missing", keys: a.keyed.missing });
      // Open named tickets past the list's 100: in total alone (review pass 2).
      named = { ...named, notRead: named.notRead + Math.max(0, a.total - a.items.length) };
    } catch (e) {
      const code = sqlState(e);
      if (code === "57014") board = { available: false, reason: "deadline", waitsOn: [] };
      else if (code === "22023" && /not an agenda scope: keys/.test(String((e as Error)?.message ?? ""))) board = { available: false, reason: "no_keys_scope", waitsOn: [] };
      else {
        console.error(`plan_context: the board's agenda read failed (${code || "no code"}): ${String((e as Error)?.message ?? e).slice(0, 200)}; the board is a gap`);
        board = { available: false, reason: "failed", waitsOn: [] };
      }
    }
  }
  // How many tickets the hits named, so a board not read still says what it would have read (review pass 2).
  if (!board.available) gaps.push({ gap: "section_unavailable", section: "board", reason: board.reason, named: named.keys.length });
  if (named.notRead > 0) gaps.push({ gap: "tickets_not_read", count: named.notRead });
  return { board, gaps };
}

/** The knowledge read: the shared search and its labels. A seam, so the whole read is tested with a stub (review pass 1). */
export type PlanSearch = (ctx: Ctx, principal: Principal, q: { query: string; limit: number; signal: AbortSignal }) =>
  Promise<{ refusal: Refusal } | { refusal?: undefined; rows: ThoughtHybridMatch[]; hits: SearchHit[]; vectorFailed?: QueryVectorFailed }>;

/** The hybrid arm with prefer_current, unlogged (this read logs its own row), its embedding stopped by the signal. */
export const planSearch: PlanSearch = async (ctx, principal, q) => {
  const r = await runSearch(ctx, principal, { tool: "plan_context", arm: "hybrid", query: q.query, limit: q.limit, threshold: 0, recencyWeight: 0, filter: {}, preferCurrent: true, unlogged: true, signal: q.signal });
  if (r.refusal) return { refusal: r.refusal };
  return { rows: r.rows, hits: r.rows.length ? await labelHits(ctx, principal, r.rows) : [], ...(r.vectorFailed ? { vectorFailed: r.vectorFailed } : {}) };
};

export async function planContext(ctx: Ctx, principal: Principal, input: Input<"plan_context">,
  opts: { deadlineMs?: number; now?: () => number; search?: PlanSearch } = {}): Promise<Outcome<PlanContextResult>> {
  const clock = opts.now ?? (() => performance.now());
  const deadlineMs = opts.deadlineMs ?? PLAN_DEADLINE_MS;
  const started = clock();
  const request = input.request;

  // Knowledge: the embedding stopped before the deadline, leaving the board its reserve; answered then by exact matches.
  const stop = AbortSignal.timeout(Math.max(deadlineMs - BOARD_RESERVE_MS, Math.floor(deadlineMs / 2)));
  const r = await (opts.search ?? planSearch)(ctx, principal, { query: request, limit: input.limit, signal: stop });
  if (r.refusal) return refuse(r.refusal);
  const { rows, hits } = r;
  const gaps = knowledgeGaps(hits, r.vectorFailed, embeddingIdOf(ctx));

  // Board: the named tickets, in one agenda call, with what is left of the deadline.
  const named = boardKeysOf(hits);
  const { board, gaps: boardGaps } = await boardOf(ctx, named, deadlineMs - (clock() - started));
  gaps.push(...boardGaps);

  // Held to the reply's budget (SMD-4191); the log below names every hit and ticket read, cut or not.
  const value = budgetPlan({
    request,
    knowledge: { hits, preferCurrent: true, ...(r.vectorFailed ? { vectorFailed: r.vectorFailed } : {}) },
    board, specs: SPECS, procedures: PROCEDURES, tools: toolsFor(ctx, principal), gaps, deadlineMs,
  });
  // A board not read says why in the row's filter, so its empty items are not read as a board that named nothing.
  await ctx.logPlanContext(principal, {
    query: request, matchCount: input.limit, arm: r.vectorFailed ? "literal" : "current",
    resultIds: rows.map((h) => h.id), resultScores: rows.map((h) => h.score ?? null),
    items: board.available ? board.tickets.map((t) => ({ kind: t.kind, key: t.key, effective: t.effective })) : [],
    filter: board.available ? {} : { board: board.reason },
  });
  return ok(value);
}
