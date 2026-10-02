// The read operations (SMD-2283): what the read tools did inside their MCP
// closures, as functions of a principal and a typed input. Each returns the
// typed value or a typed refusal (core/refusal.ts) and throws a fault; none
// knows MCP or writes a sentence — the MCP registration renders the value in
// the words it always has, and the REST core (SMD-2284) answers it as JSON.

import { thoughtTitle, thoughtUrl } from "../thoughts.ts";
import { mayLeaveBox, type EgressSubject } from "../egress.ts";
import { storeKind, UUID_RE, type AuditChange, type LoggedSearchPage, type SupersessionProposal, type ThoughtHybridMatch, type ThoughtIdPage, type ThoughtKeywordMatch, type ThoughtListItem, type ThoughtStats, type WorkerStatusRow } from "../store.ts";
import { readJob, startJob, type JobHandle, type PublicJob, type StartJobOptions } from "../jobs.ts";
import { brainInfo as readBrain, type BrainInfo, type ReadOptions, type ServerFacts } from "../brain-info.ts";
import { FORK_VERSION, LATEST_MIGRATION, RELEASE_RANGE } from "../version.ts";
import type { Principal } from "../auth.ts";
import type { Ctx } from "./context.ts";
import { FilterError, parseFilter, withActorFilter } from "./filter.ts";
import { ok, refuse, type Outcome, type Refusal } from "./refusal.ts";
import { SCAN_DEFAULT, SCAN_MAX, type Input } from "./schemas.ts";

// ── The one search operation ─────────────────────────────────────────────────

/**
 * The question the hybrid arm asks before embedding a query (SMD-1903): the
 * subject the embedding will be judged and sent under, and the refusal when it
 * may not leave.
 */
function gateQuery(ctx: Ctx, query: string, principal: Principal): { subject: EgressSubject; refusal?: Refusal } {
  const cfg = ctx.embedConfig();
  const subject: EgressSubject = { kind: "query", actor: principal.name, content: query };
  const gate = mayLeaveBox(subject, cfg.embeddings, cfg.egress);
  return gate.allowed ? { subject } : { subject, refusal: { code: "REFUSED_EGRESS", retryable: false, rule: gate.rule, reason: gate.reason, actor: principal.name } };
}

// The one search operation the three search tools share (SMD-1490). It owns
// the policy that was copy-pasted across the handlers — and dropped the filter
// in three places, and never logged keyword at all: the egress gate before a
// query leaves for its embedding (hybrid only — a keyword search embeds
// nothing, so nothing leaves the box), the arm dispatch, and the query-log
// write with the filter, the arm and the tier on it. Each tool is a thin
// operation over it; the rows come back typed per arm, so search_thoughts still
// gets its needle facts and keyword its occurrence counts.
type Refused = { refusal: Refusal; rows?: undefined; embedding?: undefined };
interface RunSearch {
  // The hybrid arm hands back the query embedding it computed, so a caller
  // (search_thoughts's zero-result probe) reuses it without a second gate or
  // provider call.
  (ctx: Ctx, principal: Principal, opts: { tool: string; arm: "hybrid"; query: string; limit: number; threshold: number; recencyWeight: number; filter: Record<string, unknown>; preferCurrent?: boolean }):
    Promise<Refused | { refusal?: undefined; rows: ThoughtHybridMatch[]; embedding: number[] }>;
  (ctx: Ctx, principal: Principal, opts: { tool: string; arm: "keyword"; query: string; limit: number; offset: number; filter: Record<string, unknown> }):
    Promise<{ refusal?: undefined; rows: ThoughtKeywordMatch[] }>;
}
const runSearch: RunSearch = (async (ctx: Ctx, principal: Principal, opts: {
  tool: string; arm: "hybrid" | "keyword"; query: string; limit: number;
  threshold?: number; recencyWeight?: number; offset?: number; filter: Record<string, unknown>; preferCurrent?: boolean;
}): Promise<{ refusal?: Refusal; rows: (ThoughtHybridMatch | ThoughtKeywordMatch)[]; embedding?: number[] }> => {
  if (opts.arm === "keyword") {
    const rows = await (await ctx.store()).keywordThoughts({ query: opts.query, limit: opts.limit, offset: opts.offset ?? 0, filter: opts.filter });
    // A keyword search takes no threshold or recency weight; log them as the
    // compat `search` does its fixed zeros, so the column is a number not a NULL.
    await ctx.logSearch(principal, opts.tool, { query: opts.query, limit: opts.limit, threshold: 0, recencyWeight: 0, filter: opts.filter, arm: "keyword" }, rows);
    return { rows };
  }
  // The query text leaves for its embedding as a thought's does (SMD-1903).
  const q = gateQuery(ctx, opts.query, principal);
  if (q.refusal) return { refusal: q.refusal, rows: [] };
  const embedding = await ctx.embedder.getEmbedding(opts.query, q.subject, "query");
  // prefer_current (059, SMD-2255) is the same arm through another function,
  // logged as arm `current` so a replay takes the same one.
  const preferCurrent = opts.preferCurrent === true;
  const rows = await (await ctx.store()).hybridThoughts({
    query: opts.query, embedding, threshold: opts.threshold ?? 0, limit: opts.limit,
    filter: opts.filter, recencyWeight: opts.recencyWeight ?? 0, preferCurrent,
  });
  await ctx.logSearch(principal, opts.tool, { query: opts.query, limit: opts.limit, threshold: opts.threshold ?? 0, recencyWeight: opts.recencyWeight ?? 0, filter: opts.filter, arm: preferCurrent ? "current" : "hybrid" }, rows);
  return { rows, embedding };
}) as RunSearch;

