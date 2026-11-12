// The read operations (SMD-2283): what the read tools did inside their MCP
// closures, as functions of a principal and a typed input. Each returns the
// typed value or a typed refusal (core/refusal.ts) and throws a fault; none
// knows MCP or writes a sentence — the MCP registration renders the value in
// the words it always has, and the REST core (SMD-2284) answers it as JSON.

import { thoughtTitle, thoughtUrl } from "../thoughts.ts";
import { mayLeaveBox, type EgressSubject } from "../egress.ts";
import { providerDown, shownBase } from "../embed.ts";
import { heardFrom } from "../provider-health.ts";
import { ListCursorRefused, RELATIONS_FETCHED, storeKind, UUID_RE, type AuditChange, type EffectivePriority, type PriorityTerm, type PriorityWeights, type ListPosition, type ListSort, type LoggedSearchPage, type SupersessionProposal, type ThoughtHybridMatch, type ThoughtIdPage, type ThoughtKeywordMatch, type ThoughtListItem, type ThoughtStats, type ThoughtStore, type WorkerStatusRow } from "../store.ts";
import { keysInOrder, MOVED_READ, movedAmong, typesOf, type Moved, type MovedHit, type MovedType } from "../stated-status.ts";
import { readJob, startJob, type JobHandle, type PublicJob, type StartJobOptions } from "../jobs.ts";
import { brainInfo as readBrain, taskStates, type BrainInfo, type ReadOptions, type ServerFacts, type TaskStatusResult } from "../brain-info.ts";
import { BRAIN_VERSION, LATEST_MIGRATION, RELEASE_RANGE } from "../version.ts";
import { BRAIN_INFO_TOOL_DEADLINE_MS, HEALTH_DEADLINE_MS } from "../deadlines.ts";
import { canRead, type Principal } from "../auth.ts";
import type { Ctx } from "./context.ts";
import { embeddingProviderError, providerLogWords } from "./provider-refusal.ts";
import { FilterError, parseFilter, trustAtOrAbove, withActorFilter, type Trust } from "./filter.ts";
import { ok, refuse, type Outcome, type Refusal } from "./refusal.ts";
import { listCursor, parseListCursor, parseProposalCursor, proposalCursor, sameSelection, type ProposalSelection } from "./list-cursor.ts";
import { parseSince } from "./since.ts";
import { fetchedThreads, type FetchedThread } from "./threads.ts";
import { relationsLabel, relationsOf, relationsResult } from "./relations.ts";
import { SCAN_DEFAULT, SCAN_MAX, type Input } from "./schemas.ts";
import { weightsRefused } from "./weights.ts";

// ── The one search operation ─────────────────────────────────────────────────

/**
 * A query the embedding provider did not answer for (SMD-2891): what
 * providerDown read — its marker word and its words, never the text — the
 * endpoint the call went to, which the reply names, and what was matched
 * without a vector: the query's literals (the hybrid's exact-literal arm);
 * then, those matching nothing, the whole query as one text, as
 * search_thoughts_keyword matches it (review pass 4, the maintainer's call;
 * pass 5: whether or not the query held a literal); or nothing — no literal,
 * and a query too short or only common words to match as text.
 */
export type QueryVectorFailed = { reason: string; detail: string; base: string; matched: "literals" | "text" | "none" };

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
  // An embedding of null is a query the provider did not answer for, and
  // vectorFailed says why (SMD-2891).
  (ctx: Ctx, principal: Principal, opts: { tool: string; arm: "hybrid"; query: string; limit: number; threshold: number; recencyWeight: number; filter: Record<string, unknown>; preferCurrent?: boolean; minTrust?: Trust; unlogged?: boolean; signal?: AbortSignal }):
    Promise<Refused | { refusal?: undefined; rows: ThoughtHybridMatch[]; embedding: number[] | null; vectorFailed?: QueryVectorFailed; facts?: QueryFacts }>;
  (ctx: Ctx, principal: Principal, opts: { tool: string; arm: "keyword"; query: string; limit: number; offset: number; filter: Record<string, unknown>; minTrust?: Trust }):
    Promise<{ refusal?: undefined; rows: ThoughtKeywordMatch[] }>;
}
export const runSearch: RunSearch = (async (ctx: Ctx, principal: Principal, opts: {
  tool: string; arm: "hybrid" | "keyword"; query: string; limit: number;
  threshold?: number; recencyWeight?: number; offset?: number; filter: Record<string, unknown>; preferCurrent?: boolean; minTrust?: Trust; unlogged?: boolean; signal?: AbortSignal;
}): Promise<{ refusal?: Refusal; rows: (ThoughtHybridMatch | ThoughtKeywordMatch)[]; embedding?: number[] | null; vectorFailed?: QueryVectorFailed; facts?: QueryFacts }> => {
  // min_trust (SMD-1724) is no column of query_log, so a search with it is not
  // logged: a replay (db/tier.ts) would run it without the floor and report
  // the rows it kept out as a difference (the maintainer's call; the column is
  // SMD-2479). Every logged row replays as it ran. A priority-ranked search
  // (SMD-3668: priority_weight, min_priority) is not logged for the same
  // reason, and the window it reads is no row's limit either (`unlogged`).
  const logged = opts.minTrust === undefined && opts.unlogged !== true;
  if (opts.arm === "keyword") {
    const rows = await (await ctx.store()).keywordThoughts({ query: opts.query, limit: opts.limit, offset: opts.offset ?? 0, filter: opts.filter, minTrust: opts.minTrust });
    // A keyword search takes no threshold or recency weight; log them as the
    // compat `search` does its fixed zeros, so the column is a number not a NULL.
    if (logged) await ctx.logSearch(principal, opts.tool, { query: opts.query, limit: opts.limit, threshold: 0, recencyWeight: 0, filter: opts.filter, arm: "keyword" }, rows);
    return { rows };
  }
  // The query text leaves for its embedding as a thought's does (SMD-1903).
  const q = gateQuery(ctx, opts.query, principal);
  if (q.refusal) return { refusal: q.refusal, rows: [] };
  // A provider that did not answer (refused, timed out, 5xx — providerDown)
  // leaves the search what needs no model (answerWithoutVector, SMD-2891).
  // Any other failure — a 4xx, a width mismatch — still fails the search, so
  // a misconfigured brain says so, as a capture does (SMD-2888).
  let embedding: number[];
  const embedStarted = performance.now();
  try {
    embedding = await ctx.embedder.getEmbedding(opts.query, q.subject, "query", opts.signal);
  } catch (e) {
    // The caller's own stop (plan_context's deadline, SMD-2684): answered as a provider that did not answer in time,
    // by exact matches alone, and not said of the provider's health — the provider was not what stopped.
    const stopped = opts.signal?.aborted === true;
    const down = stopped ? { reason: "deadline", detail: "the read's deadline came before the provider answered" } : providerDown(e);
    if (!down) {
      heardFrom(ctx.providerHealth, embedStarted, e);
      // The provider's other answers — a credential refused, a model not there, a body that is not JSON — refuse the
      // search, coded and final, and the provider's words go to the log (SMD-2892); anything else is still a fault.
      const refused = embeddingProviderError(e, ctx.embedConfig().embeddings, canRead(principal));
      if (!refused) throw e;
      console.error(`${opts.tool}: the embedding provider at ${shownBase(ctx.embedConfig().embeddings)} refused the query's embedding: ${providerLogWords(e, ctx.embedConfig().embeddings)}`);
      return { refusal: refused, rows: [] };
    }
    // As a row prints an endpoint: userinfo masked (SMD-2885).
    const base = shownBase(ctx.embedConfig().embeddings);
    console.error(stopped ? `${opts.tool}: the embedding provider at ${base} did not answer before the caller's deadline; answered by exact matches alone`
      : `${opts.tool}: the embedding provider at ${base} was unavailable: ${down.detail}; answered by exact matches alone`);
    // The provider's state, as every embedding call tells it (SMD-2890) — not when the caller stopped the call.
    if (!stopped) heardFrom(ctx.providerHealth, embedStarted, e);
    const a = await answerWithoutVector(await ctx.store(), opts, { ...down, base });
    // Logged as arm `literal` (106): no arm a replay could take, since a
    // replay's provider answers; db/brain-compare.ts leaves it out of a plan.
    if (logged) await ctx.logSearch(principal, opts.tool, { query: opts.query, limit: opts.limit, threshold: opts.threshold ?? 0, recencyWeight: opts.recencyWeight ?? 0, filter: opts.filter, arm: "literal" }, a.rows);
    return { rows: a.rows, embedding: null, vectorFailed: a.vectorFailed, ...(a.facts ? { facts: a.facts } : {}) };
  }
  // Answered: the provider's state says so (SMD-2890).
  heardFrom(ctx.providerHealth, embedStarted);
  // prefer_current (059, SMD-2255) is the same arm through another function,
  // logged as arm `current` so a replay takes the same one.
  const preferCurrent = opts.preferCurrent === true;
  const rows = await (await ctx.store()).hybridThoughts({
    query: opts.query, embedding, threshold: opts.threshold ?? 0, limit: opts.limit,
    filter: opts.filter, recencyWeight: opts.recencyWeight ?? 0, preferCurrent, minTrust: opts.minTrust,
  });
  if (logged) await ctx.logSearch(principal, opts.tool, { query: opts.query, limit: opts.limit, threshold: opts.threshold ?? 0, recencyWeight: opts.recencyWeight ?? 0, filter: opts.filter, arm: preferCurrent ? "current" : "hybrid" }, rows);
  return { rows, embedding };
}) as RunSearch;

