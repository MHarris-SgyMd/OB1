/**
 * store.ts — the seam between the MCP tools and whatever holds the thoughts.
 *
 * One implementation: `sql` (store-sql.ts), Postgres directly through Bun's
 * client — the store the compose stack runs and every CI job against real
 * Postgres exercises. It became the default in change 97 (SMD-1797). The
 * PostgREST store beside it, kept for a Cloudflare Workers target no brain ran,
 * was retired by SMD-3152, so OB1_STORE has one value, `sql`, and an unset
 * OB1_STORE selects it. The interface stays the seam the tools and their fakes
 * meet, and the normalisers below keep each row shape in one place.
 */

import type { ReviewResult } from "./proposal-review.ts";
import type { EgressRecord } from "./egress.ts";
import type { DatabaseFacts, ReadOptions, ReadProgress, readHeartbeats } from "./brain-info.ts";

/** The parsed heartbeat rows (brain-info.ts's readHeartbeats). */
export type HeartbeatRead = Awaited<ReturnType<typeof readHeartbeats>>;
import type { Lineage } from "./lineage.ts";
import type { JobSink } from "./jobs.ts";
import { withSpan, withStoreSpan } from "./spans.ts";
import type { Change, Status } from "./stated-status.ts";
import { PLUGIN_NAME_RE } from "../db/config.mjs";

export type ThoughtMatch = {
  id: string;
  content: string;
  metadata: Record<string, unknown>;
  /** The raw cosine similarity — what the threshold gates. Unchanged by a recency weight. */
  similarity: number;
  created_at: string | null;
  /**
   * What the rows are ordered by (migration 020): `similarity` blended with
   * 0.5 ^ (age_days / half_life_days) at the call's recency weight; equal to
   * `similarity` at weight 0. Not for display — the tools show `similarity`.
   */
  score: number;
};

/**
 * The recency blend's two inputs (migration 020, SMD-945), on both search
 * methods. Optional and defaulted by the store to the function's own defaults,
 * 0 and 90 days, so a caller that never heard of them gets the ranking it
 * always got. The store always sends them: the 4- and 5-argument function
 * forms no longer exist, and a call that omitted them would be ambiguous the
 * day someone re-applied an old migration by hand.
 */
export type RecencyOpts = {
  /** 0–1. 0 ranks by similarity alone; 1 ranks the rows above the threshold by age alone. */
  recencyWeight?: number;
  /** Days for the recency factor to halve. */
  halfLifeDays?: number;
};
/** What the store sends when the caller says nothing: the function's own DEFAULTs (migration 020), mirrored once here. */
export const RECENCY_DEFAULTS = { weight: 0, halfLifeDays: 90 } as const;

/**
 * One hit from `search_thoughts_keyword` (migration 012).
 *
 * Deliberately NOT a ThoughtMatch with `similarity` reinterpreted. The two
 * numbers are not comparable — a cosine similarity is bounded and continuous,
 * an occurrence count is an unbounded integer — and sharing the type would
 * invite exactly the blend the migration header declines to make. `totalCount`
 * is the true size of the match set, so a caller can page and can tell a
 * complete answer from a clamped one.
 */
export type ThoughtKeywordMatch = {
  id: string;
  content: string;
  metadata: Record<string, unknown>;
  created_at: string | null;
  /** Case-insensitive occurrences of the needle in this thought's content. */
  occurrences: number;
  /** Matches across the whole corpus, before limit and offset. */
  totalCount: number;
};

/**
 * One row from `search_thoughts_hybrid` (migration 017).
 *
 * A third shape, not one of the two above with a field reinterpreted: the fused
 * score is neither a similarity nor a count, `similarity` here is nullable (a
 * keyword hit with no vector and no chunks is still an exact hit), and the
 * three query-level arrays repeat on every row the way 012 repeats
 * `totalCount`, so a caller reading one row knows what the query was taken to
 * mean. There is no total and no offset — the function does not page, and the
 * migration header says why.
 */
export type ThoughtHybridMatch = {
  id: string;
  content: string;
  metadata: Record<string, unknown>;
  created_at: string | null;
  /** Best of the thought's vector and its chunks; null when it has neither. */
  similarity: number | null;
  /** The needles this row contains, in query order. Empty for a vector-only row. */
  matchedNeedles: string[];
  /** Every row: the literals the keyword arm was asked for. */
  needles: string[];
  /** Every row, parallel to `needles`: how many thoughts contain each (0 = none). */
  needleCounts: number[];
  /** Every row: literals extracted but found in more than 100 thoughts, so not used. */
  commonNeedles: string[];
  /** Every row: the query had nothing to embed, so exact hits were ranked ahead of the vector arm. */
  literalOnly: boolean;
  /** The fused score — times 0.25 for a demoted row under prefer_current (059) — monotone in the rank the function returned. Not for display. */
  score: number;
  /** The hybrid's fused score before any weight; equal to `score` when nothing demoted the row. */
  fused: number;
  /** Why prefer_current weighted the row: its ticket's status_type (completed, canceled, duplicate) and/or "superseded". Empty when it did not (and always without the flag). */
  demoted: string[];
  /**
   * Under prefer_current only (059, SMD-2255): the window the function re-ranked
   * — its size, how many rows in it carry a lifecycle, how many were demoted,
   * the latest source watermark among them, and whether its top N is the
   * whole list re-weighted. The same on every row; absent without the flag.
   */
  window?: { rows: number; known: number; demoted: number; syncedAt: string | null; exact: boolean };
};

/**
 * A timestamptz as a driver or a JSON body hands it back, into the one string
 * form the store's types promise. They disagree: Bun.sql (the SQL store)
 * returns a Date, or the number ±Infinity for an infinite timestamp; JSON
 * carries a string in Postgres's own spelling —
 * `2026-09-14T16:27:09.123456+00:00`, or `infinity`; and `compat/supabase-sql`,
 * which hands back a finite Date as its `toISOString` string since FORK.md
 * change 73 (SMD-1544), gives the string form in JS's spelling. (PostgREST, the
 * JSON source this was first written for, left with its store in SMD-3152.)
 * Nothing else may format a timestamp: a `String()` on the Date
 * gave a locale string once, and a bare cast gave each caller its client's
 * shape (SMD-1040; FORK.md §52 has the history).
 *
 * The rule. A finite timestamp is `toISOString`. One with no ISO form keeps
 * the text it arrived as rather than failing the caller's whole result — one
 * odd row stays one odd row. The column allows `infinity`, which migration
 * 020 ranks by design; every spelling of it comes out as Postgres's.
 * A BC date or a year past ±275760 is the case they do NOT agree
 * on: a JSON body's text survives (`0044-03-15T00:00:00+00:00 BC`), but Bun's
 * driver has already turned it into `Date(NaN)` — or, on a parameterised
 * query, a Date whose `toISOString` is the extended-year form — before the
 * store sees it, so the SQL store hands back JS's "Invalid Date". Recovering
 * the text there would mean selecting `created_at::text` beside every column;
 * SMD-1328 decided not to — a BC/extended-year date reaches no capture path,
 * only a hand-written INSERT, and the two drivers disagree at the wire, so the
 * one odd row is left as each client renders it rather than rewriting every
 * SELECT. SMD-1328 did settle the two cases that reach the read/display path:
 * a SQL NULL is `null`, not the fabricated epoch `new Date(null)` gave every
 * mapper here — `normaliseListItem` takes `isoTimestampOrNull`, so `created_at`
 * is `string | null` on the list item and the three match shapes and the
 * record that spread it, the same widening `updated_at` and `ThoughtMeta`
 * already carry — and the tools render a null date as absent and a no-ISO-form
 * value as its own text, not "Invalid Date" (thoughts.ts `displayDate`).
 * `infinity` stays a string, the value migration 020 ranks by; [3d] pins it.
 * SMD-1803 brought the last two mappers onto this rule too: `derivationFields`
 * (025's provenance walk) and `normaliseProposal` (029's
 * `list_supersession_proposals`) now take `isoTimestampOrNull`, so their
 * `created_at` is `string | null` as well. Before it, both fabricated the epoch
 * on a NULL, and `normaliseProposal`'s local `new Date(v).toISOString()` THREW
 * RangeError on an `infinity`-dated proposal thought — a whole-tool crash. Every
 * mapper that reads `created_at` is now null-safe; the CLI's `day`
 * (`db/consolidate.ts`) and the judge-prompt `dateOf` (`consolidate.ts`) went the
 * same way in the same change.
 * `undefined` throws: the column is missing from the row, a bug in the SELECT,
 * not data.
 */
export function isoTimestamp(v: unknown): string {
  if (v === undefined) throw new Error("isoTimestamp: the row has no such column");
  if (v === Infinity || v === "infinity") return "infinity";
  if (v === -Infinity || v === "-infinity") return "-infinity";
  const d = v instanceof Date ? v : new Date(v as string);
  return Number.isNaN(d.getTime()) ? String(v) : d.toISOString();
}

/**
 * `isoTimestamp` for a column whose type says null — `updated_at`, a stats
 * range, `ThoughtMeta.created_at`. Only SQL NULL becomes null; a missing
 * column (`undefined`) still throws, as above.
 */
export function isoTimestampOrNull(v: unknown): string | null {
  return v === null ? null : isoTimestamp(v);
}

/**
 * The day of a timestamp, `YYYY-MM-DD`, for a tool that prints a date from a
 * raw driver row — Bun's `Date`, a JSON body's string, the number `Infinity` —
 * where `String(d).slice(0, 10)` gave `"Wed Sep 09"` (SMD-1842). Through
 * `isoTimestampOrNull`'s rule: NULL is null (the caller picks its word). Only
 * `toISOString`'s own form is cut to its date, an extended year's
 * (`+275760-09-13`) included; any other text `isoTimestamp` keeps — a sentinel
 * ("infinity"), Postgres's text `0044-03-15T00:00:00+00:00 BC`, a year
 * past 9999 JS cannot parse — comes out whole, not sliced to a stub or a BC
 * date read as AD. What Bun hands over for a BC timestamp depends on the
 * query: `Date(NaN)` (so `Invalid Date`) on an unparameterised one, and on a
 * parameterised one a Date in ISO's astronomical year (44 BC is
 * `-000043-03-15`, 1 BC `0000-01-01`), printed as such with no BC mark.
 * The day is UTC's. `db/consolidate.ts`'s `day` (SMD-1803)
 * and the grading report in `evals/eval-consolidate.ts` print through it; the
 * judge prompt's `dateOf` (`consolidate.ts`) does not, because its text is
 * pinned by `CONSOLIDATE_PROMPT_VERSION`.
 */
export function isoDay(v: unknown): string | null {
  const iso = isoTimestampOrNull(v);
  if (iso == null) return null;
  const day = /^(?:[+-]\d{6}|\d{4})-\d{2}-\d{2}(?=T\d{2}:\d{2}:\d{2}\.\d{3}Z$)/.exec(iso);
  return day ? day[0] : iso;
}

/**
 * `isoTimestamp` for a key an envelope may omit — `update_thought`'s jsonb
 * before 018 had no `updated_at`; `resolve_agent`'s has `revoked_at` only when
 * revoked. Absence is legitimate there, so `undefined` is `undefined`, not the
 * throw above. The one place `== null` is the right test.
 */
export function isoTimestampOpt(v: unknown): string | undefined {
  return v == null ? undefined : isoTimestamp(v);
}

/**
 * The row normalisers. One per row shape the store interface returns, so a
 * field's format or a column's name is decided once: a function answers its
 * snake_case columns, and a cast type-checks while delivering `undefined`
 * (`total_count` once) or the driver's own value (`created_at`, above).
 * Numeric columns go through `Number` because a driver may hand a float8 or
 * bigint back as a string.
 */
export function normaliseMatchRow(r: Record<string, unknown>): ThoughtMatch {
  return {
    ...normaliseListItem(r),
    similarity: Number(r.similarity),
    score: Number(r.score),
  };
}

export function normaliseKeywordRow(r: Record<string, unknown>): ThoughtKeywordMatch {
  return {
    ...normaliseListItem(r),
    occurrences: Number(r.occurrences),
    // bigint. Bun hands it back as a string, and Number(undefined) is NaN, so
    // the fallback is 0 rather than a quiet NaN in the caller's "N of M".
    totalCount: Number(r.total_count ?? 0),
  };
}

/**
 * A `search_thoughts_hybrid` row as the driver hands it back — snake_case
 * column names, `similarity` possibly NULL, text[] as arrays — into the store's
 * shape. The nullable field is the one to watch: `Number(null)` is 0, which
 * would turn "this row has no vector" into "this row is orthogonal to the
 * query".
 */
