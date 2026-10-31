// The read operations (SMD-2283): what the read tools did inside their MCP
// closures, as functions of a principal and a typed input. Each returns the
// typed value or a typed refusal (core/refusal.ts) and throws a fault; none
// knows MCP or writes a sentence — the MCP registration renders the value in
// the words it always has, and the REST core (SMD-2284) answers it as JSON.

import { thoughtTitle, thoughtUrl } from "../thoughts.ts";
import { mayLeaveBox, type EgressSubject } from "../egress.ts";
import { providerDown, shownBase } from "../embed.ts";
import { heardFrom } from "../provider-health.ts";
import { ListCursorRefused, storeKind, UUID_RE, type AuditChange, type ListPosition, type ListSort, type LoggedSearchPage, type SupersessionProposal, type ThoughtHybridMatch, type ThoughtIdPage, type ThoughtKeywordMatch, type ThoughtListItem, type ThoughtStats, type ThoughtStore, type WorkerStatusRow } from "../store.ts";
import { keysInOrder, MOVED_READ, movedAmong, typesOf, type Moved, type MovedHit, type MovedType } from "../stated-status.ts";
import { readJob, startJob, type JobHandle, type PublicJob, type StartJobOptions } from "../jobs.ts";
import { brainInfo as readBrain, taskStates, type BrainInfo, type ReadOptions, type ServerFacts, type TaskStatusResult } from "../brain-info.ts";
import { FORK_VERSION, LATEST_MIGRATION, RELEASE_RANGE } from "../version.ts";
import { BRAIN_INFO_TOOL_DEADLINE_MS, HEALTH_DEADLINE_MS } from "../deadlines.ts";
import type { Principal } from "../auth.ts";
import type { Ctx } from "./context.ts";
import { FilterError, parseFilter, trustAtOrAbove, withActorFilter, type Trust } from "./filter.ts";
import { ok, refuse, type Outcome, type Refusal } from "./refusal.ts";
import { listCursor, parseListCursor, parseProposalCursor, proposalCursor, sameSelection, type ProposalSelection } from "./list-cursor.ts";
import { parseSince } from "./since.ts";
import { SCAN_DEFAULT, SCAN_MAX, type Input } from "./schemas.ts";

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
  (ctx: Ctx, principal: Principal, opts: { tool: string; arm: "hybrid"; query: string; limit: number; threshold: number; recencyWeight: number; filter: Record<string, unknown>; preferCurrent?: boolean; minTrust?: Trust }):
    Promise<Refused | { refusal?: undefined; rows: ThoughtHybridMatch[]; embedding: number[] | null; vectorFailed?: QueryVectorFailed; facts?: QueryFacts }>;
  (ctx: Ctx, principal: Principal, opts: { tool: string; arm: "keyword"; query: string; limit: number; offset: number; filter: Record<string, unknown>; minTrust?: Trust }):
    Promise<{ refusal?: undefined; rows: ThoughtKeywordMatch[] }>;
}
const runSearch: RunSearch = (async (ctx: Ctx, principal: Principal, opts: {
  tool: string; arm: "hybrid" | "keyword"; query: string; limit: number;
  threshold?: number; recencyWeight?: number; offset?: number; filter: Record<string, unknown>; preferCurrent?: boolean; minTrust?: Trust;
}): Promise<{ refusal?: Refusal; rows: (ThoughtHybridMatch | ThoughtKeywordMatch)[]; embedding?: number[] | null; vectorFailed?: QueryVectorFailed; facts?: QueryFacts }> => {
  // min_trust (SMD-1724) is no column of query_log, so a search with it is not
  // logged: a replay (db/tier.ts) would run it without the floor and report
  // the rows it kept out as a difference (the maintainer's call; the column is
  // SMD-2479). Every logged row replays as it ran.
  const logged = opts.minTrust === undefined;
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
    embedding = await ctx.embedder.getEmbedding(opts.query, q.subject, "query");
  } catch (e) {
    const down = providerDown(e);
    if (!down) { heardFrom(ctx.providerHealth, embedStarted, e); throw e; }
    // As a row prints an endpoint: userinfo masked (SMD-2885).
    const base = shownBase(ctx.embedConfig().embeddings);
    console.error(`${opts.tool}: the embedding provider at ${base} was unavailable: ${down.detail}; answered by exact matches alone`);
    // The provider's state, as every embedding call tells it (SMD-2890).
    heardFrom(ctx.providerHealth, embedStarted, e);
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
  results: { id: string; title: string; url: string; trust: unknown; moved?: MovedType[]; movedNotRead?: number }[];
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
  const moved = await movedOf(await ctx.store(), r.rows, null);
  return ok({
    results: r.rows.map((t) => ({
      id: t.id,
      title: thoughtTitle(t.content, t.created_at),
      url: thoughtUrl(ctx.citationBase(), t.id),
      trust: t.metadata?.trust,
      ...resultLabel(moved[t.id]),
    })),
    ...(r.vectorFailed ? { vectorFailed: r.vectorFailed } : {}),
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
export type SearchHit = Pick<ThoughtHybridMatch, "id" | "content" | "metadata" | "created_at" | "similarity" | "matchedNeedles" | "score" | "fused" | "demoted"> & { supersededBy: string | null; moved: Moved[] | null; movedNotRead: number };
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

export async function searchThoughts(ctx: Ctx, principal: Principal, input: Input<"search_thoughts">): Promise<Outcome<SearchThoughtsResult>> {
  const { query, limit, threshold, recency_weight, prefer_current, min_trust } = input;
  // parseFilter refuses a shape jsonb should not run.
  const f = searchFilter(input);
  if ("refusal" in f) return refuse(f.refusal);
  // The one search op, hybrid arm (SMD-1490): it gates the query
  // (SMD-1903), embeds it, runs the filter and logs.
  const r = await runSearch(ctx, principal, { tool: "search_thoughts", arm: "hybrid", query, limit, threshold, recencyWeight: recency_weight, filter: f.filter, preferCurrent: prefer_current, minTrust: min_trust });
  if (r.refusal) return refuse(r.refusal);
  const data = r.rows;
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
    return ok({ query, preferCurrent: prefer_current, hits: [], facts, window: null, ...failed });
  }

  // 025 (SMD-1253): which of these hits a newer thought has superseded,
  // and by which. One extra query; the labelling half of the retrieval
  // decision — the ranking half is prefer_current, opt-in (059,
  // SMD-2255), priced by eval-supersession.ts. A hit ranked beside the
  // version that replaced it is the failure this ticket is about — say so
  // on the row rather than let it pass as current.
  const store = await ctx.store();
  const superseded = await store.supersededAmong(data.map((t) => t.id));
  const moved = await movedOf(store, data, superseded);
  return ok({
    query,
    preferCurrent: prefer_current,
    hits: data.map((t) => ({
      id: t.id, content: t.content, metadata: t.metadata, created_at: t.created_at, similarity: t.similarity,
      matchedNeedles: t.matchedNeedles, score: t.score, fused: t.fused, demoted: t.demoted,
      supersededBy: superseded[t.id] ?? null, ...hitLabel(t.content, moved[t.id]),
    })),
    // A text match has no literal-only reading: unknown, not false (review pass 6).
    facts: r.vectorFailed?.matched === "text" ? { ...factsOf(data[0])!, literalOnly: null } : factsOf(data[0]),
    window: data[0].window ?? null,
    ...failed,
  });
}

export type KeywordHit = Pick<ThoughtKeywordMatch, "id" | "content" | "metadata" | "created_at" | "occurrences">;
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
/** A page (SMD-2995): the thoughts, the sort they are in, and the cursor for the next page — null when no more follow. */
export type ListThoughtsResult = { thoughts: ListedThought[]; sort: ListSort; cursor: string | null };

export async function listThoughts(ctx: Ctx, _principal: Principal, { limit, type, topic, person, days, said_by, actor, min_trust, sort, after }: Input<"list_thoughts">): Promise<Outcome<ListThoughtsResult>> {
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
  const superseded = await (await ctx.store()).supersededAmong(page.thoughts.map((t) => t.id));
  return ok({ thoughts: page.thoughts.map((t) => ({ ...t, supersededBy: superseded[t.id] ?? null })), sort, cursor });
}

/**
 * A page of the queue (SMD-3249): `cursor` the next page's `after` while more follow, else null; `remaining` how many
 * follow this page; `pastCursor` whether this page followed a cursor, so an empty one is said as the walk's end, not
 * an empty queue (review pass 1; review pass 2: named apart from the input's `after`, the cursor itself).
 */
export type ProposalsResult = { status: Input<"list_supersession_proposals">["status"]; lineage?: boolean; judgeKey?: string; proposals: SupersessionProposal[]; cursor: string | null; remaining: number; pastCursor: boolean };

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
  return ok({ status, ...(lineage === undefined ? {} : { lineage }), ...(judgeKey === undefined ? {} : { judgeKey }), proposals: page.proposals, cursor, remaining: page.remaining, pastCursor: position !== undefined });
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
    version: FORK_VERSION,
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