/**
 * A search with no query vector (SMD-2891). First the hybrid function with
 * none — its exact-literal arm, filter, floor and prefer_current as ever.
 * Then, that matching nothing, the query as one text (trimmed; 3 to 64
 * characters and a word the English parser keeps — 017's rule for a span)
 * through the bounded textThoughts, its order newest first, prefer_current
 * ranking none of it. Otherwise nothing could be matched.
 *
 * With nothing found, why, first fact first: a literal some thought outside
 * a filtered search's scope holds (the hybrid's unfiltered probe); the text
 * held only outside the scope; each literal absent or too common — which is
 * all a literal can be once no unfiltered search matched it, so
 * literalFacts reads rarity alone; the text held by none.
 */
async function answerWithoutVector(
  store: ThoughtStore,
  opts: { query: string; limit: number; threshold?: number; recencyWeight?: number; filter: Record<string, unknown>; preferCurrent?: boolean; minTrust?: Trust },
  failed: { reason: string; detail: string; base: string },
): Promise<{ rows: ThoughtHybridMatch[]; vectorFailed: QueryVectorFailed; facts?: QueryFacts }> {
  // One text for every statement: the query without the whitespace at its
  // ends, which no reader sees — JS trims a no-break space or a BOM that
  // 017's tokeniser keeps, and a literal arm on the untrimmed query read
  // " XY_2" while literalFacts read "XY_2" (review pass 11). NEL (U+0085)
  // too, which Unicode calls whitespace and neither JS's \s nor 017's strips;
  // and a lone surrogate made the U+FFFD Postgres receives, so a reply shows
  // the text it searched (review pass 12).
  const text = opts.query
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "\uFFFD")
    .replace(/^[\s\u0085]+|[\s\u0085]+$/g, "");
  const rows = await store.hybridThoughts({
    query: text, embedding: null, threshold: opts.threshold ?? 0, limit: opts.limit,
    filter: opts.filter, recencyWeight: opts.recencyWeight ?? 0, preferCurrent: opts.preferCurrent === true, minTrust: opts.minTrust,
  });
  if (rows.length > 0) return { rows, vectorFailed: { ...failed, matched: "literals" } };
  const { literals, textable } = await store.literalFacts(text);
  const vectorFailed: QueryVectorFailed = { ...failed, matched: textable ? "text" : literals.length > 0 ? "literals" : "none" };
  if (textable) {
    // A literal too common to match exactly is why the text was asked; its rows say so.
    const common = literals.filter((l) => l.common).map((l) => l.needle);
    const kw = await store.textThoughts({ query: text, limit: opts.limit, filter: opts.filter, minTrust: opts.minTrust });
    if (kw.length > 0) return { rows: kw.map((k) => textRow(k, text, common)), vectorFailed };
  }
  const scoped = Object.keys(opts.filter).length > 0 || opts.minTrust !== undefined;
  // The probe finds a row only for a literal neither absent nor too common, so it runs only when literalFacts leaves one possible.
  const probe = scoped && literals.some((l) => !l.common) ? (await store.hybridThoughts({ query: text, embedding: null, threshold: -1, limit: 1, filter: {} }))[0] : undefined;
  if (probe) return { rows: [], vectorFailed, facts: { ...factsOf(probe)!, literalOnly: null } };
  const outside = textable && scoped ? ((await store.textThoughts({ query: text, limit: 1, filter: {} }))[0]?.totalCount ?? 0) : 0;
  const facts: QueryFacts = outside > 0 ? { needles: [text], needleCounts: [outside], commonNeedles: [], literalOnly: null }
    : literals.length > 0 ? factsFromLiterals(literals)
    : { needles: textable ? [text] : [], needleCounts: textable ? [0] : [], commonNeedles: [], literalOnly: null };
  return { rows: [], vectorFailed, facts };
}

/** A keyword row as a hybrid one, the whole query its one literal (SMD-2891): no similarity, no score; the count the keyword arm's own, and the query's too-common literals beside it. */
function textRow(k: ThoughtKeywordMatch, query: string, common: string[]): ThoughtHybridMatch {
  return { id: k.id, content: k.content, metadata: k.metadata, created_at: k.created_at, similarity: null, matchedNeedles: [query], needles: [query], needleCounts: [k.totalCount], commonNeedles: common, literalOnly: false, score: 0, fused: 0, demoted: [] };
}

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
//
// It does carry the stated-status label (SMD-2540), as search_thoughts does:
// a label moves no rank, and the maintainer's call is the title AND a field —
// the title because it is what every ChatGPT surface hands the model, the
// field for a reader that reads the shape (render.ts).
const SEARCH_COMPAT_RECENCY_WEIGHT = 0;
const SEARCH_COMPAT_PREFER_CURRENT = false;

/**
 * ChatGPT's search shape, with each result's trust (SMD-1724) and, where a
 * ticket it names moved, its moved tickets (SMD-2540) beside it — render.ts
 * marks the title with both and sends the shape, `moved` only where one moved.
 * Absent, not empty, elsewhere: an MCP server older than this REST core passes
 * an unknown field through, and then only the results it is about carry it.
 */
export type SearchResult = {
  results: ({ id: string; title: string; url: string; trust: unknown; moved?: MovedType[]; movedNotRead?: number } & ReturnType<typeof claimedResult> & ReturnType<typeof priorityResult>)[];
  /** Present only when the provider did not answer for the query, and the results are its exact matches alone (SMD-2891); with none, the search is refused EMBEDDING_PROVIDER_UNAVAILABLE. */
  vectorFailed?: QueryVectorFailed;
};