/** The filter a search tool was given, folded and bounded — or the refusal of it. */
function searchFilter(input: { filter?: unknown; said_by?: string; actor?: string }): { filter: Record<string, unknown> } | { refusal: Refusal } {
  try {
    return { filter: withActorFilter(parseFilter(input.filter), input.said_by, input.actor) };
  } catch (e) {
    if (e instanceof FilterError) return { refusal: { code: "REFUSED_FILTER", retryable: false, message: e.message } };
    throw e;
  }
}

// ── search and fetch: ChatGPT's shapes ───────────────────────────────────────

// ChatGPT compatibility: restricted connector surfaces, company knowledge, and deep
// research look for exact read-only `search` and `fetch` tool shapes.
//
// Hybrid (migration 017, SMD-958), not vector-only: this tool cannot grow a
// `mode` parameter without breaking the shape ChatGPT matches on, so it is the
// one surface that could never reach search_thoughts_keyword. For an
// identifier it got what 012 measured — the containing thought outside the
// top ten 37 times in 60. The fused function returns exactly what
// match_thoughts returned for any query without an identifier in it.
//
// Nor can it grow `recency_weight` (migration 020, SMD-945), so it sends a
// fixed one — 0, by measurement: on the 486-issue corpus a weight lowered
// MRR at every setting tried (0.899 → 0.894 at 0.1 over 365 days, 0.811 at
// 0.2 over 90; evals/eval-recency.ts), and this surface has no caller who
// can turn it off. An operator whose brain is a working log rather than a
// reference can ask search_thoughts for a weight; this tool stays where
// every result is the one the query names.
//
// Nor can it grow `prefer_current` (migration 059, SMD-2255), so it never
// demotes: on the topical task the demotion only costs (eval-supersession.ts:
// TOPICAL -0.127, a note under a Done ticket -0.292 and -0.524 once the
// window fills, a settled ticket looked up by its key -0.750 to -1.000), and
// this surface has no caller who can ask for it.
const SEARCH_COMPAT_RECENCY_WEIGHT = 0;
const SEARCH_COMPAT_PREFER_CURRENT = false;

export type SearchResult = { results: { id: string; title: string; url: string }[] };