export function normaliseHybridRow(r: Record<string, unknown>): ThoughtHybridMatch {
  const strings = (x: unknown) => (Array.isArray(x) ? x.map(String) : []);
  return {
    ...normaliseListItem(r),
    similarity: r.similarity == null ? null : Number(r.similarity),
    matchedNeedles: strings(r.matched_needles),
    needles: strings(r.needles),
    // Array-like, not Array: the SQL-backed compat client hands an int[] back
    // as a typed array, for which Array.isArray is false and a JSON round trip
    // gives {"0":1}. The retired PostgREST store's conformance test caught it.
    needleCounts: r.needle_counts != null && typeof r.needle_counts === "object" && "length" in (r.needle_counts as object)
      ? Array.from(r.needle_counts as ArrayLike<unknown>, Number)
      : [],
    commonNeedles: strings(r.common_needles),
    literalOnly: r.literal_only === true,
    score: Number(r.score),
    // search_thoughts_hybrid has no fused, demoted or window columns; only 059's
    // search_thoughts_current does, so a row without them is an undemoted one.
    fused: r.fused == null ? Number(r.score) : Number(r.fused),
    demoted: strings(r.demoted),
    ...(r.window_rows == null ? {} : {
      window: {
        rows: Number(r.window_rows),
        known: Number(r.window_known),
        demoted: Number(r.window_demoted),
        syncedAt: r.window_synced_at == null ? null : String(r.window_synced_at),
        exact: r.window_exact === true,
      },
    }),
  };
}

export type ThoughtRecord = {
  id: string;
  content: string;
  metadata: Record<string, unknown>;
  created_at: string | null;
  updated_at?: string | null;
};

export type ThoughtListItem = {
  id: string;
  content: string;
  metadata: Record<string, unknown>;
  created_at: string | null;
};

/**
 * list_thoughts' order (SMD-2995): by `created_at`, ties by id, in
 * thoughts_created_at_idx's order (`created_at DESC`, undated first) or its
 * reverse. An undated thought sorts as the newest, where 001's index puts it.
 */
export type ListSort = "newest" | "oldest";

/**
 * A row's place in that order: its `created_at` as Postgres writes it
 * (`created_at::text`, which `::timestamptz` reads back exactly — microseconds,
 * `infinity` and a BC date included; a JS Date keeps milliseconds, and a cursor
 * built from one would skip or repeat rows inside a millisecond), null when
 * undated, and its id.
 */
export type ListPosition = { at: string | null; id: string };

/**
 * The store's refusal of a list_thoughts cursor whose time Postgres's cast
 * cannot read (SQLSTATE 22007, 22008, 22009: a year 0, past timestamptz's
 * range, an offset past ±15:59:59), which the core says as REFUSED_CURSOR rather
 * than a fault quoting the value (SMD-2995 review pass 1). Also a
 * list_supersession_proposals cursor's (SMD-3249): its time read alone the same way.
 */
export class ListCursorRefused extends Error {
  constructor() {
    super("the cursor's time is not one Postgres reads");
    this.name = "ListCursorRefused";
  }
}

/**
 * Whether an error is a time cast that failed (SQLSTATE 22007, 22008, 22009) — the one test a cursor's time is read
 * by before it is refused as ListCursorRefused, list_thoughts' and list_supersession_proposals' alike, and the CLI's
 * --after (SMD-3249 review pass 3: the list was written out three times).
 */
export const timeCastFailed = (e: unknown): boolean => ["22007", "22008", "22009"].includes(String((e as { errno?: unknown }).errno ?? ""));

/**
 * Where a list_supersession_proposals page ended (SMD-3249, migration 110): the
 * last row's values on the listing's order, as Postgres's text — confidence
 * (numeric(3,2)), judged_at to the microsecond — and its id.
 */
export type ProposalPosition = { confidence: string; judgedAt: string; id: string };

/**
 * A page of list_supersession_proposals: the proposals, the last listed row's place when more follow (else null), and
 * how many follow this page — 110's `remaining` (the selection from this page's first on) less the rows the listing
 * gave, before a row the writers' read drops (review pass 1: counted after the drop, a row gone in between was
 * counted as one still to come).
 */
export type ProposalPage = { proposals: SupersessionProposal[]; next: ProposalPosition | null; remaining: number };

/** A page of list_thoughts: the thoughts, and the last one's place when more follow (else null). */
export type ThoughtListPage = { thoughts: ThoughtListItem[]; next: ListPosition | null };

/**
 * The stats walk's row. `created_at` is nullable here and nowhere else in the
 * interface (SMD-1328 decides the rest): the column allows NULL, NULLs sort
 * first under `ORDER BY created_at DESC`, and a fabricated epoch in the first
 * row would be reported as the corpus's NEWEST thought — where the SQL store's
 * `min`/`max` (migration 024) ignore NULLs.
 */
export type ThoughtMeta = {
  metadata: Record<string, unknown>;
  created_at: string | null;
};

/** A caller's list of ids as a store queries it: well-formed uuids, lower-cased, de-duplicated. One rule for every read (SMD-1298). */
export function idList(ids: string[]): string[] {
  return [...new Set(ids.filter((id) => UUID_RE.test(id)).map((id) => id.toLowerCase()))];
}

export function normaliseThoughtRecord(r: Record<string, unknown>): ThoughtRecord {
  return {
    ...normaliseListItem(r),
    updated_at: isoTimestampOrNull(r.updated_at),
  };
}

export function normaliseListItem(r: Record<string, unknown>): ThoughtListItem {
  return {
    id: String(r.id),
    content: String(r.content),
    metadata: (r.metadata ?? {}) as Record<string, unknown>,
    // SMD-1328: the column is nullable, so map a SQL NULL to null rather than
    // the epoch `new Date(null)` fabricated. See `isoTimestamp`'s header for the
    // full decision and `thoughts.ts` `displayDate` for how the tools render it.
    created_at: isoTimestampOrNull(r.created_at),
  };
}

export function normaliseThoughtMeta(r: Record<string, unknown>): ThoughtMeta {
  return {
    metadata: (r.metadata ?? {}) as Record<string, unknown>,
    created_at: isoTimestampOrNull(r.created_at),
  };
}