export async function search(ctx: Ctx, principal: Principal, { query }: Input<"search">): Promise<Outcome<SearchResult>> {
  // The one search op, hybrid arm (SMD-1490); this surface is fixed, so it
  // pins every knob and exposes none — no filter (filter: {}), no caller
  // threshold (0, not 0.5, SMD-1300: admission is relative to the top match
  // since 027, so a low absolute floor lets it govern), and the fixed
  // recency weight above. runSearch gates the query (SMD-1903) and logs.
  const r = await runSearch(ctx, principal, { tool: "search", arm: "hybrid", query, limit: 10, threshold: 0, recencyWeight: SEARCH_COMPAT_RECENCY_WEIGHT, preferCurrent: SEARCH_COMPAT_PREFER_CURRENT, filter: {} });
  if (r.refusal) return refuse(r.refusal);
  // Nothing answered without a vector: refused, as the outage was before
  // (review pass 4, the maintainer's call) — an empty list reads as "nothing
  // stored" on a surface that shows results alone — saying what was matched
  // and of each literal whether it is absent or too common (review pass 2).
  if (r.vectorFailed && r.rows.length === 0) {
    const f = r.facts ?? { needles: [], needleCounts: [], commonNeedles: [], literalOnly: null };
    return refuse({ code: "EMBEDDING_PROVIDER_UNAVAILABLE", retryable: true, reason: r.vectorFailed.reason, detail: r.vectorFailed.detail, base: r.vectorFailed.base, matched: r.vectorFailed.matched,
      needles: f.needles.filter((_, i) => f.needleCounts[i] === 0), commonNeedles: f.commonNeedles });
  }
  const store = await ctx.store();
  // No relations here (review pass 1, the maintainer's call): ChatGPT's search shape is a list to fetch from, and fetch
  // carries them.
  const [moved, claimed, priority] = await Promise.all([movedOf(store, r.rows, null), claimedOf(store, principal, r.rows), priorityOf(store, r.rows)]);
  return ok({
    results: r.rows.map((t) => ({
      id: t.id,
      title: thoughtTitle(t.content, t.created_at),
      url: thoughtUrl(ctx.citationBase(), t.id),
      trust: t.metadata?.trust,
      ...resultLabel(moved[t.id]),
      ...claimedResult(claimed, t.id),
      ...priorityResult(priority, t.id),
    })),
    ...(r.vectorFailed ? { vectorFailed: r.vectorFailed } : {}),
  });
}

/**
 * fetch's thought: ChatGPT's compat shape, its claims where a ticket it names is claimed, and `threads` where it stands
 * in a work thread (SMD-3306 PR 7a-2a) — the thought it continues and the one continuing it in each, null when they
 * could not be read.
 */
export type FetchedThought = { id: string; title: string; text: string; url: string; metadata: Record<string, unknown>; threads?: FetchedThread[] | null } & ReturnType<typeof claimedResult> & ReturnType<typeof relationsResult> & ReturnType<typeof priorityResult>;

export async function fetchThought(ctx: Ctx, principal: Principal, { id }: Input<"fetch">): Promise<Outcome<FetchedThought>> {
  const store = await ctx.store();
  const thought = await store.getThought(id);
  if (!thought) return refuse({ code: "NOT_FOUND", retryable: false, id });
  // Click-through relevance (034): the caller opened this id after a
  // search. Only on a hit — a fetch of a missing id labels nothing.
  const [, claimed, threads, related, priority] = await Promise.all([ctx.logActions(principal, [{ tool: "fetch", targetId: id }]), claimedOf(store, principal, [thought]), fetchedThreads(store, thought.id), relationsOf(store, [thought], RELATIONS_FETCHED, true), priorityOf(store, [thought])]);
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
    ...claimedResult(claimed, thought.id),
    // SMD-2726: its judged relations, only where it has some, as `claimed` rides.
    ...relationsResult(related, thought.id),
    ...priorityResult(priority, thought.id),
    // Only where it stands in a thread, or the read failed: a thought in none adds nothing to ChatGPT's shape.
    ...(threads === null || threads.length > 0 ? { threads } : {}),
  });
}

// ── search_thoughts and search_thoughts_keyword ──────────────────────────────

/**
 * What the query was taken to mean — every hybrid row carries the same four.
 * literalOnly is null for a search answered without a vector (SMD-2891): a
 * text match, or facts read by answerWithoutVector.
 */
export type QueryFacts = Pick<ThoughtHybridMatch, "needles" | "needleCounts" | "commonNeedles"> & { literalOnly: boolean | null };
/**
 * A hybrid hit, with the newer thought that supersedes it (025), if any, and
 * the tickets it names that moved since it was written (095, SMD-2540):
 * `moved` null when they were not checked (superseded, a ticket row or a note
 * under one, no written time, a brain before 095), empty when checked and none
 * moved or it names none; `movedNotRead` the keys past the first 50, not checked.
 */
export type SearchHit = Pick<ThoughtHybridMatch, "id" | "content" | "metadata" | "created_at" | "similarity" | "matchedNeedles" | "score" | "fused" | "demoted"> & { supersededBy: string | null; moved: Moved[] | null; movedNotRead: number } & ReturnType<typeof claimedLabel> & ReturnType<typeof relationsLabel> & ReturnType<typeof priorityLabel>;
export type SearchThoughtsResult = {
  query: string;
  preferCurrent: boolean;
  hits: SearchHit[];
  /**
   * The query's facts: from the first hit, or — when nothing was returned —
   * from a one-row probe with no threshold, unfiltered, so the facts are the
   * query's and not the filtered scope's; null when the brain had no row to
   * report them on. Without a vector, answerWithoutVector's, never null.
   */
  facts: QueryFacts | null;
  /** prefer_current's window (059): what it held, for the header note. Null without the flag. */
  window: NonNullable<ThoughtHybridMatch["window"]> | null;
  /** The priority ranking (SMD-3668): its weight and floor, the window it read and what it kept. Null with neither set. */
  priority: PriorityRanking | null;
  /** Present only when the provider did not answer for the query, and the hits are its exact matches alone (SMD-2891). */
  vectorFailed?: QueryVectorFailed;
};

const factsOf = (r: ThoughtHybridMatch | undefined): QueryFacts | null =>
  r ? { needles: r.needles, needleCounts: r.needleCounts, commonNeedles: r.commonNeedles, literalOnly: r.literalOnly } : null;

/**
 * The query's facts when no row reports them and no vector was made
 * (SMD-2891), in the hybrid's own terms: read only once no unfiltered search
 * matched a literal, so a literal is absent — a needle counted 0 — or too
 * common, a common needle alone, as the hybrid never lists a common one among
 * its needles.
 */
function factsFromLiterals(lits: { needle: string; common: boolean }[]): QueryFacts {
  const absent = lits.filter((l) => !l.common).map((l) => l.needle);
  return { needles: absent, needleCounts: absent.map(() => 0), commonNeedles: lits.filter((l) => l.common).map((l) => l.needle), literalOnly: null };
}

/**
 * The stated-status label (SMD-2540): per hit, the tickets it names whose
 * status moved since it was written — moved-session-settled, the reading
 * evals/eval-stated-status.ts measured (stated-status.ts). It labels and never
 * ranks. Read only when a hit names a ticket: then which hits are superseded
 * (`superseded`, or one query when the caller has not read it) and one query
 * for the rest's lifecycles and tickets. Best-effort, as supersededAmong: a
 * brain before 095, or a role without ob1_config, labels nothing and the
 * search goes on.
 */
/** A search_thoughts hit's label fields: `[]` when it names no ticket, null when its tickets were not checked, the unread keys counted. */
export const hitLabel = (content: string, checked: MovedHit | undefined): { moved: Moved[] | null; movedNotRead: number } =>
  ({ moved: keysInOrder(content).length === 0 ? [] : (checked?.moved ?? null), movedNotRead: checked?.notRead ?? 0 });

/**
 * A compat result's label fields, only where a ticket moved, in status types:
 * an MCP server older than this REST core passes them through to ChatGPT as
 * they stand (review pass 5), so no board name and no empty field.
 */
export const resultLabel = (checked: MovedHit | undefined): { moved?: MovedType[]; movedNotRead?: number } =>
  checked?.moved.length ? { moved: typesOf(checked.moved), ...(checked.notRead > 0 ? { movedNotRead: checked.notRead } : {}) } : {};