export async function search(ctx: Ctx, principal: Principal, { query }: Input<"search">): Promise<Outcome<SearchResult>> {
  // The one search op, hybrid arm (SMD-1490); this surface is fixed, so it
  // pins every knob and exposes none — no filter (filter: {}), no caller
  // threshold (0, not 0.5, SMD-1300: admission is relative to the top match
  // since 027, so a low absolute floor lets it govern), and the fixed
  // recency weight above. runSearch gates the query (SMD-1903) and logs.
  const r = await runSearch(ctx, principal, { tool: "search", arm: "hybrid", query, limit: 10, threshold: 0, recencyWeight: SEARCH_COMPAT_RECENCY_WEIGHT, preferCurrent: SEARCH_COMPAT_PREFER_CURRENT, filter: {} });
  if (r.refusal) return refuse(r.refusal);
  return ok({
    results: r.rows.map((t) => ({
      id: t.id,
      title: thoughtTitle(t.content, t.created_at),
      url: thoughtUrl(ctx.citationBase(), t.id),
    })),
  });
}

export type FetchedThought = { id: string; title: string; text: string; url: string; metadata: Record<string, unknown> };

export async function fetchThought(ctx: Ctx, principal: Principal, { id }: Input<"fetch">): Promise<Outcome<FetchedThought>> {
  const thought = await (await ctx.store()).getThought(id);
  if (!thought) return refuse({ code: "NOT_FOUND", retryable: false, id });
  // Click-through relevance (034): the caller opened this id after a
  // search. Only on a hit — a fetch of a missing id labels nothing.
  await ctx.logActions(principal, [{ tool: "fetch", targetId: id }]);
  return ok({
    id: thought.id,
    title: thoughtTitle(thought.content, thought.created_at),
    text: thought.content,
    url: thoughtUrl(ctx.citationBase(), thought.id),
    metadata: {
      ...thought.metadata,
      created_at: thought.created_at,
      updated_at: thought.updated_at,
    },
  });
}

// ── search_thoughts and search_thoughts_keyword ──────────────────────────────

/** What the query was taken to mean — every hybrid row carries the same four. */
export type QueryFacts = Pick<ThoughtHybridMatch, "needles" | "needleCounts" | "commonNeedles" | "literalOnly">;
/** A hybrid hit, with the newer thought that supersedes it (025), if any. */
export type SearchHit = Pick<ThoughtHybridMatch, "id" | "content" | "metadata" | "created_at" | "similarity" | "matchedNeedles" | "score" | "fused" | "demoted"> & { supersededBy: string | null };
export type SearchThoughtsResult = {
  query: string;
  preferCurrent: boolean;
  hits: SearchHit[];
  /**
   * The query's facts: from the first hit, or — when nothing was returned —
   * from a one-row probe with no threshold, unfiltered, so the facts are the
   * query's and not the filtered scope's. Null when the brain had no row to
   * report them on.
   */
  facts: QueryFacts | null;
  /** prefer_current's window (059): what it held, for the header note. Null without the flag. */
  window: NonNullable<ThoughtHybridMatch["window"]> | null;
};

const factsOf = (r: ThoughtHybridMatch | undefined): QueryFacts | null =>
  r ? { needles: r.needles, needleCounts: r.needleCounts, commonNeedles: r.commonNeedles, literalOnly: r.literalOnly } : null;

export async function searchThoughts(ctx: Ctx, principal: Principal, input: Input<"search_thoughts">): Promise<Outcome<SearchThoughtsResult>> {
  const { query, limit, threshold, recency_weight, prefer_current } = input;
  // parseFilter refuses a shape jsonb should not run.
  const f = searchFilter(input);
  if ("refusal" in f) return refuse(f.refusal);
  // The one search op, hybrid arm (SMD-1490): it gates the query
  // (SMD-1903), embeds it, runs the filter and logs.
  const r = await runSearch(ctx, principal, { tool: "search_thoughts", arm: "hybrid", query, limit, threshold, recencyWeight: recency_weight, filter: f.filter, preferCurrent: prefer_current });
  if (r.refusal) return refuse(r.refusal);
  const data = r.rows;

  if (data.length === 0) {
    // Nothing cleared the threshold and no literal matched — but WHY is
    // worth saying, and the function reports it only on rows. One more
    // call with no threshold and one row returns the query-level facts
    // whenever the brain has any embedded thought at all (review pass:
    // the first version said "no thoughts found" about a literal that
    // 150 thoughts contained, because it was too common to match). Reuses
    // the arm's embedding, and stays unfiltered so the facts are the
    // query's, not the filtered scope's.
    const probe = await (await ctx.store()).hybridThoughts({ query, embedding: r.embedding, threshold: -1, limit: 1, filter: {} });
    return ok({ query, preferCurrent: prefer_current, hits: [], facts: factsOf(probe[0]), window: null });
  }

  // 025 (SMD-1253): which of these hits a newer thought has superseded,
  // and by which. One extra query; the labelling half of the retrieval
  // decision — the ranking half is prefer_current, opt-in (059,
  // SMD-2255), priced by eval-supersession.ts. A hit ranked beside the
  // version that replaced it is the failure this ticket is about — say so
  // on the row rather than let it pass as current.
  const superseded = await (await ctx.store()).supersededAmong(data.map((t) => t.id));
  return ok({
    query,
    preferCurrent: prefer_current,
    hits: data.map((t) => ({
      id: t.id, content: t.content, metadata: t.metadata, created_at: t.created_at, similarity: t.similarity,
      matchedNeedles: t.matchedNeedles, score: t.score, fused: t.fused, demoted: t.demoted,
      supersededBy: superseded[t.id] ?? null,
    })),
    facts: factsOf(data[0]),
    window: data[0].window ?? null,
  });
}

