// plan_context (SMD-2684): what the brain holds for a request, in one read, so a client starting work judges whether it
// can and plans with it. Not a planner: no model call, no verdict. Sections, each present or said not available:
//   knowledge   search_thoughts' hybrid arm with prefer_current, each hit labelled as search_thoughts labels it;
//   board       the tickets those hits name, in one agenda call (migration 126's keys scope: the maintainer's choice,
//               2026-11-09, so one ranking serves both reads), and the named ones it does not rank, settled or missing;
//   specs       not available: SMD-2683 (a spec record) and SMD-1715 (deliverables) have not landed;
//   procedures  not available: SMD-1721 has not landed;
//   tools       what this key's scope may call here, core and plugin, and that other servers' tools are unknown to it;
//   gaps        what it could not find, as values: no knowledge, every hit superseded or ingested, a named ticket the
//               brain does not hold, tickets past the read's reach, a section that ran out of time or failed.
// Bounded: one deadline for the whole read. The knowledge search runs first (the board reads its hits); the board's
// agenda call gets what is left as its statement timeout, and a board past it, or failing, is a gap, not a failure.
// Logged as one query_log row of its own kind (126): the request, the hits' ids, the board's tickets.

import type { Principal } from "../auth.ts";
import type { AgendaItem, AgendaOther, ThoughtHybridMatch } from "../store.ts";
import { TOOLS, unlocks, visibleToolNames, type ToolScope } from "../tools.ts";
import type { Ctx } from "./context.ts";
import { loadPlugins } from "./plugins.ts";
import { claimKeysOf, labelHits, runSearch, type QueryVectorFailed, type SearchHit } from "./reads.ts";
import { ok, refuse, type Outcome } from "./refusal.ts";
import type { Input } from "./schemas.ts";

/** The whole read's deadline, in ms: the knowledge search and the board's agenda call together. */
export const PLAN_DEADLINE_MS = 10_000;
/** The board's reach: the agenda's own ceiling of 100 keys (126). Named tickets past it are counted, not read. */
export const BOARD_KEYS = 100;
/** A ticket key as the agenda takes one (126's `c_key`, 068's form). */
const AGENDA_KEY = /^[A-Z][A-Z0-9]{1,15}-[1-9][0-9]{0,9}$/;

/** A section this brain cannot fill yet: why, and the tickets whose landing fills it. */
export type NotAvailable = { available: false; reason: string; waitsOn: string[] };

export type PlanBoard =
  | {
      available: true;
      /** The named tickets the agenda ranks, in its order, blocked, claimed and started ones included (each says so). */
      tickets: AgendaItem[];
      /** The named tickets it does not rank: settled, or a status type this brain does not know. */
      others: AgendaOther[];
      /** False when this role may not read work_claims: no claim is named on a ticket. Null when no ticket was named, so nothing was read. */
      claimsRead: boolean | null;
      /** board-sync's last heartbeat, so a reader knows how fresh the statuses are. */
      boardSync: { at: string; outcome: unknown } | null;
    }
  | { available: false; reason: "deadline" | "failed" | "no_keys_scope"; waitsOn: string[] };

export type PlanGap =
  | { gap: "no_knowledge" }
  | { gap: "all_superseded"; hits: number }
  | { gap: "ingested_only"; hits: number }
  | { gap: "semantic_unavailable"; reason: string }
  | { gap: "tickets_missing"; keys: string[] }
  | { gap: "tickets_not_read"; count: number }
  | { gap: "section_unavailable"; section: "board"; reason: "deadline" | "failed" | "no_keys_scope" };

export type PlanTools = {
  scope: Principal["scope"];
  /** The core tools this key's scope may call, sorted. */
  core: string[];
  /** The enabled plugins' operations this key's scope may call, by MCP tool name, sorted; null when the plugin list could not be read. */
  plugins: string[] | null;
  /** Tools served by another server — a vendored recipe's, an n8n workflow's — are not known here, and none is left out silently. */
  elsewhere: "unknown";
};

export type PlanContextResult = {
  request: string;
  knowledge: { hits: SearchHit[]; preferCurrent: true; vectorFailed?: QueryVectorFailed };
  board: PlanBoard;
  specs: NotAvailable;
  procedures: NotAvailable;
  tools: PlanTools;
  gaps: PlanGap[];
  deadlineMs: number;
};

const SPECS: NotAvailable = { available: false, reason: "this brain records no specs or deliverables yet", waitsOn: ["SMD-2683", "SMD-1715"] };
const PROCEDURES: NotAvailable = { available: false, reason: "this brain records no procedures yet", waitsOn: ["SMD-1721"] };