export async function movedOf(store: Pick<ThoughtStore, "supersededAmong" | "ticketStatusInputs">, hits: readonly Pick<ThoughtHybridMatch, "id" | "content" | "created_at" | "metadata">[], superseded: Record<string, string> | null): Promise<Record<string, MovedHit>> {
  // A ticket row tells its own status and is never labelled (movedAmong): its keys are not sent.
  const naming = hits.filter((h) => h.metadata?.issue === undefined && keysInOrder(h.content).length > 0);
  if (naming.length === 0) return {};
  // Each hit's first MOVED_READ keys mentioned (stated-status.ts): 095's call grows with the keys sent.
  const keysOf = (rows: typeof naming) => [...new Set(rows.flatMap((h) => keysInOrder(h.content).slice(0, MOVED_READ)))];
  if (superseded === null) {
    // search has not read supersession: both reads at once (review pass 7), the superseded hits' keys
    // sent too and their rows left out by movedAmong.
    const [over, inputs] = await Promise.all([store.supersededAmong(naming.map((h) => h.id)), store.ticketStatusInputs(naming.map((h) => h.id), keysOf(naming))]);
    return inputs ? movedAmong(naming, over, inputs) : {};
  }
  // Only the unsuperseded hits' tickets are read; movedAmong leaves the superseded ones out.
  const open = naming.filter((h) => !superseded[h.id]);
  const tickets = keysOf(open);
  if (tickets.length === 0) return {};
  const inputs = await store.ticketStatusInputs(open.map((h) => h.id), tickets);
  return inputs ? movedAmong(naming, superseded, inputs) : {};
}

/**
 * An unreleased work claim on a ticket a result names (SMD-3599), as the result carries it: the claim's id, the ticket
 * and piece, its holder's key and whether that is the caller's own, its label (the holder's words, quoted where
 * printed), when it was claimed and when it runs out, and its state — `live`, or `lapsed` and never released, which
 * AGENTS.md reads as work that may be paused. Never a token.
 */
export type ClaimedOn = { id: string; ticket: string; piece: string | null; holder: string; ownKey: boolean; label: string | null; claimedAt: string; expiresAt: string; state: "live" | "lapsed" };
/** A result's claims: the first CLAIMED_SHOWN, how many more, and how many tickets it names that were not read. */
export type ClaimedHit = { claimed: ClaimedOn[]; claimedMore: number; claimedNotRead: number };
/** How many of a result's claims it names (a ticket's whole and its pieces each count). */
const CLAIMED_SHOWN = 10;
/** One call's reach. Past it the read stopped short, and the tickets it may not have reached are counted, not read. */
const CLAIMS_READ = 1000;
const TICKET_KEY = /^[A-Z][A-Z0-9]+-[0-9]+$/;
/** A key a row's metadata files it under (a ticket row's `issue`, a note's `ticket`), as 115 keys it, when it is one. */
const filedUnder = (v: unknown) => (typeof v === "string" && TICKET_KEY.test(v.trim().toUpperCase()) ? v.trim().toUpperCase() : null);
/** The tickets a result names: those its metadata files it under, then the first MOVED_READ others its text mentions; the rest counted. */
export function claimKeysOf(h: { content: string; metadata?: Record<string, unknown> | null }): { keys: string[]; notRead: number } {
  const { filed, named } = ticketsNamedBy(h);
  return { keys: [...filed, ...named.slice(0, MOVED_READ)], notRead: Math.max(0, named.length - MOVED_READ) };
}

/** Every ticket a result names: those its metadata files it under, then the others its text mentions, in order, once each. */
export function ticketsNamedBy(h: { content: string; metadata?: Record<string, unknown> | null }): { filed: string[]; named: string[] } {
  const filed = [...new Set([filedUnder(h.metadata?.issue), filedUnder(h.metadata?.ticket)].filter((k): k is string => k !== null))];
  // A filed key the text also names is read as filed: not one of the text's 50, nor counted past them (review pass 1).
  return { filed, named: keysInOrder(h.content).filter((k) => !filed.includes(k)) };
}

/**
 * The claimed label (SMD-3599): per result, the unreleased claims on the tickets it names — live, and lapsed but never
 * released (the maintainer's call, review pass 1: AGENTS.md reads one as work that may be paused) — so an answer to
 * "what next" from any search or list sees held work before it calls list_claims. It is a prompt, not the check: a
 * released claim, a branch or an open PR with no claim, and a claim whose PR merged are AGENTS.md's to find. One read
 * for the whole page, none when no result names a ticket. Unlike `moved`, a ticket's own row and a superseded thought
 * are labelled too: who holds a ticket is a fact about now. Best-effort, as movedOf: a brain before 115, a server role
 * without the claims grant, or a read that fails, gives null — not checked, which the replies say; a result naming no claimed ticket, `[]`. It labels
 * and never ranks.
 */
export async function claimedOf(store: Pick<ThoughtStore, "unreleasedClaimsOn">, principal: Principal, hits: readonly { id: string; content: string; metadata?: Record<string, unknown> | null }[]): Promise<Record<string, ClaimedHit> | null> {
  const keyed = hits.map((h) => ({ id: h.id, ...claimKeysOf(h) }));
  const tickets = [...new Set(keyed.flatMap((h) => h.keys))];
  const out: Record<string, ClaimedHit> = {};
  if (tickets.length === 0) {
    for (const h of keyed) out[h.id] = { claimed: [], claimedMore: 0, claimedNotRead: h.notRead };
    return out;
  }
  let claims;
  try {
    claims = await store.unreleasedClaimsOn(tickets, CLAIMS_READ);
  } catch (e) {
    // The replies say the claims could not be read; the log says why — a missing grant (42501), a brain before 115
    // (42P01), or a fault of this code — so an operator need not guess (whole-branch review). No token reaches it.
    const err = e as { errno?: unknown; code?: unknown; message?: unknown };
    console.error(`claimed: the work claims read failed (${String(err.errno ?? err.code ?? "no code")}): ${String(err.message ?? e).slice(0, 200)}; results carry claimed: null`);
    return null;
  }
  const byTicket = new Map<string, ClaimedOn[]>();
  for (const c of claims) {
    if (c.state !== "live" && c.state !== "lapsed") continue;
    const on: ClaimedOn = { id: c.id, ticket: c.issue, piece: c.piece, holder: c.holder, ownKey: c.holder === principal.name, label: c.label, claimedAt: c.claimedAt, expiresAt: c.expiresAt, state: c.state };
    byTicket.set(c.issue, [...(byTicket.get(c.issue) ?? []), on]);
  }
  // A read that stopped at its reach went in the database's order, which is its collation's, not this process's
  // (review pass 1): every ticket it brought nothing back for, and the last it reached, may be unread — counted so, an
  // over-count rather than a miss. It takes a thousand unreleased claims on one page's tickets.
  const last = claims.length >= CLAIMS_READ ? claims[claims.length - 1].issue : null;
  for (const h of keyed) {
    const all = h.keys.flatMap((k) => byTicket.get(k) ?? []);
    const cut = last === null ? 0 : h.keys.filter((k) => k === last || !byTicket.has(k)).length;
    out[h.id] = { claimed: all.slice(0, CLAIMED_SHOWN), claimedMore: Math.max(0, all.length - CLAIMED_SHOWN), claimedNotRead: h.notRead + cut };
  }
  return out;
}

/** A result's claimed fields where every read carries them: null when the read failed, else the claims and counts. */
export const claimedLabel = (all: Record<string, ClaimedHit> | null, id: string): { claimed: ClaimedOn[] | null; claimedMore: number; claimedNotRead: number } =>
  all === null ? { claimed: null, claimedMore: 0, claimedNotRead: 0 } : (all[id] ?? { claimed: [], claimedMore: 0, claimedNotRead: 0 });
/**
 * The compat shapes' claimed fields (search, fetch): only where a ticket is claimed, as `moved` is carried, so every
 * other result keeps ChatGPT's shape exactly (test-e2e-sql's pin) — its claims, and beside them the rest and the
 * tickets not read, as `movedNotRead` rides beside a move; and `claimed: null` on every result when the read failed
 * (review pass 1: a failure read as nothing held).
 */
export const claimedResult = (all: Record<string, ClaimedHit> | null, id: string): { claimed?: ClaimedOn[] | null; claimedMore?: number; claimedNotRead?: number } => {
  if (all === null) return { claimed: null };
  const c = all[id];
  return c?.claimed.length ? { claimed: c.claimed, ...(c.claimedMore > 0 ? { claimedMore: c.claimedMore } : {}), ...(c.claimedNotRead > 0 ? { claimedNotRead: c.claimedNotRead } : {}) } : {};
};

// ── priority_weight and min_priority (SMD-3668) ─────────────────────────────