/**
 * The canonical hyphenated uuid. A malformed id is a cast error on a uuid
 * column or argument, not a not-found; the store's read methods treat it as
 * no-match so a bad id from an MCP client gets a clean answer, not a Postgres
 * error string.
 */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The one contract for a batch of query-log action rows, applied before
 * anything reaches a database: an absent agent — null, undefined or the empty
 * string — is SQL NULL (034's anonymous bucket); a target must be present; and
 * any id that is not a uuid is refused here, loudly and naming the column,
 * rather than reaching array_in as a malformed value the best-effort caller
 * would swallow with the whole batch. An eighth review pass found one of two
 * writers (the PostgREST one, retired in SMD-3152) sending `""` through as an
 * agent id (22P02, batch dropped); one function, one contract.
 */
export function normaliseActionRows(rows: QueryActionLog[]): { tool: string; agentId: string | null; targetId: string }[] {
  return rows.map((r) => {
    const agentId = r.agentId === null || r.agentId === undefined || r.agentId === "" ? null : r.agentId;
    if (agentId !== null && !UUID_RE.test(agentId)) throw new Error(`logActions: not a uuid for agent_id: ${agentId.slice(0, 40)}`);
    if (r.targetId === null || r.targetId === undefined || r.targetId === "") throw new Error("logActions: target_id is absent");
    if (!UUID_RE.test(r.targetId)) throw new Error(`logActions: not a uuid for target_id: ${r.targetId.slice(0, 40)}`);
    return { tool: r.tool, agentId, targetId: r.targetId };
  });
}

/**
 * What thought_stats renders: the corpus total, its date range, and the counts
 * by type, topic and person. The tool sorts each map and renders its own top 10,
 * so a store need only return at least that many, in any order — the maps are not
 * a contract for the full distribution. The SQL store returns every `type` but
 * only the top 10 `topics`/`people` (migration 024 caps them in SQL). When equal
 * counts tie for the 10th slot, which of the tied keys shows is unspecified.
 *
 * `aggregated` is how many rows the breakdowns actually cover. The SQL store
 * runs one aggregate over the whole table (migration 024), never capped, so it
 * equals `total`; the tool prints a truncation note only when the two differ.
 * The field stays in the REST/MCP contract: the capped page walk that could
 * fall short was the PostgREST store's, retired in SMD-3152.
 */
export type ThoughtStats = {
  total: number;
  oldest: string | null;
  newest: string | null;
  types: Record<string, number>;
  topics: Record<string, number>;
  people: Record<string, number>;
  aggregated: number;
};

/**
 * A page of a brain's thought-id set (SMD-2244) — for a cheap cross-brain id-set
 * diff. `ids` are in id order; `cursor` is the last id when a full page was
 * returned (more may follow), else null. The first page (asked with `after`
 * null) also carries `total` (the whole corpus) and a `digest` (an md5 of every
 * id in id order, computed server-side) — so a caller can tell two corpora
 * apart without enumerating either. `digest` is null on an empty corpus.
 */
export type ThoughtIdPage = {
  ids: string[];
  total: number;
  digest: string | null;
  cursor: string | null;
};

/**
 * A thought saved without a vector — the provider did not answer, the egress
 * gate refused the call, or an import wrote it bare — as the vector mender
 * reads it (SMD-2889).
 * `updatedAt` is `COALESCE(updated_at, created_at)`, the stamp
 * update_thought's guard compares against, so the mender's write never lands
 * over an edit made since this read.
 */
export type VectorlessRow = {
  id: string;
  content: string;
  updatedAt: string;
  metadata: Record<string, unknown> | null;
  /**
   * The door its capture came through — thought_audit.origin on its capture
   * row (046): a server's name for a key's capture, a tool's (`ingest-records`,
   * board-sync's) for a pass's; null when no capture row says (a raw insert,
   * or a store that cannot read the audit). The mender asks the gate the
   * question that writer's own gate asked.
   */
  origin: string | null;
};

/** One `listVectorless` row: `updated_at` is the COALESCE the query selects. */
export function normaliseVectorlessRow(r: Record<string, unknown>): VectorlessRow {
  const metadata = r.metadata;
  return {
    id: String(r.id),
    content: String(r.content),
    updatedAt: isoTimestamp(r.updated_at),
    metadata: metadata !== null && typeof metadata === "object" && !Array.isArray(metadata) ? (metadata as Record<string, unknown>) : null,
    origin: typeof r.origin === "string" ? r.origin : null,
  };
}

/**
 * One logged search from `query_log` (SMD-2245), for a log-sourced cross-brain
 * replay. Telemetry, not thought content: the query text, which arm ran it, the
 * tier that logged it, when, and the search's own arguments. `result_ids` (the
 * historical answer) is left off — the compare replays each query FRESH against
 * both brains and diffs those, so the recorded ids are not needed, and a uuid
 * array would diverge across drivers for no gain.
 */
export type LoggedSearchRow = {
  query: string;
  /** 045's arms, 059's current, 106's literal (SMD-2891); null before 045. */
  arm: "hybrid" | "keyword" | "current" | "literal" | null;
  tier: string | null;
  loggedAt: string | null;
  matchCount: number | null;
  threshold: number | null;
  recencyWeight: number | null;
  filter: Record<string, unknown>;
};

/** The page a text match is bounded by (SMD-2891, review pass 8): its count past this is "more than". */
export const TEXT_PAGE = 1000;

/**
 * A window of a brain's logged searches, most recent first, bounded by `limit`.
 * `truncated` is whether more searches matched the window than were returned —
 * a log-sourced replay is bounded (two search calls per row), so the whole log
 * is never streamed; a window is the unit.
 */
export type LoggedSearchPage = { searches: LoggedSearchRow[]; truncated: boolean };

/**
 * One background-work pool's state (SMD-2131) — the counts the workers compute over
 * `thought_work_claims` (migration 015), per `work_type`, so an operator or agent can
 * ask a running brain "what is queued / in flight / failed / stalled" without SQL.
 * The four status counts and `thoughts`/`unpooled` match `db/extract-entities.ts`'s
 * `counts()`; `stale` and `active` are added on top.
 */
export type WorkerStatusRow = {
  /** The pass and its target, e.g. "extract:qwen2.5:7b@p2". */
  workType: string;
  pending: number;
  /** status='claimed' — in flight, INCLUDING stale leases, as the workers count it (the reaper is lazy). */
  claimed: number;
  succeeded: number;
  failed: number;
  /** Thoughts with no claim row for this work_type — what a run would enqueue. The generic definition (exact for extraction; reembed/consolidate have model-aware pool rules). */
  unpooled: number;
  /** The whole corpus's thought count — the same for every row. */
  thoughts: number;
  /** Of `claimed`, how many are past `ttl_expires_at` — a dead worker's lease the reaper has not yet reclaimed. */
  stale: number;
  /** The oldest stale lease's `claimed_at`, or null when none is stale. */
  oldestStaleClaimedAt: string | null;
  /** The `worker_id` holding that oldest stale lease, or null. */
  staleWorkerId: string | null;
  /** Whether this work_type is the brain's active pool (`ob1_config.entity_extraction_key` or `subject_pool_key`, or `reembed:<model>@<dim>`); null when the kind records no active key (consolidate). */
  active: boolean | null;
};

/** The result of `retryFailed` (SMD-2132) — the `failed` rows of one work_type requeued to `pending`. */
export type RetryFailedResult = {
  /** The pool acted on, echoed back. */
  workType: string;
  /** How many `failed` rows moved to `pending`. */
  retried: number;
  /** The thought ids requeued. */
  ids: string[];
};

/** How `releaseStaleLeases` (SMD-2132) is aimed — the optional scoping, and the live-lease escape hatch. */
export type ReleaseLeasesOpts = {
  /** Restrict to one pool; omit to reap stale leases across every work_type (the reaper's own cross-pool reach). */
  workType?: string;
  /** Restrict to one holder's leases. Required when `includeLive` is set. */
  workerId?: string;
  /**
   * Release a holder's leases even when the TTL has NOT lapsed — a live lease.
   * Off by default (only past-`ttl_expires_at` leases are touched), because
   * releasing a live lease risks the holder double-processing; the caller must
   * name the `workerId` to reach one.
   */
  includeLive?: boolean;
};

/** The result of `releaseStaleLeases` (SMD-2132) — the `claimed` rows returned to the pool. */
export type ReleaseLeasesResult = {
  /** How many `claimed` rows moved back to `pending`. */
  released: number;
  /** The thought ids released. */
  ids: string[];
  /** The distinct `worker_id`s whose leases were released. */
  workers: string[];
};

/**
 * A pure-SELECT preview of what a `run_worker` drain over one pool would process
 * (SMD-2272) — the census is exactly a `workerStatus` row for `workType` (so a dry
 * run and the read surface agree by construction), with `backlog`/`wouldClaim`
 * added on top. Claims nothing: no `claim_thoughts`, no `enqueue_thoughts`, no
 * lease. The executing drain is deferred (SMD-2304's callable core); this is the
 * `dry_run: true` half, buildable now over pure SQL.
 */
export type DryRunClaimResult = {
  /** The pool previewed, echoed back. */
  workType: string;
  /** Claim rows currently `pending` for this pool — the rows a `claim_thoughts()` would lease now. */
  pending: number;
  /** `status='claimed'` — in flight, INCLUDING stale leases (as the workers count it). */
  claimed: number;
  succeeded: number;
  failed: number;
  /** Of `claimed`, how many are past `ttl_expires_at` (a dead worker's lease). */
  stale: number;
  /** Thoughts with no claim row for this work_type — what a pass would enqueue first. Same generic definition as `workerStatus` (exact for extraction; reembed/consolidate pool by model-aware rules, so this is an upper bound for them). */
  unpooled: number;
  /** The whole corpus's thought count. */
  thoughts: number;
  /** What a full pass would draw into processing now = `pending + stale + unpooled` (the three disjoint drainable sets, before any `limit`). `stale` is in it because `claim_thoughts` reaps expired leases back to the pool before it claims (migration 015); a live `claimed` lease is held by a live worker and skipped. An UPPER BOUND: exact for an extraction pool, but for reembed/consolidate `unpooled` counts every un-pooled thought (model-aware eligibility), and a stale row at max attempts fails rather than re-claims. */
  backlog: number;
  /** The backlog bounded by `limit`. Equals `backlog` when no `limit` is given — so it carries the same extraction-exact / model-aware-upper-bound caveat as `backlog`. */
  wouldClaim: number;
  /** The `limit` the caller passed, echoed back, or null. */
  limit: number | null;
};

export type ListFilters = {
  limit: number;
  type?: string;
  topic?: string;
  person?: string;
  days?: number;
  /** SMD-1726: `metadata.actor_kind` — who holds the key that wrote the current text (operator | agent | ingested), stamped by migration 050. */
  saidBy?: string;
  /** SMD-1726: `metadata.actor_name` — that key's name. */
  actor?: string;
  /**
   * SMD-1724: `metadata.trust` is one of these words — the ladder at or above
   * a min_trust, which core/filter.ts's trustAtOrAbove spells out (a word list,
   * from when a PostgREST filter could not call ob1_trust_rank). A row with no trust is in no
   * list. Absent: every row.
   */
  trustIn?: string[];
  /** SMD-2995: newest (the default) or oldest first. */
  sort?: ListSort;
  /** SMD-2995: the place the previous page ended — the rows after it, in `sort`'s order. */
  after?: ListPosition | null;
};

/**
 * One node of a derivation chain, from migration 025's trace_provenance. The
 * walk goes UP: depth 0 is the thought asked about, depth 1 its direct sources,
 * and so on. `type`, `sourceType` and `derivationMethod` come from metadata
 * (the migration keeps them there rather than as columns). `cycle` is true on a
 * node the walk has already seen — returned once, not re-expanded.
 */
export type ProvenanceNode = {
  thoughtId: string;
  depth: number;
  parentId: string | null;
  content: string;
  type: string | null;
  sourceType: string | null;
  derivationMethod: string | null;
  created_at: string | null;
  cycle: boolean;
};

/** One thought derived directly from a given one (migration 025's find_derivatives, the walk DOWN). */
export type Derivative = {
  id: string;
  content: string;
  type: string | null;
  sourceType: string | null;
  derivationMethod: string | null;
  created_at: string | null;
};

/** The five columns 025's two functions share; spread FIRST, so an explicit field can never be overwritten by it. */
function derivationFields(r: Record<string, unknown>) {
  return {
    content: String(r.content),
    type: r.type == null ? null : String(r.type),
    sourceType: r.source_type == null ? null : String(r.source_type),
    derivationMethod: r.derivation_method == null ? null : String(r.derivation_method),
    // SMD-1803: the column is nullable (see isoTimestamp's header). A NULL
    // ancestor in the walk is null, not the epoch new Date(null) fabricated.
    created_at: isoTimestampOrNull(r.created_at),
  };
}

export function normaliseDerivative(r: Record<string, unknown>): Derivative {
  return { ...derivationFields(r), id: String(r.id) };
}

export function normaliseProvenanceNode(r: Record<string, unknown>): ProvenanceNode {
  return {
    ...derivationFields(r),
    thoughtId: String(r.thought_id),
    depth: Number(r.depth),
    parentId: r.parent_id ? String(r.parent_id) : null,
    cycle: r.cycle === true,
  };
}

export type CaptureResult = {
  id: string;
  /**
   * Migration 035 (SMD-1453): true when the text was already captured — the
   * metadata merged, the vector and windows moved by 021/022's rules, and any
   * `derivedFrom` / `supersedes` named on this call NOT written, since a
   * re-capture leaves an existing thought's provenance as it is (setting it is
   * update_thought's). Absent when the database is from before 035.
   */
  existed?: boolean;
  /**
   * Beside `existed` (migration 035): the row's `supersedes` pointer after the
   * write — the fresh row's, or the one the existing row keeps — so a caller
   * told the text existed can say what stands rather than guess. `null` is a
   * row with no pointer; absent whenever `existed` is.
   */
  supersedes?: string | null;
  /**
   * Migration 090 (SMD-2898): what the re-capture did to a capture-only key's
   * label, as ob1_weigh_recapture answered it under the row lock. Absent for a
   * new text, a key that cannot read, a row that is not a capture-only key's
   * to weigh (`none`), and a database before 090.
   */
  label?: RecaptureLabel;
};

/**
 * One row of migration 029's review queue, with both thoughts (SMD-1294): a
 * pair the consolidation pass judged one to outdate or duplicate the other, the judge's verdict on which
 * is current, and where the review stands. `list_supersession_proposals`'s
 * shape, in one place.
 */
export type SupersessionProposal = {
  id: string;
  /** `stale` since migration 063: rebuild_derived found a text moved under a pending verdict; the next consolidation pass replaces the row when it proposes the pair again, and settles one it does not (SMD-1732). */
  status: "pending" | "accepted" | "rejected" | "stale";
  verdict: "newer_supersedes_older" | "older_supersedes_newer" | "conflict_undirected";
  confidence: number;
  reason: string | null;
  similarity: number | null;
  judgeKey: string;
  judgedAt: string;
  reviewedAt: string | null;
  reviewNote: string | null;
  /** While accepted: the thought whose supersedes column the acceptance wrote. */
  supersedingId: string | null;
  /** Each thought as it is now; `edited` when its text has changed since the pair was judged (the verdict was about the earlier text). `created_at` is `string | null` for the same reason the read path is (SMD-1803). */
  older: ProposalSide;
  newer: ProposalSide;
  /** Since migration 070 (SMD-2313): one side's `derived_from` names the other — a derivation and its input (a page and its evidence), a pair 066's candidate filter never proposes; a standing one is a reviewer's to reject; false when the column is absent from a row. */
  lineage: boolean;
  /** Since migration 094 (SMD-2707): one agent captured both sides (ob1_capturer_of); false on a brain short of 094. */
  sameCapturer: boolean;
};

/**
 * Who wrote a proposal's side (094, SMD-2707): the keys 050 and 073 stamp on
 * the row — the read tools' `By:` line — and whether its text is still a
 * capture-only key's alone (ob1_capture_only_text: captured under that scope,
 * and no key that can read has re-captured or moved it since).
 */
export type ProposalWriter = { name: string | null; kind: string | null; trust: string | null; captureOnly: boolean };

/** One side of a proposal. `writer` is null, `supersededBy` null and `lapses` empty on a brain short of 094, whose listing returns none of them. */
export type ProposalSide = {
  id: string; content: string; created_at: string | null; edited: boolean;
  writer: ProposalWriter | null;
  /** The first thought superseding the side (by capture time). */
  supersededBy: string | null;
  /** Whether an accept making this side stand would take it from its capturer (ob1_accept_takes: 092's taken read with the new pointer); false when unread. */
  takes: boolean;
  /** The pointers an accept making this side stand over the other would clear (ob1_accept_lapses: 092's lapse, read): `id`'s pointer onto `onto`. None on an accepted row, or for an accept 029 would refuse or that writes nothing. */
  lapses: { id: string; onto: string }[];
  /** The listing left `takes` and `lapses` unread: the chain below the other side or the rows above this one pass its cap (107, SMD-3036: ob1_listing_walk_fits). Never on an accepted row, which takes no accept (029); its unread takes reads false. */
  walkCapped: boolean;
};

/** list_supersession_proposals's row → SupersessionProposal. */
export function normaliseProposal(r: Record<string, unknown>): SupersessionProposal {
  // SMD-1803: older/newer.created_at take the read path's rule — isoTimestampOrNull
  // (NULL → null, infinity kept, no throw); see isoTimestamp's header for why the
  // local new Date(v).toISOString() this replaced was wrong. judged_at is NOT NULL
  // (029) so it stays isoTimestamp; reviewed_at is set only on review.
  return {
    id: String(r.id),
    status: String(r.status) as SupersessionProposal["status"],
    verdict: String(r.verdict) as SupersessionProposal["verdict"],
    confidence: Number(r.confidence),
    reason: r.reason == null ? null : String(r.reason),
    similarity: r.similarity == null ? null : Number(r.similarity),
    judgeKey: String(r.judge_key),
    judgedAt: isoTimestamp(r.judged_at),
    reviewedAt: isoTimestampOrNull(r.reviewed_at),
    reviewNote: r.review_note == null ? null : String(r.review_note),
    supersedingId: r.superseding_id == null ? null : String(r.superseding_id),
    older: proposalSide(r, "older"),
    newer: proposalSide(r, "newer"),
    lineage: r.lineage === true,
    sameCapturer: r.same_capturer === true,
  };
}

/**
 * The listing's rows with list_proposal_writers' columns beside each (094,
 * SMD-2707), by proposal id. When the writers were read, a row they did not
 * return is a proposal gone between the two statements (a side's thought
 * deleted: 029 cascades) and is dropped — not shown as a brain short of 094
 * (review pass 4). When they were not read, every row keeps none, and
 * normaliseProposal reads it as unread.
 */
export function withWriters(rows: Record<string, unknown>[], writers: Record<string, unknown>[], read: boolean): Record<string, unknown>[] {
  const by = new Map(writers.map((w) => [String(w.id), w]));
  return (read ? rows.filter((r) => by.has(String(r.id))) : rows).map((r) => ({ ...(by.get(String(r.id)) ?? {}), ...r }));
}

/** The error a brain short of 094 answers list_proposal_writers with (the `Could not find` forms were PostgREST's schema cache's, before SMD-3152). */
export const WRITERS_MISSING = /(list_proposal_writers|ob1_capture_only_text|ob1_accept_lapses|ob1_accept_takes).*(does not exist|Could not find)|Could not find the function public\.list_proposal_writers/;

/** The lapses column, a jsonb array of {id, onto} — parsed by either driver, or its text; anything else is none. */
function lapseList(v: unknown): { id: string; onto: string }[] {
  let a: unknown = v;
  if (typeof v === "string") { try { a = JSON.parse(v); } catch { return []; } }
  return Array.isArray(a)
    ? a.filter((x): x is { id: unknown; onto: unknown } => x !== null && typeof x === "object").map((x) => ({ id: String(x.id), onto: String(x.onto) }))
    : [];
}

/** One side of a listing row; the 094 columns read only when the row carries them. */
function proposalSide(r: Record<string, unknown>, side: "older" | "newer"): ProposalSide {
  const text = (v: unknown) => (v == null ? null : String(v));
  const by = r[`${side}_superseded_by`];
  return {
    id: String(r[`${side}_id`]), content: String(r[`${side}_content`]), created_at: isoTimestampOrNull(r[`${side}_created_at`]), edited: r[`${side}_edited`] === true,
    writer: `${side}_capture_only` in r
      ? { name: text(r[`${side}_actor_name`]), kind: text(r[`${side}_actor_kind`]), trust: text(r[`${side}_trust`]), captureOnly: r[`${side}_capture_only`] === true }
      : null,
    supersededBy: by == null ? null : String(by),
    lapses: lapseList(r[`${side}_lapses`]),
    takes: r[`${side}_takes`] === true,
    // 107: a NULL takes on a row that carries 094's columns is the cap's —
    // said only while an accept can still come (029 refuses one on an
    // accepted row, so "--accept reads it in full" would be wrong there).
    walkCapped: `${side}_capture_only` in r && r[`${side}_takes`] == null && r.status !== "accepted",
  };
}

/**
 * One row of the change feed — migration 052's thought_changes over
 * thought_audit (SMD-1296): what one capture, update or delete did, bounded
 * for a reply. `head` is at most 240 characters of the text the row is about
 * (a capture's current content — null once the thought is deleted — an
 * update's new content when it moved, a delete's previous content).
 * `changed` is an update's diff keys and `metadataKeys` the metadata keys
 * whose value moved; both empty on a capture or a delete. The supersedes
 * pointer before and after is read from the diff for every action, so a
 * capture that superseded, an update that set or cleared the pointer and a
 * delete's prior pointer all say so. `present` is whether the thought still
 * exists. `id` is the audit row's — the cursor the next page starts after.
 */
export type AuditChange = {
  id: string;
  createdAt: string;
  action: "capture" | "update" | "delete";
  thoughtId: string;
  actorName: string | null;
  actorKind: string | null;
  origin: string | null;
  source: string | null;
  present: boolean;
  head: string | null;
  changed: string[];
  metadataKeys: string[];
  supersedesBefore: string | null;
  supersedesAfter: string | null;
  derivation: boolean;
};

/**
 * Where a page of changes starts and what it keeps. `since` is a time (rows at
 * or after it), `after` a cursor (rows strictly after that audit row); neither
 * is the newest `limit` rows; both is refused by the function. `agent` keeps one
 * key's rows, `notAgent` drops one key's — the server passes the caller's own
 * name for "everyone but me" — and a row with no actor stays. `actions` is a
 * subset of the three. `limit` is what the function is asked for (1..201; the
 * tool asks for one more than it shows).
 */
export type ChangeFilters = {
  since?: string | null;
  after?: string | null;
  agent?: string | null;
  notAgent?: string | null;
  actions?: string[] | null;
  limit: number;
};

/**
 * What migration 095's ticket_status_inputs gives the stated-status label
 * (SMD-2540): the hits with a lifecycle of their own (never labelled), and per
 * ticket its status now and every status its rows held, in the log's order.
 */
export type TicketStatusInputs = { lifecycle: Set<string>; heads: Map<string, Status>; history: Map<string, Change[]> };

/** A ticket key as a store sends it: 077's TEAM-123 shape, each once. */
export function ticketList(tickets: string[]): string[] {
  return [...new Set(tickets.filter((t) => /^[A-Z][A-Z0-9]+-[0-9]+$/.test(t)))];
}

/**
 * ticket_status_inputs's rows → TicketStatusInputs. A history row's elements are the ticket's statuses
 * in the log's order, kept in it; `at` is ms since the epoch. Never throws:
 * a kind it does not know is skipped, and a head or a history it cannot read
 * leaves that ticket out (no label for it) — so a server older than its
 * brain's function, an ordinary state through an upgrade, loses labels and
 * never a search (SMD-2540 PR 2a's third review pass; the label is an
 * enhancement, as supersededAmong's).
 */
/**
 * The stated-status label's read failed (SMD-2540): said once per reason
 * until a read succeeds, so a lock or a timeout under load is one line, not
 * one per search. A brain before 095 (42883) is
 * expected and brain_info's version check names it behind, so it is not
 * said — nor, so, a 42883 from a callee a role's search_path misses; a missing grant
 * (42501), 098's lock timeout (55P03) or a statement timeout (57014) is.
 */
const labelUnread = new Set<string>();
export function labelReadFailed(code: string, cause: string): void {
  if (code === "42883" || labelUnread.has(code)) return;
  labelUnread.add(code);
  console.warn(`stated-status label not read (${code || "no code"}): searches answer without it until a read succeeds — ${cause}`);
}
export const labelReadOk = (): void => labelUnread.clear();

export function normaliseTicketStatusInputs(rows: unknown): TicketStatusInputs {
  const out: TicketStatusInputs = { lifecycle: new Set(), heads: new Map(), history: new Map() };
  const text = (v: unknown) => (typeof v === "string" ? v : null);
  // A later function may answer one object, a scalar or a list holding nulls
  // (SMD-2540 PR 2a's fourth review pass): no list is no rows, no object no row.
  if (!Array.isArray(rows)) return out;
  for (const r of rows as Record<string, unknown>[]) {
    if (!r || typeof r !== "object") continue;
    const kind = r.kind, issue = text(r.issue);
    if (kind === "lifecycle") { const id = text(r.thought_id); if (id) out.lifecycle.add(id.toLowerCase()); }
    else if (kind === "head") {
      const name = text(r.status), type = text(r.status_type);
      if (issue && name && type) out.heads.set(issue, { name, type });
    } else if (kind === "history" && issue) {
      let h: unknown = r.history;
      if (typeof h === "string") { try { h = JSON.parse(h); } catch { h = null; } }
      if (!Array.isArray(h)) continue;
      const list: Change[] = [];
      for (const e of h as { at?: unknown; status?: unknown; status_type?: unknown }[]) {
        const name = text(e?.status), type = text(e?.status_type);
        if (typeof e?.at !== "number" || !Number.isFinite(e.at) || !name || !type) break;
        list.push({ at: e.at, name, type });
      }
      if (list.length === h.length) out.history.set(issue, list);
    }
    // Any other kind: a later function's, skipped.
  }
  return out;
}

const CHANGE_ACTIONS = new Set(["capture", "update", "delete"]);

/** thought_changes's row → AuditChange. */
export function normaliseChange(r: Record<string, unknown>): AuditChange {
  const action = String(r.action);
  // 008's CHECK admits only the three; a fourth word here is a changed function.
  if (!CHANGE_ACTIONS.has(action)) throw new Error(`thought_changes returned an unknown action ${JSON.stringify(action)}`);
  const strOrNull = (v: unknown) => (v == null ? null : String(v));
  // A text[] arrives as an array from both drivers; NULL (no keys) as null.
  const list = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);
  return {
    id: String(r.id),
    // NOT NULL DEFAULT now() on the column, so a null here is a changed table.
    createdAt: isoTimestamp(r.created_at),
    action: action as AuditChange["action"],
    thoughtId: String(r.thought_id),
    actorName: strOrNull(r.actor_name),
    actorKind: strOrNull(r.actor_kind),
    origin: strOrNull(r.origin),
    source: strOrNull(r.source),
    present: r.present === true,
    head: strOrNull(r.head),
    changed: list(r.changed),
    metadataKeys: list(r.metadata_keys),
    supersedesBefore: strOrNull(r.supersedes_before),
    supersedesAfter: strOrNull(r.supersedes_after),
    derivation: r.derivation === true,
  };
}