/** The tickets a page of hits names, in hit order, as the agenda takes keys: the first BOARD_KEYS, and how many were not read. */
export function boardKeysOf(hits: readonly { content: string; metadata?: Record<string, unknown> | null }[]): { keys: string[]; notRead: number } {
  const seen = new Set<string>();
  let notRead = 0;
  for (const h of hits) {
    const k = claimKeysOf(h);
    notRead += k.notRead;
    for (const key of k.keys) if (AGENDA_KEY.test(key)) seen.add(key);
  }
  const all = [...seen];
  return { keys: all.slice(0, BOARD_KEYS), notRead: notRead + Math.max(0, all.length - BOARD_KEYS) };
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

/** The gaps the knowledge section shows: nothing found, every hit superseded, every hit outside text, no vector. */
export function knowledgeGaps(hits: readonly Pick<SearchHit, "supersededBy" | "metadata">[], vectorFailed: QueryVectorFailed | undefined): PlanGap[] {
  const gaps: PlanGap[] = [];
  if (vectorFailed) gaps.push({ gap: "semantic_unavailable", reason: vectorFailed.reason });
  if (hits.length === 0) gaps.push({ gap: "no_knowledge" });
  else {
    if (hits.every((h) => h.supersededBy !== null)) gaps.push({ gap: "all_superseded", hits: hits.length });
    if (hits.every(ingested)) gaps.push({ gap: "ingested_only", hits: hits.length });
  }
  return gaps;
}

const sqlState = (e: unknown) => String((e as { errno?: unknown; code?: unknown })?.errno ?? (e as { code?: unknown })?.code ?? "");

/**
 * The board section: the named tickets in one agenda call (126's keys scope), every flag on so blocked, claimed and
 * started tickets are listed and say so, under what is left of the deadline as its statement timeout. Its gaps: the
 * named keys no thought records, tickets past the reach, and a board not read — past the deadline (none left, or the
 * statement cancelled, 57014), an agenda before 126 (which refuses the keys scope by name), or any other failure, which
 * the server's log names. A failure never fails the read.
 */
export async function boardOf(ctx: Pick<Ctx, "store">, named: { keys: string[]; notRead: number }, leftMs: number): Promise<{ board: PlanBoard; gaps: PlanGap[] }> {
  const gaps: PlanGap[] = [];
  let board: PlanBoard;
  if (named.keys.length === 0) {
    board = { available: true, tickets: [], others: [], claimsRead: null, boardSync: null };
  } else if (leftMs <= 0) {
    board = { available: false, reason: "deadline", waitsOn: [] };
  } else {
    try {
      const a = await (await ctx.store()).agenda({
        scope: { keys: named.keys }, limit: BOARD_KEYS, includeBlocked: true, includeClaimed: true, includeProposed: false, includeStarted: true, timeoutMs: leftMs,
      });
      // An agenda before 126 refuses a keys scope (below), so an answer without `keyed` is a fault.
      if (a.keyed === null) throw new Error("agenda answered no keyed tickets for a keys scope");
      board = { available: true, tickets: a.items, others: a.keyed.others, claimsRead: a.claimsRead, boardSync: a.boardSync };
      if (a.keyed.missing.length) gaps.push({ gap: "tickets_missing", keys: a.keyed.missing });
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
  if (!board.available) gaps.push({ gap: "section_unavailable", section: "board", reason: board.reason });
  if (named.notRead > 0) gaps.push({ gap: "tickets_not_read", count: named.notRead });
  return { board, gaps };
}

export async function planContext(ctx: Ctx, principal: Principal, input: Input<"plan_context">, opts: { deadlineMs?: number; now?: () => number } = {}): Promise<Outcome<PlanContextResult>> {
  const clock = opts.now ?? (() => performance.now());
  const deadlineMs = opts.deadlineMs ?? PLAN_DEADLINE_MS;
  const started = clock();
  const request = input.request;

  // Knowledge: the hybrid arm with prefer_current, unlogged here (this read logs its own row, below).
  const r = await runSearch(ctx, principal, { tool: "plan_context", arm: "hybrid", query: request, limit: input.limit, threshold: 0, recencyWeight: 0, filter: {}, preferCurrent: true, unlogged: true });
  if (r.refusal) return refuse(r.refusal);
  const rows: ThoughtHybridMatch[] = r.rows;
  const hits = rows.length ? await labelHits(ctx, principal, rows) : [];
  const gaps = knowledgeGaps(hits, r.vectorFailed);

  // Board: the named tickets, in one agenda call, with what is left of the deadline.
  const named = boardKeysOf(hits);
  const { board, gaps: boardGaps } = await boardOf(ctx, named, deadlineMs - (clock() - started));
  gaps.push(...boardGaps);

  const value: PlanContextResult = {
    request,
    knowledge: { hits, preferCurrent: true, ...(r.vectorFailed ? { vectorFailed: r.vectorFailed } : {}) },
    board, specs: SPECS, procedures: PROCEDURES, tools: toolsFor(ctx, principal), gaps, deadlineMs,
  };
  await ctx.logPlanContext(principal, {
    query: request, matchCount: input.limit, arm: r.vectorFailed ? "literal" : "current",
    resultIds: rows.map((h) => h.id), resultScores: rows.map((h) => h.score ?? null),
    items: board.available ? board.tickets.map((t) => ({ kind: t.kind, key: t.key, effective: t.effective })) : [],
  });
  return ok(value);
}