/** The matches a priority-ranked search reads: prefer_current's window, min(100, 4 × limit) (077). */
export const priorityWindow = (limit: number) => Math.min(100, 4 * limit);

/**
 * What a priority-ranked search did (SMD-3668): its weight and floor, how many matches it read, kept, and found a known
 * priority on; the call's own weights (SMD-4193), null for the brain's defaults, and the scale its blend divided by
 * (null when no weight blended, or nothing was read).
 */
export type PriorityRanking = { weight: number; min: number | null; window: number; read: number; kept: number; known: number; weights: Partial<PriorityWeights> | null; span: number | null };
/** A match's priority as the ranking reads it: the effective priority counted, and whether it is known (a level stated, read from its open items, or inherited). */
export type MatchPriority = { effective: number; known: boolean };

/**
 * Each row's priority as the ranking reads it (SMD-3668): its own thought's effective priority, from the window's one
 * read of its rows' own thoughts (readPriorities with `tickets: false`). 122 decides it as
 * docs/priority.md decision 5 says (review pass 1: an earlier reading took the highest of a thought's and its filed
 * tickets', against three of the ADR's rules):
 * - a ticket's own row reads as its ticket;
 * - any other thought takes its own stated level, else the highest counted on its open items (125, SMD-4149), else one
 *   inherited from the ticket it is about (metadata ticket or issue, else its standing subject) at one level less a
 *   hop, counted only above unknown's 2, and nothing from a settled ticket; its due time its own, else its open items'
 *   soonest;
 * - a ticket its text only mentions does not rank it: inheritance through mentions waits for SMD-3662's numbers ("Not
 *   decided here"); the label shows that ticket's priority beside the row's own.
 * Known is a stated level, one read from its open items, or a counted inherited one; otherwise the row's unknown,
 * ordered as 122's `unknown` weight (plus any urgency its due time adds).
 */
export function prioritiesOf(read: PriorityRead, rows: readonly { id: string }[]): Record<string, MatchPriority> {
  const out: Record<string, MatchPriority> = {};
  for (const { id } of rows) {
    const p = read.by.get(`thought:${id}`);
    out[id] = p ? { effective: p.effective, known: knownPriority(p) } : { effective: 0, known: false };
  }
  return out;
}

/**
 * A priority is known when a counted statement states its level, a thought reads one from its open items (`from_items`,
 * migration 125, SMD-4149), or it inherits a counted one (decision 5): unknown's 2 is no label, nor is a due time alone.
 */
const knownPriority = (p: Pick<EffectivePriority, "level" | "inheritedFrom" | "terms">) =>
  p.level !== null || p.inheritedFrom !== null || p.terms.some((t) => t.term === "from_items");

/**
 * A prioritised item a result names (SMD-3668 PR 2), as 122 read it: the result itself (`self`) — a ticket's own row
 * as its ticket, kind `ticket` — or a ticket it is filed under or names. Its effective priority and the level behind
 * it, stated (`level`), read from an open item opened from it (`fromItem`, migration 125) or inherited
 * (`inheritedFrom`); its due time, the urgency or overdue term it adds, the open
 * items it unblocks; whether it is settled (a finished ticket's own level stands, its urgency and unblocks dropped)
 * or waiting on a not_before; and every term, named, as the agenda shows them.
 */
export type PriorityOn = {
  kind: "thought" | "ticket"; key: string; self: boolean; effective: number; level: number | null;
  inheritedFrom: { kind: string; key: string; level: number; hops: number } | null;
  fromItem: { key: string; level: number } | null;
  dueAt: string | null; urgency: number; overdue: boolean; unblocks: number; settled: boolean; notBefore: string | null; waiting: boolean;
  terms: PriorityTerm[];
};
/** A result's priorities: the first PRIORITY_SHOWN, how many more, and how many tickets it names that were not read. */
export type PriorityHit = { priority: PriorityOn[]; priorityMore: number; priorityNotRead: number };
/** How many of a result's prioritised items it names in full (itself first, then the most pressing). */
const PRIORITY_SHOWN = 10;
/** One read's reach: 122 reads at most 1000 items at once. The rows' own thoughts first, then the tickets they name. */
const PRIORITY_READ = 1000;
/** A ticket key as 115 and 122 take it: a key the text names that is no ticket (SMD-0, a 17-letter team) would fail the whole read. */
const PRIORITY_TICKET = /^[A-Z][A-Z0-9]{1,15}-[1-9][0-9]{0,9}$/;
/** One effective_priority read for a page (SMD-3668): every answer by `kind:key`, and per row the tickets asked for it and those it names that were not. */
export type PriorityRead = { by: Map<string, EffectivePriority>; keyed: Map<string, { keys: string[]; notRead: number }> };

type PriorityRow = { id: string; content: string; metadata?: Record<string, unknown> | null };

/**
 * The page's one priority read (SMD-3668): each row as its own thought — a ticket's own row reads as its ticket, and a
 * note inherits from the ticket it is about, as 122 decides — then the tickets each row is filed under and the first
 * MOVED_READ others its text names (claimKeysOf, as the claimed label reads them), each once, to 122's reach of 1000.
 * A key that is no ticket key by 115's rule is not sent. Throws as the store does: a ranked search refuses on it,
 * priorityOf reads it as not read.
 *
 * `tickets: false` asks the rows' own thoughts alone: a ranked search's window read, which ranks by them and refuses
 * on a failure, so a ticket only a row it drops names can neither cost it nor fail it (review pass 1). `have` holds
 * answers already read, not asked again: the label of a ranked page reuses the window's. Nothing to ask, no call.
 */
export async function readPriorities(store: Pick<ThoughtStore, "effectivePriority">, rows: readonly PriorityRow[], opts: { tickets?: boolean; have?: ReadonlyMap<string, EffectivePriority>; weights?: Partial<PriorityWeights> } = {}): Promise<PriorityRead> {
  const have = opts.have ?? new Map<string, EffectivePriority>();
  const ids = [...new Set(rows.map((r) => r.id))].filter((id) => !have.has(`thought:${id}`));
  const tickets: string[] = [];
  const seen = new Set<string>();
  const keyed = new Map<string, { keys: string[]; notRead: number }>();
  for (const r of rows) {
    if (keyed.has(r.id) || opts.tickets === false) continue;
    const { keys, notRead } = claimKeysOf(r);
    // A ticket's own row is asked by its key too, though 122 may read its thought as that ticket: whether it does rests
    // on the raw metadata and the row's linear source identity, which this side cannot see (review pass 3: a lower-case
    // `issue`, which 122 does not map, lost its ticket when the key was skipped). priorityLabels shows it once.
    const asked: string[] = [];
    let cut = notRead;
    for (const k of keys.filter((k) => PRIORITY_TICKET.test(k))) {
      if (!seen.has(k)) {
        if (ids.length + tickets.length >= PRIORITY_READ) { cut++; continue; }
        seen.add(k);
        tickets.push(k);
      }
      asked.push(k);
    }
    keyed.set(r.id, { keys: asked, notRead: cut });
  }
  const by = new Map(have);
  if (ids.length + tickets.length === 0) return { by, keyed };
  // 122 answers each item as asked, normalised: a thought by its id, lower-case, as the store's ids are; a ticket upper-case.
  // A call's own weights (SMD-4193) when it passed any; else the store's call is as it was, the defaults.
  const items = [...ids.map((key) => ({ kind: "thought", key })), ...tickets.map((key) => ({ kind: "ticket", key }))];
  const read = await (opts.weights === undefined ? store.effectivePriority(items) : store.effectivePriority(items, { weights: opts.weights }));
  for (const p of read) by.set(`${p.item.kind}:${p.item.key}`, p);
  return { by, keyed };
}