/**
 * Every database operation the MCP tools perform. Errors are thrown, not returned
 * — the store normalises its driver's error shape so callers do not have to.
 */
/**
 * A refused mutation is a result, not an exception: "your read was stale" and
 * "that id does not exist" are things the caller should act on, and throwing
 * would make them indistinguishable from a fault at the tool boundary.
 */
/**
 * What update_thought / delete_thought refuse with. SUPERSEDES_NOT_FOUND and
 * WOULD_CYCLE (migration 032): the provenance envelope named a thought that
 * does not exist, or a pointer that would close a supersession loop. CITED
 * (migration 042): active citations rest on the thought a delete named, and
 * the caller did not ask to detach them — `citedBy` counts them, `citations`
 * is up to ten of the citing rows, newest first.
 */
export type MutationError = "NOT_FOUND" | "STALE_READ" | "DUPLICATE_CONTENT" | "SUPERSEDES_NOT_FOUND" | "WOULD_CYCLE" | "CITED";
/** One citing row of a CITED refusal: the facet, the thought it is on, its stance and text (migration 042). */
export type Citation = { id: string; thoughtId: string; stance: string; text: string; createdAt?: string };
export type MutationResult =
  | { ok: true; id: string }
  | { ok: false; error: MutationError; currentUpdatedAt?: string };
/**
 * What delete_thought answers (migration 042). Success: `detached`, the active
 * citations the delete detached from the removed source — non-zero only when
 * `detach` was asked — and `inactive`, when present, the expired or superseded
 * citations that named it and were marked the same way in either mode. A
 * refusal may carry CITED's `citedBy` and `citations`; update_thought's never
 * does, so those live here and not on MutationResult (seventh review pass).
 */
export type DeleteResult =
  | { ok: true; id: string; detached?: number; inactive?: number }
  | { ok: false; error: MutationError; currentUpdatedAt?: string; citedBy?: number; citations?: Citation[] };
/** The three stamp keys a thought's metadata carries (050, 073), as a reset leaves them; null where the row has none. */
export type ActorStamp = { actorKind: string | null; actorName: string | null; trust: string | null };
/**
 * What the operator's reset of a capture-only key's label answers (migration
 * 086, SMD-2744). `reset` false: nothing settled the row since its capture or
 * its latest reset, and nothing was written. `restored`: a restamp had moved
 * the label, and the capture key's stamp is back. `movedBy`: the key whose
 * restamp the reset undid — the operator's own, when it moved the label since
 * the last reset. `declines`: the decline events that no longer count, and
 * `declinedBy` the keys that made them (the operator's own, when it kept the
 * label). A NOT_OPERATOR refusal carries `kind`, the registry's for the
 * caller ("capture-only" for a capture-scoped one, null when unclassified).
 * `stamp`: the row's three stamp keys after.
 * Refused: NOT_FOUND, NOT_OPERATOR (the caller is not a key the registry
 * classifies operator, or is a capture-only key), NOT_CAPTURE_STAMP (no
 * capture-only key's label the reset can put back: another key's row, a text
 * changed since, or a capture from before the scope mark).
 */
export type ResetStampError = "NOT_FOUND" | "NOT_OPERATOR" | "NOT_CAPTURE_STAMP";
export type ResetStampResult =
  | { ok: true; reset: boolean; restored: boolean; movedBy: string | null; declines: number; declinedBy: string[]; stamp: ActorStamp }
  | { ok: false; error: ResetStampError; kind?: string | null };
/**
 * Both functions' envelopes as one normaliser reads them — the superset that
 * UpdateResult and DeleteResult each narrow, so a refusal looks one way.
 */
export type MutationEnvelope =
  | { ok: true; id: string; updatedAt?: string; duplicateOf?: string; fingerprintHeldBy?: string; detached?: number; inactive?: number; stamp?: Record<string, unknown>; sameText?: boolean; metadataMerged?: boolean; patchDropped?: boolean }
  | { ok: false; error: MutationError; currentUpdatedAt?: string; citedBy?: number; citations?: Citation[] };