export type KeywordHit = Pick<ThoughtKeywordMatch, "id" | "content" | "metadata" | "created_at" | "occurrences">;
export type KeywordResult = { query: string; offset: number; total: number | null; hits: KeywordHit[] };

export async function searchThoughtsKeyword(ctx: Ctx, principal: Principal, input: Input<"search_thoughts_keyword">): Promise<Outcome<KeywordResult>> {
  const { query, limit, offset } = input;
  const f = searchFilter(input);
  if ("refusal" in f) return refuse(f.refusal);
  // The one search op, keyword arm (SMD-1490): no gate (a keyword search
  // embeds nothing, so nothing leaves the box), the filter applied inside
  // the scan, and — new since SMD-1490 — a query_log row written with
  // arm='keyword' (034 logged only the semantic path).
  const { rows } = await runSearch(ctx, principal, { tool: "search_thoughts_keyword", arm: "keyword", query, limit, offset, filter: f.filter });
  return ok({
    query,
    offset,
    // The whole match set, not the page: every row carries it. An empty first page is none; an empty later page (an offset past the end) says nothing of the set, so null (review pass 6).
    total: rows.length ? rows[0].totalCount : offset === 0 ? 0 : null,
    hits: rows.map((t) => ({ id: t.id, content: t.content, metadata: t.metadata, created_at: t.created_at, occurrences: t.occurrences })),
  });
}

// ── list_thoughts and list_supersession_proposals ────────────────────────────

export type ListedThought = ThoughtListItem & { supersededBy: string | null };
export type ListThoughtsResult = { thoughts: ListedThought[] };

export async function listThoughts(ctx: Ctx, _principal: Principal, { limit, type, topic, person, days, said_by, actor }: Input<"list_thoughts">): Promise<Outcome<ListThoughtsResult>> {
  const data = await (await ctx.store()).listThoughts({ limit, type, topic, person, days, saidBy: said_by, actor });
  if (!data.length) return ok({ thoughts: [] });
  // 025 (SMD-1253): mark the listed thoughts a newer thought supersedes,
  // and name the replacement — the same label search_thoughts prints.
  const superseded = await (await ctx.store()).supersededAmong(data.map((t) => t.id));
  return ok({ thoughts: data.map((t) => ({ ...t, supersededBy: superseded[t.id] ?? null })) });
}

export type ProposalsResult = { status: Input<"list_supersession_proposals">["status"]; lineage?: boolean; proposals: SupersessionProposal[] };

export async function listSupersessionProposals(ctx: Ctx, _principal: Principal, { status, limit, lineage }: Input<"list_supersession_proposals">): Promise<Outcome<ProposalsResult>> {
  const proposals = await (await ctx.store()).listSupersessionProposals({ status: status === "all" ? null : status, limit, ...(lineage === undefined ? {} : { lineage }) });
  return ok({ status, ...(lineage === undefined ? {} : { lineage }), proposals });
}

// ── thought_stats and thought_changes ────────────────────────────────────────