/** The ticket a thought's answer reads as (122 names it in its first term's `as`), else null. */
const readAs = (p: EffectivePriority): string | null => {
  const as = p.terms[0]?.detail.as as { kind?: unknown; key?: unknown } | undefined;
  return as?.kind === "ticket" && typeof as.key === "string" ? as.key : null;
};
/** The open item a thought read its level from (125's `from_items` term): its id and the level counted on it, else null. */
const fromItemOf = (p: EffectivePriority): PriorityOn["fromItem"] => {
  const t = p.terms.find((x) => x.term === "from_items");
  return t && typeof t.detail.item === "string" ? { key: t.detail.item, level: t.value } : null;
};
const priorityOn = (p: EffectivePriority, self: boolean): PriorityOn => {
  const as = self ? readAs(p) : null;
  return {
    kind: as !== null || p.item.kind === "ticket" ? "ticket" : "thought", key: as ?? p.item.key, self, effective: p.effective, level: p.level,
    inheritedFrom: p.inheritedFrom, fromItem: fromItemOf(p), dueAt: p.dueAt, urgency: p.urgency, overdue: p.overdue, unblocks: p.unblocks, settled: p.settled,
    notBefore: p.notBefore, waiting: p.waiting, terms: p.terms,
  };
};

/**
 * Each row's label from the read (SMD-3668 PR 2): the known priorities of the row itself and of the tickets it names —
 * itself first, then by effective priority, a tie in the order named; a settled item by the level it keeps, said
 * settled, as finished-ness is its own fact (the maintainer, SMD-3668 PR 1's review pass 2) — the first PRIORITY_SHOWN and the rest counted, and
 * the tickets it names past the read's reach counted. A ticket's own row is shown once, as its ticket. An unknown
 * priority is no label: 122 reads it as 2, which says nothing of the item. It labels and never ranks.
 */
export function priorityLabels(read: PriorityRead, rows: readonly { id: string }[]): Record<string, PriorityHit> {
  const out: Record<string, PriorityHit> = {};
  for (const { id } of rows) {
    const own = read.by.get(`thought:${id}`);
    const self = own && knownPriority(own) ? priorityOn(own, true) : null;
    const as = own ? readAs(own) : null;
    const k = read.keyed.get(id) ?? { keys: [], notRead: 0 };
    const named = k.keys
      .filter((key) => key !== as)
      .map((key) => read.by.get(`ticket:${key}`))
      .filter((p): p is EffectivePriority => p !== undefined && knownPriority(p))
      .map((p) => priorityOn(p, false))
      .sort((a, b) => b.effective - a.effective);
    const all = self ? [self, ...named] : named;
    out[id] = { priority: all.slice(0, PRIORITY_SHOWN), priorityMore: Math.max(0, all.length - PRIORITY_SHOWN), priorityNotRead: k.notRead };
  }
  return out;
}

/**
 * The priority label (SMD-3668 PR 2) for a page: one read, best-effort, as claimedOf — a brain before 122, a server
 * role without its grants, or a read that fails gives null, which the replies say. A ranked page passes its window's
 * answers (`have`), so only its tickets are asked; an empty page asks nothing (review pass 1). `weights`: the ranked
 * search's own (SMD-4193), so its tickets read as its window did.
 */
export async function priorityOf(store: Pick<ThoughtStore, "effectivePriority">, rows: readonly PriorityRow[], have?: ReadonlyMap<string, EffectivePriority>, weights?: Partial<PriorityWeights>): Promise<Record<string, PriorityHit> | null> {
  try {
    return priorityLabels(await readPriorities(store, rows, { have, ...(weights === undefined ? {} : { weights }) }), rows);
  } catch (e) {
    const err = e as { errno?: unknown; code?: unknown; message?: unknown };
    console.error(`priority: the effective priority read failed (${String(err.errno ?? err.code ?? "no code")}): ${String(err.message ?? e).slice(0, 200)}; results carry priority: null`);
    return null;
  }
}

/** A result's priority fields where every read carries them: null when the read failed, else the items and counts. */
export const priorityLabel = (all: Record<string, PriorityHit> | null, id: string): { priority: PriorityOn[] | null; priorityMore: number; priorityNotRead: number } =>
  all === null ? { priority: null, priorityMore: 0, priorityNotRead: 0 } : (all[id] ?? { priority: [], priorityMore: 0, priorityNotRead: 0 });
/** The compat shapes' priority fields (search, fetch), as claimedResult: only where an item is prioritised, or `priority: null` when the read failed. */
export const priorityResult = (all: Record<string, PriorityHit> | null, id: string): { priority?: PriorityOn[] | null; priorityMore?: number; priorityNotRead?: number } => {
  if (all === null) return { priority: null };
  const p = all[id];
  return p?.priority.length ? { priority: p.priority, ...(p.priorityMore > 0 ? { priorityMore: p.priorityMore } : {}), ...(p.priorityNotRead > 0 ? { priorityNotRead: p.priorityNotRead } : {}) } : {};
};

/**
 * The window re-ranked and filtered (SMD-3668): each match scored (1 − weight) × relevance + weight × priority —
 * relevance its place in the window, (n − i) / n, so the first is 1 and the last 1/n; priority its effective over
 * `span`, the brain's largest effective priority (ob1_priority_span, migration 128; 5.8 under 127's defaults), capped at 1 — in that order, a tie in the window's own; then, with a floor, only matches whose
 * priority is known and at least it; then the first `limit`. Pure, for the unit test.
 *
 * By place, not score (review pass 2): the hybrid's score is its fusion score, 0 for a text match, for every row of
 * a literal-only query without the literal, and for every row when no thought holds it — rows the search ordered by
 * similarity or newness, which a score over the top's left to priority alone at any weight. The window's order is the
 * search's own, ties and all; and the fusion scores bunch (the 40th about 0.6 of the first), which place does not.
 */
export function rankByPriority<T extends { id: string }>(rows: readonly T[], prio: Record<string, MatchPriority>, weight: number, min: number | null, limit: number, span: number): T[] {
  // A span that is no positive number would make every score NaN and the order the engine's (review pass 4).
  if (!(span > 0) || !Number.isFinite(span)) throw new Error(`rankByPriority needs a positive span; got ${span}`);
  const n = rows.length;
  const priority = (r: T) => Math.min(1, Math.max(0, prio[r.id]?.effective ?? 0) / span);
  const scored = rows.map((r, i) => ({ r, i, s: (1 - weight) * ((n - i) / n) + weight * priority(r) }));
  // The window's own order breaks a tie, so a weight of 0 with a floor keeps it.
  scored.sort((a, b) => b.s - a.s || a.i - b.i);
  const kept = min === null ? scored : scored.filter(({ r }) => prio[r.id]?.known === true && prio[r.id].effective >= min);
  return kept.slice(0, limit).map(({ r }) => r);
}

/**
 * A page of hybrid rows as search_thoughts' hits: which a newer thought superseded, the tickets they name that moved,
 * their claims, judged relations and priorities, each read once for the page. `labels` is a priority read already
 * made (a ranked search's). Shared with plan_context's knowledge section (SMD-2684), so its hits read as these do.
 */
export async function labelHits(ctx: Ctx, principal: Principal, data: readonly ThoughtHybridMatch[], labels?: Promise<Record<string, PriorityHit> | null> | null): Promise<SearchHit[]> {
  const store = await ctx.store();
  const claims = claimedOf(store, principal, data), relating = relationsOf(store, data);
  const prios = labels ?? priorityOf(store, data);
  const superseded = await store.supersededAmong(data.map((t) => t.id));
  const [moved, claimed, related, prioritised] = await Promise.all([movedOf(store, data, superseded), claims, relating, prios]);
  return data.map((t) => ({
    id: t.id, content: t.content, metadata: t.metadata, created_at: t.created_at, similarity: t.similarity,
    matchedNeedles: t.matchedNeedles, score: t.score, fused: t.fused, demoted: t.demoted,
    supersededBy: superseded[t.id] ?? null, ...hitLabel(t.content, moved[t.id]), ...claimedLabel(claimed, t.id), ...relationsLabel(related, t.id), ...priorityLabel(prioritised, t.id),
  }));
}