/**
 * `duplicateOf` (migration 018): the edit's text normalises to what the row
 * already held AND another thought carries that fingerprint — a pair from
 * before migration 003's fingerprint. The edit was kept and this row's
 * fingerprint left NULL; the caller is told so the pair can be resolved.
 */
export type UpdateResult = MutationResult & {
  updatedAt?: string; duplicateOf?: string; fingerprintHeldBy?: string;
  /** 088 (SMD-2744): the row's actor_kind, actor_name and trust after the write; whether the text counts as the same; whether the patch merged anything. Absent from a database before 088. */
  stamp?: Record<string, unknown>; sameText?: boolean; metadataMerged?: boolean;
  /** 088: the row's metadata is SQL NULL (a raw writer's), which merges no patch, and the patch named a key the server does not set. */
  patchDropped?: boolean;
};

/**
 * Both SQL functions return the same {ok, id|error} envelope; this turns it into
 * the store's discriminated union, in one place so a refusal looks one way —
 * the class of bug the audit work hit twice.
 */
export function normaliseMutation(r: Record<string, unknown> | undefined): MutationEnvelope {
  if (!r) return { ok: false, error: "NOT_FOUND" };
  if (r.ok === true) {
    return {
      ok: true,
      id: String(r.id),
      // 042's delete counts; absent on an edit's envelope and on a pre-042 body.
      detached: typeof r.detached === "number" ? r.detached : undefined,
      inactive: typeof r.inactive === "number" ? r.inactive : undefined,
      // isoTimestamp, not String: the function returns jsonb, so this arrives
      // as Postgres's `+00:00` spelling on both clients, and `fetch` prints the
      // same column through normaliseThoughtRecord. Passing the ISO value back
      // as if_unchanged_since is safe — 021 compares both sides at millisecond
      // precision.
      updatedAt: isoTimestampOpt(r.updated_at),
      duplicateOf: r.duplicate_of ? String(r.duplicate_of) : undefined,
      // Another row holds this text's key under different text — a stale
      // fingerprint — so this row could not take the fingerprint it should have.
      fingerprintHeldBy: r.fingerprint_held_by ? String(r.fingerprint_held_by) : undefined,
      // 088's answer (SMD-2744); absent before it, and read as saying nothing.
      stamp: r.stamp !== null && typeof r.stamp === "object" && !Array.isArray(r.stamp) ? (r.stamp as Record<string, unknown>) : undefined,
      sameText: typeof r.same_text === "boolean" ? r.same_text : undefined,
      metadataMerged: typeof r.metadata_merged === "boolean" ? r.metadata_merged : undefined,
      patchDropped: r.patch_dropped === true ? true : undefined,
    };
  }
  return {
    ok: false,
    error: (r.error as MutationError) ?? "NOT_FOUND",
    currentUpdatedAt: isoTimestampOpt(r.current_updated_at),
    // 042's CITED refusal: the count, and the citing rows the function sampled.
    // A number, or a string of digits (a proxy, a hand-made envelope) — and
    // nothing else: Number() alone took `true`, `""` and `[5]` for counts
    // (seventh review pass).
    citedBy: typeof r.cited_by === "number" && Number.isFinite(r.cited_by) ? r.cited_by
      : typeof r.cited_by === "string" && /^\d+$/.test(r.cited_by) ? Number(r.cited_by)
      : undefined,
    // Elements that are not objects (a truncating proxy's null) are dropped,
    // not thrown on: the refusal is still a refusal.
    citations: Array.isArray(r.citations)
      ? (r.citations as unknown[]).filter((c): c is Record<string, unknown> => c !== null && typeof c === "object").map((c) => ({
          id: String(c.id),
          thoughtId: String(c.thought_id),
          stance: String(c.stance ?? ""),
          text: String(c.text ?? ""),
          createdAt: isoTimestampOpt(c.created_at),
        }))
      : undefined,
  };
}

/**
 * ob1_reset_capture_stamp's jsonb (migration 086) as the store's union. An error the function does not name, or a body
 * that is no envelope, throws: a refusal this server cannot word is a fault.
 */
export function normaliseResetStamp(r: unknown): ResetStampResult {
  const o = r !== null && typeof r === "object" ? (r as Record<string, unknown>) : undefined;
  if (o?.ok === true) {
    const word = (v: unknown): string | null => (typeof v === "string" ? v : null);
    return {
      ok: true,
      reset: o.reset === true,
      restored: o.restored === true,
      movedBy: word(o.moved_by),
      declinedBy: Array.isArray(o.declined_by) ? (o.declined_by as unknown[]).filter((n): n is string => typeof n === "string") : [],
      declines: typeof o.declines === "number" && Number.isFinite(o.declines) ? o.declines : 0,
      stamp: { actorKind: word(o.actor_kind), actorName: word(o.actor_name), trust: word(o.trust) },
    };
  }
  if (o?.ok === false && o.error === "NOT_OPERATOR") return { ok: false, error: o.error, kind: typeof o.kind === "string" ? o.kind : null };
  if (o?.ok === false && (o.error === "NOT_FOUND" || o.error === "NOT_CAPTURE_STAMP")) return { ok: false, error: o.error };
  throw new Error(`ob1_reset_capture_stamp answered no envelope this server reads: ${JSON.stringify(r)?.slice(0, 200)}`);
}

/**
 * What a re-capture did to a capture-only key's label (migration 090,
 * SMD-2898). `moved`: the label moved to the caller — `stamp` the caller's,
 * `before` the capture-only key's. `kept`: weighed now and not higher, the row
 * settled — `weighed` the trust the caller was weighed at, `own` whether the
 * caller's own later re-capture is weighed again (085 knows a key's own by its
 * agent id alone). `settled`: an earlier re-capture settled the row — `by` a
 * restamp (`mine` when the stamp is the caller's own) or a decline (`decliner`
 * its key's name, `declinerWeighed` whether 085 still weighs that key's own
 * later re-capture — a decline naming its agent id). `unweighed`:
 * the caller's key has no kind, so nothing was weighed and this call settled
 * nothing. `stamp`: the row's three stamp keys after the call.
 */
export type RecaptureLabel =
  | { outcome: "moved"; stamp: ActorStamp; before: ActorStamp }
  | { outcome: "kept"; stamp: ActorStamp; weighed: string | null; own: boolean }
  | { outcome: "settled"; by: "restamp"; stamp: ActorStamp; mine: boolean }
  | { outcome: "settled"; by: "decline"; stamp: ActorStamp; decliner: string | null; declinerWeighed: boolean }
  | { outcome: "unweighed"; stamp: ActorStamp };

/**
 * ob1_weigh_recapture's jsonb (migration 090) as the store's label. `none`, an outcome this server does not know, or
 * a body that is no envelope (085's boolean, from the function before 090)
 * is no label: the capture landed, and the reply says what it said before.
 */
export function normaliseRecaptureLabel(r: unknown): RecaptureLabel | undefined {
  const o = r !== null && typeof r === "object" && !Array.isArray(r) ? (r as Record<string, unknown>) : undefined;
  const word = (v: unknown): string | null => (typeof v === "string" ? v : null);
  const stampOf = (v: unknown): ActorStamp | undefined => {
    if (v === null || typeof v !== "object" || Array.isArray(v)) return undefined;
    const m = v as Record<string, unknown>;
    return { actorKind: word(m.actor_kind), actorName: word(m.actor_name), trust: word(m.trust) };
  };
  const stamp = stampOf(o?.stamp);
  if (!o || !stamp) return undefined;
  switch (o.outcome) {
    case "moved": { const before = stampOf(o.before); return before ? { outcome: "moved", stamp, before } : undefined; }
    case "kept": return { outcome: "kept", stamp, weighed: word(o.weighed), own: o.own === true };
    case "settled":
      return o.by === "restamp" ? { outcome: "settled", by: "restamp", stamp, mine: o.mine === true }
        : o.by === "decline" ? { outcome: "settled", by: "decline", stamp, decliner: word(o.decliner), declinerWeighed: o.decliner_weighed === true } : undefined;
    case "unweighed": return { outcome: "unweighed", stamp };
    default: return undefined;
  }
}

/**
 * Who performed a mutation, as the audit trigger reads it. Carried on the
 * `ob1.actor` transaction setting — see migration 008.
 *
 * One definition rather than the eight inline copies this used to be: adding
 * `agentId` for migration 010 would otherwise have meant editing the same
 * anonymous type in three files, and missing one would have silently dropped
 * the attribution on whichever path was missed.
 */
export type Actor = {
  /** The access key's name, from auth.ts. Never the key. */
  name: string;
  /**
   * The door the write came through — this server's name. Migration 046
   * stamps it as thought_audit.origin (SMD-1730); until then the server sent
   * `source: "mcp"`, which the trigger wrote over the row's own
   * metadata.source and the column carried three vocabularies. The trigger
   * reads no actor `source` any more, so there is no field for one here.
   */
  via?: string;
  session?: string;
  /**
   * Stable id from ob1_agents. Absent when the registry is unreachable or
   * migration 010 is not applied; the audit row then carries the name alone,
   * which is exactly the pre-010 behaviour rather than a new failure.
   */
  agentId?: string;
  /**
   * The egress gate's decisions for this write (SMD-1903): which endpoint
   * was, or was not, sent the text, and by which rule. Lands in
   * thought_audit.actor_context, where the trigger keeps every key it does
   * not read by name. Absent when both endpoints are declared local.
   */
  egress?: EgressRecord;
  /**
   * Who carried a forwarded write (SMD-2284): the forwarder key's name and
   * agent id, RFC 8693's `act`. The actor above stays the client's key. Lands
   * in thought_audit.actor_context as `act`, beside `egress` — no column of
   * its own, so no migration.
   */
  act?: { name: string; agentId?: string };
  /**
   * "capture" on a write by a key that cannot read (SMD-2638). Lands in
   * thought_audit.actor_context as `scope`, where migration 082's lapse reads
   * it: a pointer such a key wrote onto its own thought is cleared when
   * another key or board-sync takes that thought. Absent for any other key.
   */
  scope?: "capture";
  /**
   * Why a capture whose embedding call the gate allowed landed without its
   * vector (SMD-2888): the provider did not answer — providerDown's word,
   * `provider_unreachable`, `provider_timeout` or `provider_<status>`. Lands
   * in thought_audit.actor_context as `vector_failed`, beside `egress`, so
   * the audit row says which of the two left the row vectorless. Absent
   * when the vector landed or the call was not made.
   */
  vectorFailed?: string;
  /**
   * A write background work made, not a caller's: the vector mender's
   * (SMD-2889), and a re-embed follower's (db/reembed.ts --follow, which the
   * sleep scheduler runs, SMD-2679). Lands in thought_audit.actor_context as
   * `background`, which db/sleep.ts reads past as it reads past an ingested
   * write. No caller's write through the server carries it.
   */
  background?: string;
};

/**
 * The wire form of an Actor: exactly the keys the audit trigger reads.
 *
 * This function exists because the trigger reads `actor->>'agent_id'` and the
 * TypeScript field is `agentId`. Passing the object through unchanged type-checks
 * cleanly, runs without error, and writes NULL into canonical_agent_id on every
 * row — the failure is invisible until someone queries the column months later
 * and finds it empty. Every write goes through here.
 */
export function actorPayload(actor: Actor | undefined): Record<string, unknown> | null {
  if (!actor) return null;
  return {
    name: actor.name,
    ...(actor.via !== undefined ? { via: actor.via } : {}),
    ...(actor.session !== undefined ? { session: actor.session } : {}),
    ...(actor.agentId !== undefined ? { agent_id: actor.agentId } : {}),
    ...(actor.egress !== undefined ? { egress: actor.egress } : {}),
    // agent_id, not agentId — the trigger's spelling, as for the actor itself.
    ...(actor.act !== undefined ? { act: { name: actor.act.name, ...(actor.act.agentId !== undefined ? { agent_id: actor.act.agentId } : {}) } } : {}),
    ...(actor.scope !== undefined ? { scope: actor.scope } : {}),
    ...(actor.vectorFailed !== undefined ? { vector_failed: actor.vectorFailed } : {}),
    ...(actor.background !== undefined ? { background: actor.background } : {}),
  };
}

/**
 * The `p_payload` envelope `upsert_thought` has read since migration 004:
 * `metadata`, plus `actor` (008, the audit trail) and `embedding_model` (021,
 * the label beside the vector) when given. Built here, so a key the caller
 * forgot is a compile error rather than a NULL label.
 */