export async function thoughtStats(ctx: Ctx, _principal: Principal, _input: Input<"thought_stats">): Promise<Outcome<ThoughtStats>> {
  // The store aggregates. On the SQL path that is migration 024's
  // thought_stats_summary() over the whole corpus in one statement; on
  // PostgREST it is the capped page walk. Either way we get the total, the
  // date range, and the count maps, plus how many rows the breakdowns
  // actually cover. (See store.ts:ThoughtStats.)
  return ok(await (await ctx.store()).statsSummary());
}

/**
 * thought_changes's `since` (SMD-1296): a uuid is a cursor — the audit row a
 * previous page ended with — and anything else must read as an ISO-8601 time
 * (a date at least, so a bare number is not a year), normalised so the reply
 * echoes one spelling. Neither is a refusal, before any call; `value` is the
 * trimmed text refused.
 */
export function parseSince(raw: string | undefined): { since: string | null; after: string | null } | { refused: string } {
  const v = (raw ?? "").trim();
  if (v === "") return { since: null, after: null };
  if (UUID_RE.test(v)) return { since: null, after: v.toLowerCase() };
  const refused = { refused: v };
  // A date, or a date with a clock that names its zone — a clock with no Z or
  // offset would be read in the server's zone (13:00Z for 08:00 on a Chicago
  // laptop, 08:00Z in the container). Any ISO-8601 fraction (Python's
  // isoformat gives six digits) and an hour-only offset (psql prints `+00`)
  // are normalised to what Date parses: a T, three fraction digits, a colon in
  // the offset — completed only when the shape has one, since a bare date's
  // own `-01` is a day, not a zone.
  const shape = /^(\d{4}-\d{2}-\d{2})(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(Z|[+-]\d{2}(?::?\d{2})?))?$/i.exec(v);
  if (!shape) return refused;
  // Upper-cased: the shape is matched case-blind, and a lowercase t or z is
  // ISO-8601 to JSC (Bun) but not to every Date parser the server runs on.
  let iso = v.toUpperCase().replace(" ", "T").replace(/(\.\d{3})\d+/, "$1");
  if (shape[2] && !/^z$/i.test(shape[2])) iso = iso.replace(/([+-]\d{2})(\d{2})$/, "$1:$2").replace(/([+-]\d{2})$/, "$1:00");
  const d = new Date(iso);
  // The date part round-trips on its own, whatever the clock or zone beside it
  // (2026-02-30 would otherwise slide to March, at any hour), and the year
  // stays where timestamptz has room: a late time with an offset rolls past
  // 9999, an early one below 1, and either would come back as Postgres's raw
  // error (review passes 1–3).
  const day = new Date(`${shape[1]}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || Number.isNaN(day.getTime()) || day.toISOString().slice(0, 10) !== shape[1]) return refused;
  if (d.getUTCFullYear() < 1 || d.getUTCFullYear() > 9999) return refused;
  return { since: d.toISOString(), after: null };
}

export type ChangesResult = {
  /** The page, oldest first. */
  changes: AuditChange[];
  /** Whether more changes follow the page (bounded) or precede it (unbounded). */
  more: boolean;
  /** Bounded — from a time or a cursor — pages forward; unbounded is the newest changes. */
  bounded: boolean;
  since: string | null;
  after: string | null;
  /** The writer asked for, trimmed; null for every writer. */
  agent: string | null;
  /** The writer left out (others_only: the caller's own key); null for none. */
  notAgent: string | null;
  /** The kinds of change asked for, deduplicated; null for every kind. */
  actions: AuditChange["action"][] | null;
  /** The `since` that continues from here: the last change's id, or on an empty page the cursor that was passed (the text says keep it; review pass 6); null for an empty page with no cursor. */
  cursor: string | null;
};

export async function thoughtChanges(ctx: Ctx, principal: Principal, { since, others_only, agent, actions, limit }: Input<"thought_changes">): Promise<Outcome<ChangesResult>> {
  // `since` is decided here, before any call: a uuid is a cursor, anything
  // else must read as a time, and a word that is neither is refused naming
  // both forms rather than surfacing as a Postgres cast error.
  const start = parseSince(since);
  if ("refused" in start) return refuse({ code: "REFUSED_SINCE", retryable: false, value: start.refused });
  const name = agent?.trim() || null;
  const notAgent = others_only ? principal.name : null;
  const kinds = actions?.length ? [...new Set(actions)] : null;
  // Bounded — from a time or a cursor — the function pages forward; with
  // no bound it returns the newest rows.
  const bounded = start.since !== null || start.after !== null;
  // One more than shown, so the reply can say whether more follow
  // without a count query; the function caps at 201.
  const rows = await (await ctx.store()).listChanges({
    since: start.since,
    after: start.after,
    agent: name,
    notAgent,
    actions: kinds,
    limit: limit + 1,
  });
  const more = rows.length > limit;
  // Forward from a bound the extra row is the NEWEST, past the page; with
  // no bound the function returns the newest limit+1 oldest first, so the
  // extra row is the OLDEST — slicing the same end would drop the latest
  // change, the one a resumer most needs (caught: cold-read, pass 1).
  const shown = !more ? rows : bounded ? rows.slice(0, limit) : rows.slice(1);
  return ok({
    changes: shown, more, bounded, since: start.since, after: start.after, agent: name, notAgent, actions: kinds,
    cursor: shown.length ? shown[shown.length - 1].id : start.after,
  });
}

// ── list_thought_ids, list_logged_searches, worker_status ────────────────────

export async function listThoughtIds(ctx: Ctx, _principal: Principal, { limit, after }: Input<"list_thought_ids">): Promise<Outcome<ThoughtIdPage>> {
  if (after !== undefined && !UUID_RE.test(after)) return refuse({ code: "REFUSED_CURSOR", retryable: false, value: after });
  return ok(await (await ctx.store()).listThoughtIds({ limit, after: after ?? null }));
}

export async function listLoggedSearches(ctx: Ctx, _principal: Principal, { since, limit }: Input<"list_logged_searches">): Promise<Outcome<LoggedSearchPage>> {
  if (since !== undefined && Number.isNaN(Date.parse(since))) return refuse({ code: "REFUSED_SINCE", retryable: false, value: since });
  return ok(await (await ctx.store()).listLoggedSearches({ since: since ?? null, limit }));
}

/** The pools, under a key: a JSON result is an object (an array is wrapped by the MCP wire codec, SEP-2106). */
export type WorkerStatusResult = { pools: WorkerStatusRow[] };

export async function workerStatus(ctx: Ctx, _principal: Principal, _input: Input<"worker_status">): Promise<Outcome<WorkerStatusResult>> {
  return ok({ pools: await (await ctx.store()).workerStatus() });
}

// ── brain_info ───────────────────────────────────────────────────────────────

// Bounded (review pass 1: a keyed probe at an unreachable database waited out
// the driver's 30-second connect and got no reply). The health body answers
// within a probe's usual timeout — its statements capped to fit, so a few
// locked tables cost their lock waits and not the whole record (review pass
// 2); the tool, kept alive by its stream (SMD-1864), waits longer for a large
// brain's counts, at brain-info.ts's default ceilings.
export const HEALTH_DEADLINE_MS = 2_500;
export const BRAIN_INFO_TOOL_DEADLINE_MS = 15_000;
export type BrainInfoSurface = "health" | "tool";
const SURFACES: Record<BrainInfoSurface, { deadlineMs: number; opts: ReadOptions }> = {
  health: { deadlineMs: HEALTH_DEADLINE_MS, opts: { statementTimeoutMs: 800, lockTimeoutMs: 300 } },
  tool: { deadlineMs: BRAIN_INFO_TOOL_DEADLINE_MS, opts: {} },
};

// What this brain is (SMD-2041): the server's own facts beside the database's,
// one read under the brain_info tool and the keyed /health body.
function serverFacts(ctx: Ctx): ServerFacts {
  const cfg = ctx.embedConfig();
  return {
    version: FORK_VERSION,
    releaseRange: RELEASE_RANGE,
    latestMigration: LATEST_MIGRATION,
    commit: ctx.env().OB1_GIT_SHA || "unknown",
    store: storeKind(ctx.env()),
    tier: ctx.env().OB1_TIER || null,
    embedding: { model: cfg.embeddingModel, dim: cfg.embeddingDim },
  };
}

/**
 * The brain-info read for one surface. One read in flight per surface, so
 * concurrent callers share one pool connection rather than taking one each
 * (forty probes against a locked table once held the pool). Keyed by surface,
 * so a probe never gets the tool's deadline and ceilings. Released when the
 * answer settles: an abandoned read finishes its last statement within its
 * ceiling (800 ms for health) beside the next caller's, and a read hung on a
 * half-open connection pins nothing. brainInfo never raises: a database that
 * cannot answer is a field of the record.
 *
 * Shared per store instance, not per core (review passes 2–3): the reads in
 * flight are keyed by the store a core's reader resolves to, so a second core
 * in the same process (the REST core beside the MCP one, SMD-2284) joins the
 * first's read whatever reader it was handed — `db`, `() => db()` — rather
 * than taking a pool connection of its own. A process has one environment, so
 * the joined read's server facts are the joiner's too. A store that cannot be
 * built has no instance to key on; its read runs alone, and the record says
 * why the database could not answer.
 */
const INFLIGHT = new WeakMap<object, Map<BrainInfoSurface, Promise<BrainInfo>>>();
export function brainInfoReader(ctx: Ctx): (surface: BrainInfoSurface) => Promise<BrainInfo> {
  return async (surface) => {
    const { deadlineMs, opts } = SURFACES[surface];
    const read = () => readBrain(serverFacts(ctx), async (progress) => (await ctx.store()).databaseFacts(opts, progress), deadlineMs);
    // Not shared on Workers (the PostgREST store): its read is a refusal with no
    // I/O to share, and a promise from one request is not another's to await.
    if (storeKind(ctx.env()) !== "sql") return read();
    const store = await ctx.store().catch(() => null);
    if (!store) return read();
    const inflight = INFLIGHT.get(store) ?? new Map<BrainInfoSurface, Promise<BrainInfo>>();
    INFLIGHT.set(store, inflight);
    const shared = inflight.get(surface);
    if (shared) return shared;
    const answer = read().finally(() => { if (inflight.get(surface) === answer) inflight.delete(surface); });
    inflight.set(surface, answer);
    return answer;
  };
}

// ── job_status and scan_thoughts (SMD-2273) ──────────────────────────────────

export async function jobStatus(_ctx: Ctx, principal: Principal, { job_id }: Input<"job_status">): Promise<Outcome<PublicJob>> {
  // Ownership-scoped: a job is visible only to the key that started it, so a
  // wrong id or another key's job reads as not found.
  const job = await readJob(principal, job_id);
  return job ? ok(job) : refuse({ code: "NOT_FOUND", retryable: false, id: job_id });
}

/**
 * The reference async job: a bounded, paged scan of the corpus that returns a
 * job HANDLE at once. It walks pageThoughtMeta in pages up to `limit`,
 * tallying metadata coverage and a breakdown by type, reporting progress per
 * page. `track` wraps the detached run so the server's stop waits for it.
 */
export async function scanThoughts(ctx: Ctx, principal: Principal, { limit }: Input<"scan_thoughts">, opts: Pick<StartJobOptions, "track"> = {}): Promise<Outcome<JobHandle>> {
  const cap = Math.min(limit ?? SCAN_DEFAULT, SCAN_MAX);
  return ok(startJob(principal, "scan_thoughts", async (job) => {
    const store = await ctx.store();
    const total = Math.min(await store.countThoughts(), cap);
    let scanned = 0;
    let withCreatedAt = 0;
    const byType: Record<string, number> = {};
    const PAGE = 200;
    for (let offset = 0; offset < total; offset += PAGE) {
      if (job.signal.aborted) break;
      const page = await store.pageThoughtMeta(offset, Math.min(PAGE, total - offset));
      if (page.length === 0) break;
      for (const row of page) {
        scanned++;
        if (row.created_at !== null) withCreatedAt++;
        const type = typeof row.metadata.type === "string" ? row.metadata.type : "(none)";
        byType[type] = (byType[type] ?? 0) + 1;
      }
      job.progress(scanned, total);
    }
    return { scanned, total, withCreatedAt, byType };
  }, { track: opts.track }));
}