export async function searchThoughts(ctx: Ctx, principal: Principal, input: Input<"search_thoughts">): Promise<Outcome<SearchThoughtsResult>> {
  const { query, limit, threshold, recency_weight, prefer_current, min_trust, priority_weight, min_priority } = input;
  // The call's own weights (SMD-4193): none given, or an empty set, is the defaults.
  const weights = input.weights && Object.keys(input.weights).length ? input.weights : undefined;
  // SMD-3668: a weight above 0 or a floor reads a window and its priorities; neither is today's search, untouched.
  const ranked = priority_weight > 0 || min_priority !== undefined;
  // SMD-4193: a call's own weights reweigh that read; with no ranking nothing would read them, so they are refused,
  // before the search runs, rather than ignored.
  if (weights !== undefined && !ranked) return refuse({ code: "REFUSED_WEIGHTS", retryable: false, problem: "unranked", message: "weights given without priority_weight above 0 or min_priority", named: [] });
  const window = ranked ? priorityWindow(limit) : limit;
  // parseFilter refuses a shape jsonb should not run.
  const f = searchFilter(input);
  if ("refusal" in f) return refuse(f.refusal);
  // The one search op, hybrid arm (SMD-1490): it gates the query
  // (SMD-1903), embeds it, runs the filter and logs.
  const r = await runSearch(ctx, principal, { tool: "search_thoughts", arm: "hybrid", query, limit: window, threshold, recencyWeight: recency_weight, filter: f.filter, preferCurrent: prefer_current, minTrust: min_trust, unlogged: ranked });
  if (r.refusal) return refuse(r.refusal);
  let data = r.rows;
  let priority: PriorityRanking | null = null;
  // A ranked search reads its window's own thoughts, which rank it, and refuses on a failed read, as PR 1's did. Its
  // label then reads the tickets of the page it keeps, best-effort, reusing the window's answers (SMD-3668 PR 2, review
  // pass 1: a window read of every ticket its rows name read up to 900 the page never shows, and could fail the search
  // on one). An unranked search reads its page's, best-effort, beside the claims.
  let labels: Promise<Record<string, PriorityHit> | null> | null = null;
  if (ranked && data.length) {
    const store = await ctx.store();
    // The blend's scale is the brain's own (SMD-4194): read beside the window, and only when a weight blends; a floor
    // alone at weight 0 never divides. The window read's failure is the one said when both fail (review pass 1: on a
    // brain before 122 the span's failed first, and the hint named 128 alone).
    // A call's own weights (SMD-4193) read the window and scale the blend: 131's span under them, 128's without.
    const blends = priority_weight > 0;
    const [allRead, spanRead] = await Promise.allSettled([readPriorities(store, data, { tickets: false, ...(weights === undefined ? {} : { weights }) }), blends ? store.prioritySpan(weights) : Promise.resolve(1)]);
    // 122's refusal of the weights (22023, naming the weight), from either read: the caller's to mend, not a fault.
    for (const s of [allRead, spanRead]) {
      const bad = s.status === "rejected" ? weightsRefused(s.reason, weights) : null;
      if (bad) return refuse(bad);
    }
    if (allRead.status === "rejected") throw allRead.reason;
    if (spanRead.status === "rejected") throw spanRead.reason;
    const all = allRead.value, span = spanRead.value;
    const prio = prioritiesOf(all, data);
    const read = data.length;
    data = rankByPriority(data, prio, priority_weight, min_priority ?? null, limit, span);
    labels = priorityOf(store, data, all.by, weights);
    priority = { weight: priority_weight, min: min_priority ?? null, window, read, kept: data.length, known: Object.values(prio).filter((p) => p.known).length, weights: weights ?? null, span: blends ? span : null };
  } else if (ranked) {
    priority = { weight: priority_weight, min: min_priority ?? null, window, read: 0, kept: 0, known: 0, weights: weights ?? null, span: null };
  }
  const failed = r.vectorFailed ? { vectorFailed: r.vectorFailed } : {};

  if (data.length === 0) {
    // Nothing cleared the threshold and no literal matched — but WHY is
    // worth saying, and the function reports it only on rows. One more
    // call with no threshold and one row returns the query-level facts
    // whenever the brain has any embedded thought at all (review pass:
    // the first version said "no thoughts found" about a literal that
    // 150 thoughts contained, because it was too common to match). Reuses
    // the arm's embedding, and stays unfiltered — no min_trust either — so
    // the facts are the query's, not the filtered scope's.
    // Without a vector the facts are answerWithoutVector's (SMD-2891).
    const facts = r.vectorFailed ? (r.facts ?? null) : factsOf((await (await ctx.store()).hybridThoughts({ query, embedding: r.embedding, threshold: -1, limit: 1, filter: {} }))[0]);
    // A floor that kept none of the window's matches says so (SMD-3668): the facts are still the query's.
    return ok({ query, preferCurrent: prefer_current, hits: [], facts, window: null, priority, ...failed });
  }

  // 025 (SMD-1253): which of these hits a newer thought has superseded,
  // and by which. One extra query; the labelling half of the retrieval
  // decision — the ranking half is prefer_current, opt-in (059,
  // SMD-2255), priced by eval-supersession.ts. A hit ranked beside the
  // version that replaced it is the failure this ticket is about — say so
  // on the row rather than let it pass as current.
  return ok({
    query,
    preferCurrent: prefer_current,
    hits: await labelHits(ctx, principal, data, labels),
    // A text match has no literal-only reading: unknown, not false (review pass 6).
    facts: r.vectorFailed?.matched === "text" ? { ...factsOf(data[0])!, literalOnly: null } : factsOf(data[0]),
    window: data[0].window ?? null,
    priority,
    ...failed,
  });
}

export type KeywordHit = Pick<ThoughtKeywordMatch, "id" | "content" | "metadata" | "created_at" | "occurrences"> & ReturnType<typeof claimedLabel> & ReturnType<typeof relationsLabel> & ReturnType<typeof priorityLabel>;
export type KeywordResult = { query: string; offset: number; total: number | null; hits: KeywordHit[] };

export async function searchThoughtsKeyword(ctx: Ctx, principal: Principal, input: Input<"search_thoughts_keyword">): Promise<Outcome<KeywordResult>> {
  const { query, limit, offset, min_trust } = input;
  const f = searchFilter(input);
  if ("refusal" in f) return refuse(f.refusal);
  // The one search op, keyword arm (SMD-1490): no gate (a keyword search
  // embeds nothing, so nothing leaves the box), the filter applied inside
  // the scan, and — new since SMD-1490 — a query_log row written with
  // arm='keyword' (034 logged only the semantic path).
  const { rows } = await runSearch(ctx, principal, { tool: "search_thoughts_keyword", arm: "keyword", query, limit, offset, filter: f.filter, minTrust: min_trust });
  const store = rows.length ? await ctx.store() : null;
  const [claimed, related, prioritised] = store ? await Promise.all([claimedOf(store, principal, rows), relationsOf(store, rows), priorityOf(store, rows)]) : [{}, {}, {}];
  return ok({
    query,
    offset,
    // The whole match set, not the page: every row carries it. An empty first page is none; an empty later page (an offset past the end) says nothing of the set, so null (review pass 6).
    total: rows.length ? rows[0].totalCount : offset === 0 ? 0 : null,
    hits: rows.map((t) => ({ id: t.id, content: t.content, metadata: t.metadata, created_at: t.created_at, occurrences: t.occurrences, ...claimedLabel(claimed, t.id), ...relationsLabel(related, t.id), ...priorityLabel(prioritised, t.id) })),
  });
}

// ── list_thoughts and list_supersession_proposals ────────────────────────────

export type ListedThought = ThoughtListItem & { supersededBy: string | null } & ReturnType<typeof claimedLabel> & ReturnType<typeof relationsLabel> & ReturnType<typeof priorityLabel>;
/** A page (SMD-2995): the thoughts, the sort they are in, and the cursor for the next page — null when no more follow. */
export type ListThoughtsResult = { thoughts: ListedThought[]; sort: ListSort; cursor: string | null };