export function captureEnvelope(
  payload: { metadata: Record<string, unknown> },
  actor: Actor | undefined,
  embeddingModel: string | undefined,
  /**
   * Migration 025 (SMD-1253): what this thought was derived from, and which it
   * supersedes. Rides the envelope like the actor and the model, so
   * upsert_thought validates it in one place. Absent
   * keys mean "no provenance"; upsert_thought refuses a malformed derived_from.
   */
  provenance?: { derivedFrom?: string[]; supersedes?: string },
  /**
   * Migration 061 (SMD-1731): the recipes of the windows and the tags this
   * capture carries, recorded in `derivations` with the write. Absent: no
   * `lineage` key, and upsert_thought records nothing for the tags.
   */
  lineage?: Lineage,
  /**
   * Migration 046's write event (SMD-1730), `p_payload.event`: what the write
   * declares about itself, which validate_write_event checks. The server
   * declares one key, the content's trust (SMD-1724), which 073 clamps to the
   * key's kind — a lowering stands, a raise is filed as a claim. Absent: no
   * `event` key, the key's trust.
   */
  event?: WriteEvent,
  /**
   * Migration 080 (SMD-2539), `p_payload.recapture`: "keep" leaves a row that
   * already holds the text as it is — no metadata merge, no event, save a
   * vector it lacks. Absent: the merge, which a database before 080 does
   * whatever this says.
   */
  recapture?: "keep"
): Record<string, unknown> {
  return {
    ...payload,
    ...(recapture !== undefined ? { recapture } : {}),
    ...(event?.trust !== undefined ? { event: { trust: event.trust } } : {}),
    ...(actor ? { actor: actorPayload(actor) } : {}),
    ...(embeddingModel !== undefined ? { embedding_model: embeddingModel } : {}),
    ...(provenance?.derivedFrom !== undefined ? { derived_from: provenance.derivedFrom } : {}),
    ...(provenance?.supersedes !== undefined ? { supersedes: provenance.supersedes } : {}),
    ...(lineage !== undefined ? { lineage } : {}),
  };
}

/** What a write declares about itself (046's event): the one key this server sends. */
export type WriteEvent = { trust?: string };

/**
 * The provenance an edit names (migration 032). Each key is tri-state at the
 * type level: absent (leave the column), null (clear it), a value (set it).
 */
export type UpdateProvenance = { derivedFrom?: string[] | null; supersedes?: string | null };

/**
 * update_thought's `p_provenance` (032) from an edit's `provenance`: the keys
 * the caller named, and only those — an absent key must reach the function
 * absent, not as null, since null means CLEAR there. NULL when nothing was
 * named, so an edit without provenance sends what an 8-argument caller does.
 * Built here, as captureEnvelope is.
 */
export function provenanceEnvelope(p: UpdateProvenance | undefined): Record<string, unknown> | null {
  if (!p) return null;
  const env: Record<string, unknown> = {
    ...(p.derivedFrom !== undefined ? { derived_from: p.derivedFrom } : {}),
    ...(p.supersedes !== undefined ? { supersedes: p.supersedes } : {}),
  };
  return Object.keys(env).length ? env : null;
}

/**
 * What resolve_agent() answered. See migration 010 and agents.ts.
 *
 * The failure arm is two literal variants rather than one with `error: string`,
 * so `error === "REVOKED"` narrows. With a plain string there, the revoked case
 * kept none of its fields at the type level and the compiler could not tell a
 * refusal that must reject the request from one that must not.
 */
export type AgentResolution =
  | { ok: true; agentId: string; label: string; created: boolean; rotated: boolean; labelConflict: boolean }
  | { ok: false; error: "REVOKED"; agentId: string; revokedAt: string; reason: string | null }
  /** Anything else the function said, kept verbatim in `detail` rather than flattened away. */
  | { ok: false; error: "UNRESOLVED"; detail: string };

/**
 * Turn resolve_agent()'s jsonb into an AgentResolution.
 *
 * Defensive about the shape rather than trusting it: a deployment running
 * migration 010 from before a later change, or an older function left behind by
 * an incomplete reset, would otherwise produce `agentId: undefined` that reads
 * as a successful resolution everywhere downstream.
 */
export function normaliseAgentResolution(raw: unknown): AgentResolution {
  const r = (raw ?? {}) as Record<string, unknown>;
  if (r.ok === true && typeof r.agent_id === "string") {
    return {
      ok: true,
      agentId: r.agent_id,
      label: String(r.label ?? ""),
      created: r.created === true,
      rotated: r.rotated === true,
      labelConflict: r.label_conflict === true,
    };
  }
  if (r.error === "REVOKED" && typeof r.agent_id === "string") {
    return {
      ok: false,
      error: "REVOKED",
      agentId: r.agent_id,
      revokedAt: isoTimestampOpt(r.revoked_at) ?? "",
      reason: typeof r.reason === "string" ? r.reason : null,
    };
  }
  return {
    ok: false,
    error: "UNRESOLVED",
    detail: typeof r.error === "string" ? r.error : "MALFORMED_RESPONSE",
  };
}

/**
 * A 'search' row for the opt-in query log (migration 034, SMD-1295): the query
 * and its arguments, and the ids returned in rank order with their fused scores.
 * `agentId` is 010's agent when a key was presented, else absent (NULL in the
 * row). `resultScores` is aligned to `resultIds`; a null element is a returned
 * id whose score the retrieval path did not carry.
 */
export type QuerySearchLog = {
  tool: string;
  agentId?: string;
  query: string;
  matchCount: number;
  threshold: number;
  recencyWeight: number;
  filter: Record<string, unknown>;
  resultIds: string[];
  resultScores: (number | null)[];
  /** Which retrieval arm served the row: 'hybrid', 'keyword' (SMD-1490), 'current' — search_thoughts with prefer_current (059, SMD-2255) — or 'literal': search or search_thoughts answered by its exact matches alone — its literals, then the query as one text — while the provider could not embed the query (106, SMD-2891). */
  arm?: string;
  /** The tier the writing server runs as: stable|canary|working, else absent (SMD-1806). */
  tier?: string;
};

/**
 * An 'action' row for the query log: a fetch/edit/delete of a returned id, or
 * (SMD-1719) a write that named it as a source — `tool` is `<writer>/<pointer>`.
 * Carries only the acting tool, the agent, and the id touched — export links it
 * back to the search that returned the id.
 */
export type QueryActionLog = {
  tool: string;
  agentId?: string;
  targetId: string;
  /** The tier the writing server runs as: stable|canary|working, else absent (SMD-1806). */
  tier?: string;
};

export interface ThoughtStore {
  /** The store's name, on each operation's span (`ob1.store`). One since SMD-3152. */
  readonly kind: "sql";

  matchThoughts(opts: {
    embedding: number[];
    threshold: number;
    limit: number;
    filter: Record<string, unknown>;
  } & RecencyOpts): Promise<ThoughtMatch[]>;

  /**
   * Exact substring search over `content`, case-insensitive. Migration 012.
   *
   * The store passes the query through untouched: `%` and `_` are escaped inside
   * the SQL function, not here, so no caller can be the one that forgets.
   */
  keywordThoughts(opts: {
    query: string;
    limit: number;
    offset: number;
    filter: Record<string, unknown>;
    /**
     * SMD-1724: only rows whose trust is at or above this word (074's
     * ob1_trust_rank; a row with none is below every word). Sent only when
     * set, so a brain before migration 074 answers every search without it as
     * before, and refuses one with it by name ("does not exist").
     */
    minTrust?: string;
  }): Promise<ThoughtKeywordMatch[]>;

  /**
   * The literals 017's extract_search_needles takes from `query`, in its
   * order, each with whether more thoughts hold it than one keyword page —
   * 075's own rarity probe, unfiltered (SMD-2891). Its answer is read as
   * absent or too common only once no unfiltered search matched a literal
   * (answerWithoutVector's literal arm, or its probe for a filtered search).
   * Never a count (a count read the whole match set, seconds per needle), and
   * never a bare first-row probe (it plans a
   * sequential scan, the whole table for an absent needle). `textable`: whether
   * the whole query may be matched as one text — at least three characters and
   * a word the English parser keeps, 017's rule for a quoted span, so `the`,
   * `of the` and `AI` are not substrings of nearly every thought (review pass 5),
   * and no longer than 017's 64 for a span (review pass 8: a megabyte query
   * held a pool connection for minutes).
   */
  literalFacts(query: string): Promise<{ literals: { needle: string; common: boolean }[]; textable: boolean }>;

  /**
   * The text match a search falls back to without a vector (SMD-2891): the
   * thoughts holding `query` as one text, case aside, within the filter and
   * min_trust — bounded, as search_thoughts_keyword's function is not: the
   * first TEXT_PAGE + 1 matching rows the scan meets (all of them when fewer,
   * so then the newest; past the page, not of every holder), newest first
   * within them, each row
   * carrying how many that page held (`totalCount`, TEXT_PAGE + 1 meaning
   * more than TEXT_PAGE). Review pass 8: the keyword function counts and
   * scores its whole match set — 5.4 s for a word in nearly every thought at
   * 200,000, which during an outage held every pool connection.
   */
  textThoughts(opts: { query: string; limit: number; filter: Record<string, unknown>; minTrust?: string }): Promise<ThoughtKeywordMatch[]>;

  /**
   * The two above fused (migration 017): rank on the vector arm, presence per
   * needle on the keyword arm. `query` is the text the needles are extracted
   * from, in SQL, so every caller extracts identically; `embedding` is of that
   * same text — or null when the provider could not embed it (SMD-2891):
   * then the vector arm finds nothing and the rows are the exact-literal
   * arm's alone. Fixed top-`limit`, no paging.
   */
  hybridThoughts(opts: {
    query: string;
    embedding: number[] | null;
    threshold: number;
    limit: number;
    filter: Record<string, unknown>;
    /**
     * search_thoughts' opt-in prefer_current (SMD-2255): call 059's
     * search_thoughts_current, which ranks settled and superseded thoughts
     * below current ones, instead of search_thoughts_hybrid. Off (absent or
     * false) is today's function, and today's order.
     */
    preferCurrent?: boolean;
    /**
     * SMD-1724: only rows whose trust is at or above this word (074's
     * ob1_trust_rank; a row with none is below every word). Sent only when
     * set, so a brain before migration 075 (the 8-argument forms) answers every search without it as
     * before, and refuses one with it by name ("does not exist").
     */
    minTrust?: string;
  } & RecencyOpts): Promise<ThoughtHybridMatch[]>;

  getThought(id: string): Promise<ThoughtRecord | null>;

  listThoughts(filters: ListFilters): Promise<ThoughtListPage>;

  /** Exact row count of the whole corpus. */
  countThoughts(): Promise<number>;

  /**
   * A page of the corpus's thought ids in id order, for a cheap cross-brain
   * id-set diff (SMD-2244). `after` is a keyset cursor (exclusive, a thought id);
   * the first page (after null) also carries the corpus `total` and, where the
   * store can aggregate server-side, a `digest` of all ids — so a caller can skip
   * enumeration when two brains' digests match. Ids only: no content, no vectors.
   */
  listThoughtIds(opts: { limit: number; after: string | null }): Promise<ThoughtIdPage>;

  /**
   * A page of the thoughts with no vector (`embedding IS NULL`), in id order
   * after the keyset cursor `after` (exclusive; null for the first page), for
   * the vector mender (SMD-2889). Id order, as listThoughtIds pages: a row the
   * mender skips — refused by the gate, or failed — never holds back the rows
   * behind it.
   */
  listVectorless(opts: { limit: number; after: string | null }): Promise<VectorlessRow[]>;

  /**
   * The vector mender's leader lock (SMD-2889): both servers run a mender, and
   * a tick acts only while it holds this — a session advisory lock on a
   * connection of its own, so one mender acts at a time across processes and
   * replicas, and a process that dies lets it go with its connection. The
   * release — true when it let the lock go, false when the session that
   * took it was not the one asked (a pooler between) — or null when another
   * holds it.
   */
  mendLock(): Promise<(() => Promise<boolean>) | null>;

  /**
   * A window of the brain's logged searches (`query_log`), most recent first, for a
   * log-sourced cross-brain replay (SMD-2245). `since` bounds the window; `limit`
   * caps it (one extra row is read to set `truncated`). Empty when the log is off
   * or the window holds none. Telemetry only — no thought content, no keys.
   */
  listLoggedSearches(opts: { since: string | null; limit: number }): Promise<LoggedSearchPage>;

  /**
   * The background-work pools' state (SMD-2131), one row per `work_type` over
   * `thought_work_claims`, for a read-only queue view over MCP/REST.
   * Read-only: no lock, no reaper, no write.
   */
  workerStatus(): Promise<WorkerStatusRow[]>;

  /**
   * The heartbeat rows of ob1_config, parsed as brain_info reads them — each
   * pass's and the coordinator's — for the status surface (task_status,
   * SMD-3476 PR 3). Read-only.
   */
  heartbeats(): Promise<HeartbeatRead>;

  /**
   * Requeue a pool's `failed` claim rows to `pending` (SMD-2132) — the write
   * half of `worker_status`, the `db/*.ts --retry-failed` path over a tool. One
   * statement, scoped to `workType` alone (`WHERE work_type = $1 AND status =
   * 'failed'`), resetting `last_error`, `finished_at` and `attempt_count`. The caller has already been gated to a write
   * key; this method does the mutation and returns the ids for the audit log.
   */
  retryFailed(workType: string): Promise<RetryFailedResult>;

  /**
   * Return `claimed` rows to the pool (SMD-2132) — the write half of
   * `worker_status`, the `SELECT release_claims_for_worker(...)` path over a
   * tool. By default only leases past `ttl_expires_at` (a dead worker's) are
   * released; `includeLive` (which requires a `workerId`) reaches a live lease.
   * Mirrors migration 015's release SET — `status='pending'`, TTL cleared,
   * `attempt_count` decremented (an un-run lease is not penalised). SQL-backend
   * only — the shim throws. The caller gates the write scope; the live-lease
   * refusal is the caller's (a store method cannot answer as a value).
   */
  releaseStaleLeases(opts: ReleaseLeasesOpts): Promise<ReleaseLeasesResult>;

  /**
   * Preview what a `run_worker` drain over one pool would process, claiming
   * nothing (SMD-2272) — the `dry_run: true` half of `run_worker`. A pure SELECT:
   * the same per-work_type census `workerStatus` reports (so the two agree), plus
   * the drainable `backlog` (`pending + unpooled`) and `wouldClaim` (that backlog
   * bounded by `limit`). No claim, no enqueue, no lease — the guard's "claims
   * nothing (pure SQL)". SQL-backend only, like the sibling worker methods; the
   * shim throws. The executing drain is deferred to SMD-2304's callable core.
   */
  dryRunClaim(workType: string, limit?: number): Promise<DryRunClaimResult>;

  /**
   * Everything thought_stats needs, aggregated by the store: migration 024's
   * thought_stats_summary(), the whole corpus in one statement,
   * `aggregated === total`, no cap.
   */
  statsSummary(): Promise<ThoughtStats>;

  /**
   * What the database says about itself — Postgres and pgvector versions, the
   * schema version and ledger, row counts, size, HNSW parameters — for
   * brain_info and the keyed /health body (SMD-2041). The SQL store runs
   * brain-info.ts's readDatabaseFacts over its pool, the reads preflight's rows
   * make. A store that refuses leaves the record the server's own facts and
   * says why the database's are missing.
   */
  databaseFacts(opts?: ReadOptions, progress?: ReadProgress): Promise<DatabaseFacts>;

  /**
   * One page of metadata, newest first — what scan_thoughts' job walks
   * (core/reads.ts scanThoughts); `statsSummary` does not need it.
   */
  pageThoughtMeta(offset: number, limit: number): Promise<ThoughtMeta[]>;

  /**
   * Store content, metadata and embedding. Implementations must make this as
   * close to atomic as their transport allows: a row committed without its
   * embedding is invisible to every semantic search.
   */
  captureThought(opts: {
    content: string;
    /**
     * Who is writing, for the audit trail (migrations 008 and 010). Optional
     * because a mutation from a script legitimately has no principal — the audit
     * row then records a NULL actor, which is more honest than a placeholder.
     * The actor rides in the payload envelope; `upsert_thought` has read one
     * since migration 004.
     */
    actor?: Actor;
    payload: { metadata: Record<string, unknown> };
    /**
     * NULL when the egress gate refused the embedding call (SMD-1903) or the
     * provider did not answer it (SMD-2888): the row lands with its text and
     * fingerprint and no vector — findable by exact text, absent from semantic
     * search until the servers' vector mender embeds it (SMD-2889). Any
     * other failed call still fails the capture.
     */
    embedding: number[] | null;
    /**
     * Per-window embeddings for a capture too long to embed in one provider call.
     * Empty or absent for ordinary short thoughts, which stay exactly as they
     * were: one row, one vector, no chunk rows. See chunk.ts and migration 007.
     */
    chunks?: { content: string; embedding: number[]; context?: string }[];
    /**
     * The model that produced `embedding` (and the chunks'), as
     * OB1_EMBEDDING_MODEL names it — recorded on the row since migration 021 so
     * preflight and the re-embed can tell which model a vector is at. Absent
     * leaves the row's label unknown, which is what an older server's capture
     * is. Rides in the payload envelope, as the actor does.
     */
    embeddingModel?: string;
    /**
     * Migration 025 (SMD-1253). `derivedFrom` is the source thoughts a derived
     * artifact (digest, synthesis, consolidation) was built from — an array of
     * existing thought ids, validated by upsert_thought or the write is refused.
     * `supersedes` is the one prior thought this one replaces. Both ride the
     * envelope; both absent is an ordinary first-hand capture. Written on a
     * FIRST capture only (migration 035): a re-capture of text that exists
     * leaves that thought's provenance as it is and reports `existed`.
     */
    derivedFrom?: string[];
    supersedes?: string;
    /**
     * Migration 061 (SMD-1731): the recipes of what this capture derived —
     * `chunks` when it made windows (the split's parameters, the blurb model),
     * `metadata` when the server's extractor wrote the tags (its model, prompt
     * version and hash). Recorded in `derivations` in the write's own
     * transaction; an absent key is no derivation, so a caller's own tags get
     * no row. Rides the envelope, as the actor and the provenance do.
     */
    lineage?: Lineage;
    /**
     * Migration 046's write event, riding the envelope (captureEnvelope):
     * capture_thought's `trust` (SMD-1724), the content's trust as the write
     * declares it — clamped to the key's kind by 073. Absent: the key's.
     */
    event?: WriteEvent;
    /**
     * Migration 080 (SMD-2539): "keep" for a key that cannot read — a capture
     * that lands on an existing row writes nothing to it but a vector the row
     * lacks. Absent: the merge (035). Rides the envelope (captureEnvelope).
     */
    recapture?: "keep";
  }): Promise<CaptureResult>;

  /**
   * Edit a thought. `content` absent leaves the text, embedding and chunks
   * alone; `metadataPatch` shallow-merges. `ifUnchangedSince` is checked as a
   * predicate on the write, not before it, so it cannot lose a race.
   */
  updateThought(opts: {
    id: string;
    content?: string;
    metadataPatch?: Record<string, unknown>;
    embedding?: number[];
    chunks?: { content: string; embedding: number[]; context?: string }[];
    ifUnchangedSince?: string;
    actor?: Actor;
    /** As on captureThought; read only when `content` is given, since the label follows the vector (021). */
    embeddingModel?: string;
    /**
     * Migration 032 (SMD-1323): set, change or clear a thought's provenance
     * through the edit path. A key ABSENT leaves that column alone; `null`
     * CLEARS it; a value sets it — `supersedes` an existing thought that
     * closes no loop (else SUPERSEDES_NOT_FOUND / WOULD_CYCLE), `derivedFrom`
     * an array of existing thought ids, replacing the array (the write throws
     * on a malformed one, as capture does). Sent as update_thought's ninth
     * argument, `p_provenance`, in the envelope shape capture uses; absent
     * altogether sends NULL.
     */
    provenance?: UpdateProvenance;
    /** As on captureThought (061): the windows' recipe with content, the tags' when the extractor wrote the patch. Sent as update_thought's eleventh argument, `p_lineage`. */
    lineage?: Lineage;
  }): Promise<UpdateResult>;

  /**
   * Hard delete. Chunks cascade; migration 008 preserves the prior content.
   * Refused as CITED (migration 042) while active citations rest on the
   * thought, unless `detach` — then each citing row keeps its text and stance,
   * loses its source and records the deleted id and time, and the result
   * says how many.
   */
  deleteThought(opts: {
    id: string;
    actor?: Actor;
    detach?: boolean;
  }): Promise<DeleteResult>;

  /**
   * The operator's reset of a capture-only key's label that a re-capture
   * settled or moved (migration 086, SMD-2744): ob1_reset_capture_stamp,
   * which decides who may — a key the registry classifies operator — and
   * appends the event in the actor's name. A database before 086 has no such
   * function, and the call throws.
   */
  resetCaptureStamp(opts: {
    id: string;
    actor?: Actor;
  }): Promise<ResetStampResult>;

  /**
   * A supersession proposal's decision (SMD-3338): proposal-review.ts's guard
   * — a lineage pair (070), a WRITER flag (094) — and 029's review, what its
   * lapse cleared (082) and the reviewer the row records (114), in one
   * transaction, the CLI's --accept/--reject's own. The review function runs
   * as the caller (029, SECURITY INVOKER): a role without UPDATE on
   * supersession_proposals throws, as does a database before 029.
   */
  reviewProposal(opts: {
    id: string;
    decision: "accept" | "reject";
    note?: string;
    direction?: "newer" | "older";
    force?: boolean;
    actor?: Actor;
  }): Promise<ReviewResult>;

  /**
   * Resolve a key digest and its configured name to a stable agent id,
   * registering the pair on first sight. Migration 010.
   *
   * A failure throws with the SQLSTATE on the error's `errno` (Bun's SQL sets
   * it): agents.ts reads
   * 55P03, 57014, 40P01 and 40001 as a registry busy — a lock timeout or a
   * serialization failure — retried and then refusing the key; 42883, 42P01,
   * 23514 and 42501 as misconfigured, served by name with no retry offered to
   * a capture key's `supersedes` (SMD-2473); and anything else as an outage,
   * which serves it by name (SMD-2072, SMD-2090).
   */
  resolveAgent(opts: { keyHash: string; label: string; scope?: string }): Promise<AgentResolution>;

  /**
   * Who captured a thought: the actor of its `capture` audit row (008) — the
   * key's name, and since 010 its agent id — or null when nothing captured it
   * through the server (a load by hand, a brain from before 008). Read by
   * capture_thought when a capture-only key names `supersedes` (SMD-1298): that
   * key may replace only what it wrote. A malformed id is null, not an error.
   */
  captureActorOf(id: string): Promise<{ actorName: string | null; agentId: string | null } | null>;

  /**
   * Whether another key or board-sync has taken the thought from the agent
   * that captured it: migration 082's ob1_thought_taken, the one rule — a
   * re-capture by a key that can read, a text edit, board-sync (no agent id)
   * giving the metadata a ticket's `issue`, or (092, SMD-2708) its
   * supersedes chain reaching a thought its capturer did not capture — a
   * reviewer's accept or another key's pointer, through any number of links;
   * a key's metadata edit never. Read beside
   * captureActorOf for every target of a capture-only key's `supersedes`
   * (SMD-2638). A malformed id is true, never owned; a database before 082
   * throws (the function is missing), and the pointer is the server's to
   * retry, as for an unreadable capture row.
   */
  takenFromCapturer(id: string): Promise<boolean>;

  /**
   * Which of the given ids are thoughts, lower-cased. Read after upsert_thought
   * refuses a `derived_from` — 025 names the whole list in its message — so the
   * reply can name the POSITIONS that name no thought and a caller can drop
   * exactly those (SMD-1298). Malformed ids are simply not in the answer.
   */
  existingIds(ids: string[]): Promise<Set<string>>;

  /**
   * The thought each name names (SMD-3314, migration 112): the one with that
   * id, else the one keeping it as metadata.client_key — a map from each
   * lower-cased name that names one to its id, lower-cased. A name that is
   * not a UUID, or names nothing, is not in the map.
   */
  thoughtsNamed(names: string[]): Promise<Map<string, string>>;

  /**
   * The thought already holding this text, by 003's fingerprint, and the
   * client_key it keeps (null for none) — or null when no thought holds it.
   * Read before a keyed capture, which lands on that row (080's merge): a
   * row keeping another key keeps it (SMD-3314).
   */
  keyAtText(content: string): Promise<{ id: string; clientKey: string | null } | null>;

  /**
   * Migration 025's read-back. traceProvenance walks UP the derived_from chain
   * (ancestors, depth 0 = the thought itself); findDerivatives looks DOWN it
   * (what was derived from this, one level). Both are SQL functions,
   * cycle-guarded and capped in SQL. No MCP tool exposes them yet; they back
   * db/test-live.ts and a future read API.
   */
  traceProvenance(opts: { id: string; maxDepth?: number; nodeCap?: number }): Promise<ProvenanceNode[]>;
  findDerivatives(opts: { id: string; limit?: number }): Promise<Derivative[]>;