export async function listThoughts(ctx: Ctx, principal: Principal, { limit, type, topic, person, days, said_by, actor, min_trust, sort, after }: Input<"list_thoughts">): Promise<Outcome<ListThoughtsResult>> {
  // SMD-2995: the cursor is decided here, before any call: a string that is no
  // cursor of this tool's, or one made under the other sort, is refused, the
  // sort it was made under named so the caller can pass it.
  let from: ListPosition | null = null;
  // An empty or blank `after` is no cursor, refused (review pass 3): taken for the first page, a client sending
  // `after=` at the end of a walk read page one again, forever.
  if (after !== undefined) {
    const c = parseListCursor(after);
    if (!c) return refuse({ code: "REFUSED_CURSOR", retryable: false, value: after, reason: "shape" });
    if (c.sort !== sort) return refuse({ code: "REFUSED_CURSOR", retryable: false, value: after, reason: "sort", sort: c.sort });
    from = { at: c.at, id: c.id };
  }
  // min_trust (SMD-1724) as the ladder's words at or above it: a containment
  // clause's sibling (no ob1_trust_rank call).
  let page;
  try {
    page = await (await ctx.store()).listThoughts({ limit, type, topic, person, days, saidBy: said_by, actor, trustIn: min_trust === undefined ? undefined : trustAtOrAbove(min_trust), sort, after: from });
  } catch (e) {
    // A cursor of the right shape whose time Postgres cannot read (review pass 1): the same refusal, not a fault quoting it.
    if (e instanceof ListCursorRefused && after !== undefined) return refuse({ code: "REFUSED_CURSOR", retryable: false, value: after, reason: "shape" });
    throw e;
  }
  const cursor = page.next ? listCursor(sort, page.next.at, page.next.id) : null;
  if (!page.thoughts.length) return ok({ thoughts: [], sort, cursor });
  // 025 (SMD-1253): mark the listed thoughts a newer thought supersedes,
  // and name the replacement — the same label search_thoughts prints.
  const store = await ctx.store();
  const [superseded, claimed, related, prioritised] = await Promise.all([store.supersededAmong(page.thoughts.map((t) => t.id)), claimedOf(store, principal, page.thoughts), relationsOf(store, page.thoughts), priorityOf(store, page.thoughts)]);
  return ok({ thoughts: page.thoughts.map((t) => ({ ...t, supersededBy: superseded[t.id] ?? null, ...claimedLabel(claimed, t.id), ...relationsLabel(related, t.id), ...priorityLabel(prioritised, t.id) })), sort, cursor });
}

/**
 * A page of the queue (SMD-3249): `cursor` the next page's `after` while more follow, else null; `remaining` how many
 * follow this page; `pastCursor` whether this page followed a cursor, so an empty one is said as the walk's end, not
 * an empty queue (review pass 1; review pass 2: named apart from the input's `after`, the cursor itself).
 */
export type ProposalsResult = {
  status: Input<"list_supersession_proposals">["status"]; lineage?: boolean; judgeKey?: string; proposals: SupersessionProposal[]; cursor: string | null; remaining: number; pastCursor: boolean;
  /** Whether the decided rows' reviewers were read: false when the page lists a decided row on a brain short of 114 (SMD-3338). */
  reviewersRead: boolean;
};

export async function listSupersessionProposals(ctx: Ctx, _principal: Principal, { status, limit, lineage, judge_key: judgeKey, after }: Input<"list_supersession_proposals">): Promise<Outcome<ProposalsResult>> {
  // SMD-3249: `after` is a cursor a page ended with — one of this listing's, read before the store sees it; list_thoughts'
  // shape and refusal (SMD-2995). It carries the selection it was made under, and one passed with other filters is
  // refused, as list_thoughts' made under the other sort is (review pass 1: it started this listing at a place in
  // another, and the rows above that place were skipped without a word).
  const selection: ProposalSelection = { status, lineage: lineage ?? null, judgeKey: judgeKey ?? null };
  const position = after === undefined ? undefined : parseProposalCursor(after);
  if (position === null) return refuse({ code: "REFUSED_CURSOR", retryable: false, value: after!, reason: "shape" });
  if (position && !sameSelection(position.selection, selection)) return refuse({ code: "REFUSED_CURSOR", retryable: false, value: after!, reason: "filters", made: position.selection });
  let page;
  try {
    // SMD-3248: judge_key selects one pass, in the SQL (109), so the cap counts its rows alone.
    page = await (await ctx.store()).listSupersessionProposals({ status: status === "all" ? null : status, limit, ...(lineage === undefined ? {} : { lineage }), ...(judgeKey === undefined ? {} : { judgeKey }), ...(position ? { after: { confidence: position.confidence, judgedAt: position.judgedAt, id: position.id } } : {}) });
  } catch (e) {
    if (e instanceof ListCursorRefused && after !== undefined) return refuse({ code: "REFUSED_CURSOR", retryable: false, value: after, reason: "shape" });
    throw e;
  }
  const cursor = page.next ? proposalCursor(selection, page.next.confidence, page.next.judgedAt, page.next.id) : null;
  return ok({ status, ...(lineage === undefined ? {} : { lineage }), ...(judgeKey === undefined ? {} : { judgeKey }), proposals: page.proposals, cursor, remaining: page.remaining, pastCursor: position !== undefined, reviewersRead: page.reviewersRead });
}

// ── thought_stats and thought_changes ────────────────────────────────────────

export async function thoughtStats(ctx: Ctx, _principal: Principal, _input: Input<"thought_stats">): Promise<Outcome<ThoughtStats>> {
  // The store aggregates: migration 024's thought_stats_summary() over the
  // whole corpus in one statement — the total, the date range, and the count
  // maps, plus how many rows the breakdowns cover. (See store.ts:ThoughtStats.)
  return ok(await (await ctx.store()).statsSummary());
}

// thought_changes's `since`, and list_logged_searches's (its time arm): its own module, which imports no package, so
// db/tier.ts reads --since by the same rule without reaching zod through this file (SMD-2280 PR 2b review pass 2).
export { parseSince };

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
  // thought_changes's reading of a time (parseSince), its cursor arm excepted: Date.parse took `1` and `Oct 23`, which
  // Postgres's timestamptz does not, so they reached the store as its 500 (SMD-2280 PR 2b review pass 1); a clock with
  // no zone, read in the database's, is refused here as there. A change-feed cursor names no time of this log.
  const start = since === undefined ? { since: null, after: null } : parseSince(since);
  if ("refused" in start || start.after !== null) return refuse({ code: "REFUSED_SINCE", retryable: false, value: (since ?? "").trim() });
  return ok(await (await ctx.store()).listLoggedSearches({ since: start.since, limit }));
}

/** The pools, under a key: a JSON result is an object (an array is wrapped by the MCP wire codec, SEP-2106). */
export type WorkerStatusResult = { pools: WorkerStatusRow[] };

export async function workerStatus(ctx: Ctx, _principal: Principal, _input: Input<"worker_status">): Promise<Outcome<WorkerStatusResult>> {
  return ok({ pools: await (await ctx.store()).workerStatus() });
}

// ── task_status (SMD-3476 PR 3) ──────────────────────────────────────────────

/** Each of the brain's tasks in one word, from the heartbeat rows: the status surface (brain-info.ts's taskStates), which brain_info and preflight read too. */
export async function taskStatus(ctx: Ctx, _principal: Principal, _input: Input<"task_status">): Promise<Outcome<TaskStatusResult>> {
  return ok(taskStates(await (await ctx.store()).heartbeats()));
}

// ── brain_info ───────────────────────────────────────────────────────────────

// The two surfaces' deadlines are deadlines.ts's, which imports nothing, so a
// server that only asks holds its keyed checks to them (SMD-2287).
export { HEALTH_DEADLINE_MS, BRAIN_INFO_TOOL_DEADLINE_MS };
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
    version: BRAIN_VERSION,
    releaseRange: RELEASE_RANGE,
    latestMigration: LATEST_MIGRATION,
    commit: ctx.env().OB1_GIT_SHA || "unknown",
    store: storeKind(ctx.env()),
    tier: ctx.env().OB1_TIER || null,
    embedding: { model: cfg.embeddingModel, dim: cfg.embeddingDim },
    provider: { ...ctx.providerHealth.state(), reprobeS: ctx.reprobeS, reprobeByCall: ctx.reprobeByCall },
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