  /**
   * Of the given thought ids, which have been superseded, mapped to the newest
   * thought that supersedes each. One query over the `supersedes` column (025).
   * The read tools use it to LABEL a search hit a newer thought has replaced —
   * the guaranteed-shipping half of the retrieval decision (SMD-1253); the
   * ranking half is search_thoughts' opt-in prefer_current (059, SMD-2255),
   * priced by eval-supersession.ts. Empty when nothing given or
   * nothing superseded; best-effort, so a pre-025 database returns an empty map
   * rather than breaking search — preflight's `provenance` check names the fix.
   */
  supersededAmong(ids: string[]): Promise<Record<string, string>>;

  /**
   * What the stated-status label reads (migration 095, SMD-2540): which of
   * these hits carry a lifecycle of their own, and each named ticket's status
   * now and history in the log's order. One query, none when no ticket is
   * named (nothing to label). Best-effort, as supersededAmong: a database
   * before 095, or a role without the order's ob1_config grant, returns null —
   * the hits go unlabelled and the search goes on. Never throws: a row 095
   * does not return is skipped (normaliseTicketStatusInputs), so a server
   * older than its brain's function loses labels, not searches.
   */
  ticketStatusInputs(ids: string[], tickets: string[]): Promise<TicketStatusInputs | null>;

  /**
   * Migration 029's review queue (SMD-1294): the pairs db/consolidate.ts
   * judged to conflict, in one status (null for every status), most confident
   * first, each with both thoughts. Read-only — accepting or rejecting is the
   * worker's --accept / --reject, through review_supersession_proposal, so the
   * write to thoughts.supersedes has one path. Throws on a schema before 029;
   * the tool names the migration.
   */
  /** `lineage` true selects the proposals standing on a lineage pair, false the rest, absent every pair (migration 070, SMD-2313). */
  listSupersessionProposals(opts: { status?: "pending" | "accepted" | "rejected" | "stale" | null; limit?: number; lineage?: boolean; judgeKey?: string; after?: ProposalPosition }): Promise<ProposalPage>;

  /**
   * Migration 052's change feed (SMD-1296): one page of thought_audit, oldest
   * first, from a time or a cursor — see ChangeFilters. One function, so the bounds, the order and the bounded rendering are
   * decided once, in SQL. Throws on a schema before 052 (the tool names the
   * migration), on a cursor that names no row, on an unknown action, and on a
   * time beside a cursor — each by the function's own message.
   */
  listChanges(filters: ChangeFilters): Promise<AuditChange[]>;

  /**
   * The opt-in query log (migration 034, SMD-1295). The server calls these ONLY
   * when OB1_QUERY_LOG=on, and the call is best-effort: the handler swallows any
   * rejection so a log write can never fail a search, a fetch or a capture.
   * Nothing reads them on the hot path — the export tool reads the table offline.
   * `logSearch` records one search call and the ids it returned; `logActions`
   * records, in one statement, the later fetch/edit/delete rows of returned
   * ids and the rows of a write that cited them (`<writer>/<pointer>`,
   * SMD-1719) — the one writer of action rows. They are NOT joined at
   * write time (there is no request token in the handlers); export links them by
   * (agent, id, window). A store on a schema before 034 will reject — that is
   * why the calls are guarded and swallowed, not why they are skipped.
   */
  logSearch(row: QuerySearchLog): Promise<void>;
  /**
   * The action rows of one call in one round trip — a fetch's single row, an
   * edit's opened row beside its cite, a capture's cite per source (SMD-1719).
   * One writer for every action row, so there is one INSERT shape to keep
   * right; an empty list writes nothing.
   */
  logActions(rows: QueryActionLog[]): Promise<void>;

  /**
   * The durable backing store for the async job registry (SMD-2318, migration
   * 069's `jobs` table), or null when this store cannot hold one (a test's
   * fake: the registry then stays in memory). The SQL store returns a sink.
   * root.ts injects the result into jobs.ts (`setJobSink`) at
   * startup and runs the reconcile once. `door` names the server it writes
   * for (078's jobs.door): the jobs it starts carry it, and its reconcile
   * touches only rows bearing it, so two servers on one database leave each
   * other's live jobs alone (SMD-2284).
   */
  jobSink(door: string): JobSink | null;

  /**
   * A plugin's own tables (SMD-2310): `fn` runs in one transaction as the
   * plugin's role, its schema first on the path, handed a tagged template and
   * nothing else. Optional for a test's fake; a plugin that reaches for its
   * tables on a store without it is told so.
   */
  pluginTx?<T>(plugin: string, fn: (sql: PluginSql) => Promise<T>): Promise<T>;

  close(): Promise<void>;
}

/** A plugin's SQL (SMD-2310): a tagged template whose values are bound parameters, answered as rows. */
export type PluginSql = <R = Record<string, unknown>>(strings: TemplateStringsArray, ...values: unknown[]) => Promise<R[]>;

export type StoreEnv = {
  /**
   * Holding a postgres:// URL, the SQL store's connection string (see
   * databaseUrl): compat/supabase-sql reads a Postgres URL from this name for
   * every vendored server migrated onto it, so a box running one of those
   * beside this server sets one variable, not two.
   */
  SUPABASE_URL?: string;
  /** The SQL store's connection string. Read before SUPABASE_URL. */
  DATABASE_URL?: string;
  /** "sql", the only store, or unset. `postgrest` is refused by name (SMD-3152). */
  OB1_STORE?: string;
  /** The password of the login role plugins' SQL runs on (db/config.mjs's PLUGIN_LOGIN_ROLE, SMD-2310); unset, a plugin's tables are refused. */
  OB1_PLUGIN_DB_PASSWORD?: string;
};

/** What an unset OB1_STORE selects. */
export const DEFAULT_STORE = "sql";

/** The store OB1_STORE names, lower-cased; DEFAULT_STORE when it is unset. */
export function storeKind(env: StoreEnv): string {
  return (env.OB1_STORE ?? DEFAULT_STORE).toLowerCase();
}

/** A libpq-style connection string — what the SQL store dials. */
export function isPostgresUrl(value: string | undefined): boolean {
  return typeof value === "string" && /^postgres(ql)?:\/\//i.test(value.trim());
}

/**
 * The SQL store's connection string and which variable supplied it:
 * DATABASE_URL first; else SUPABASE_URL when it holds a postgres:// URL — the
 * spelling compat/supabase-sql takes, so a deployment of a shim-migrated
 * vendored server beside this one sets that name once and both read it. An
 * https:// SUPABASE_URL is never dialled as Postgres (missingDatabaseUrl says
 * so).
 */
export function databaseUrl(env: StoreEnv): { url: string; from: "DATABASE_URL" | "SUPABASE_URL" } | null {
  if (env.DATABASE_URL) return { url: env.DATABASE_URL, from: "DATABASE_URL" };
  if (isPostgresUrl(env.SUPABASE_URL)) return { url: env.SUPABASE_URL!.trim(), from: "SUPABASE_URL" };
  return null;
}

/**
 * Why the SQL store with no connection string is refused — one message for
 * createStore's throw and preflight's DATABASE_URL check, so the two cannot
 * disagree about what to set. Says so when SUPABASE_URL holds a URL that is
 * not a connection string (an https:// one, the retired PostgREST store's
 * base URL), so the alias is not taken for set.
 */
export function missingDatabaseUrl(env: StoreEnv): { problem: string; fix: string } {
  const selected = env.OB1_STORE === undefined ? "OB1_STORE is unset, which selects the SQL store" : `OB1_STORE=${env.OB1_STORE} selects the SQL store`;
  const otherUrl = Boolean(env.SUPABASE_URL) && !isPostgresUrl(env.SUPABASE_URL);
  return {
    problem: `${selected}, and DATABASE_URL is not set${otherUrl ? " — SUPABASE_URL holds a non-postgres:// URL, not a connection string" : ""}`,
    fix: "Set DATABASE_URL to the brain's postgres:// connection string.",
  };
}

/**
 * The refusal for OB1_STORE=postgrest: the PostgREST store was kept for a
 * Cloudflare Workers target no brain ran, and SMD-3152 retired both. One
 * message for createStore and preflight's `store selection` row.
 */
export const POSTGREST_RETIRED =
  "OB1_STORE=postgrest selected the PostgREST store, which was retired with the Cloudflare Workers target (SMD-3152): " +
  "the SQL store is the only one. Unset OB1_STORE and set DATABASE_URL to the brain's postgres:// connection string.";

/**
 * A connection string with its credentials blanked, for any line a report
 * prints. The userinfo ends at the first `/` after the scheme and the LAST `@`
 * before that closes it: a raw `@` inside a password (invalid, but seen) is
 * blanked with the rest, and an `@` later in the URL — a query parameter's
 * value — is not taken for one. The first version's `[^@]*@` stopped at the
 * first `@`, printing a password's tail and blanking such a host (second
 * review pass).
 */
export function maskUrl(url: string): string {
  return url.replace(/:\/\/[^/]*@/, "://***@");
}

/**
 * Whether each member of a store is an operation the core calls, spanned as
 * one (tracedStore): every member named, so one added to ThoughtStore is
 * decided here or the typecheck fails. The job sink's maker and the close are
 * not.
 */
const STORE_OPERATIONS: Record<Exclude<keyof ThoughtStore, "kind">, boolean> = {
  matchThoughts: true, keywordThoughts: true, hybridThoughts: true, literalFacts: true, textThoughts: true, getThought: true, listThoughts: true, countThoughts: true,
  listThoughtIds: true, listVectorless: true, mendLock: false, listLoggedSearches: true, workerStatus: true, heartbeats: true, retryFailed: true, releaseStaleLeases: true, dryRunClaim: true,
  statsSummary: true, databaseFacts: true, pageThoughtMeta: true, captureThought: true, updateThought: true, deleteThought: true,
  resetCaptureStamp: true, reviewProposal: true, resolveAgent: true, captureActorOf: true, takenFromCapturer: true, existingIds: true, thoughtsNamed: true, keyAtText: true, traceProvenance: true,
  findDerivatives: true, supersededAmong: true, ticketStatusInputs: true, listSupersessionProposals: true, listChanges: true, logSearch: true, logActions: true,
  pluginTx: true, jobSink: false, close: false,
};

/**
 * The store with each operation the core calls run under a client span of its
 * own, a child of the call that made it, and a point on
 * `db.client.operation.duration` (spans.ts withStoreSpan, SMD-1849 PR 2d):
 * the operation's name, the store's kind and a fault's SQLSTATE — no query, no
 * parameter. A plugin's transaction is an internal span, `pluginTx` with its
 * plugin, and no point: it runs the plugin's own code and SQL, and the
 * operations it calls are spans and points of their own (review pass 1). Every other member
 * is the store's own, each method called on the store itself, not this
 * wrapper.
 */
export function tracedStore(store: ThoughtStore): ThoughtStore {
  return new Proxy(store, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop, target);
      if (typeof value !== "function") return value;
      const method = value as (...args: unknown[]) => unknown;
      if (typeof prop !== "string" || !Object.hasOwn(STORE_OPERATIONS, prop) || !STORE_OPERATIONS[prop as keyof typeof STORE_OPERATIONS]) return method.bind(target);
      if (prop === "pluginTx") {
        return (...args: unknown[]) => withSpan("pluginTx", {
          attributes: { "db.system.name": "postgresql", "ob1.store": target.kind, "ob1.plugin": typeof args[0] === "string" && PLUGIN_NAME_RE.test(args[0]) ? args[0] : "?" },
        }, async () => method.apply(target, args));
      }
      return (...args: unknown[]) => withStoreSpan(prop, target.kind, async () => method.apply(target, args));
    },
  });
}

/**
 * Build the configured store, each operation spanned (tracedStore). The SQL
 * implementation is imported here, not at the top: store-sql.ts imports this
 * file's normalisers, and a static import back would make the two a cycle.
 */
export async function createStore(env: StoreEnv): Promise<ThoughtStore> {
  const kind = storeKind(env);

  if (kind === "sql") {
    const conn = databaseUrl(env);
    if (!conn) {
      const { problem, fix } = missingDatabaseUrl(env);
      throw new Error(`${problem}. ${fix}`);
    }
    const { SqlStore } = await import("./store-sql.ts");
    // Plugins' SQL logs in as the plugin login role (SMD-2310), never as this connection's role.
    return tracedStore(new SqlStore(conn.url, { pluginPassword: env.OB1_PLUGIN_DB_PASSWORD }));
  }

  if (kind === "postgrest") throw new Error(POSTGREST_RETIRED);
  throw new Error(`Unknown OB1_STORE "${kind}" — expected "sql" (the only store; leave it unset)`);
}
