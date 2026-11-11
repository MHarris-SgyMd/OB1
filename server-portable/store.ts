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

import type { Reviewer, ReviewResult } from "./proposal-review.ts";
import type { EgressRecord } from "./egress.ts";
import type { DatabaseFacts, ReadOptions, ReadProgress, readHeartbeats } from "./brain-info.ts";

/** The parsed heartbeat rows (brain-info.ts's readHeartbeats). */
export type HeartbeatRead = Awaited<ReturnType<typeof readHeartbeats>>;
import type { Lineage } from "./lineage.ts";
import type { JobSink } from "./jobs.ts";
import { withSpan, withStoreSpan } from "./spans.ts";
import type { Change, Status } from "./stated-status.ts";
import { PLUGIN_NAME_RE } from "../db/config.mjs";
import { PRIORITY_KINDS, type PriorityKind } from "./priority-kinds.ts";
import type { ItemAnswer, ItemListRow, ItemRecord, ItemStatus } from "./open-items.ts";

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
  /**
   * The stored metadata's JSON type (jsonb_typeof; null for SQL NULL), where
   * the store read it: `metadata` above is `{}` for a SQL NULL and a JSON null
   * alike, so a writer that must not merge into either reads this
   * (append_thought_evidence, SMD-2690 PR 3b review pass 1).
   */
  metadataType?: string | null;
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
export type ProposalPage = {
  proposals: SupersessionProposal[]; next: ProposalPosition | null; remaining: number;
  /** Whether the decided rows' reviewers were read (114, SMD-2608): false when the page lists a decided row on a brain short of 114, whose rows record none; a page with none reads no columns, and says true (SMD-3338). */
  reviewersRead: boolean;
};

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
    ...(Object.hasOwn(r, "metadata_type") ? { metadataType: r.metadata_type === null ? null : String(r.metadata_type) } : {}),
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
  /**
   * Who decided an accepted or rejected row (114's columns, SMD-2608), with
   * the registry's kind now beside the kind the key had when it decided
   * (SMD-3338): null on a pending or stale row, on a decided row that records
   * none (a raw call, or a decision before 114 that wrote no pointer), and on a
   * brain short of 114 (the page's reviewersRead says which).
   */
  reviewer: ListedReviewer | null;
};

/**
 * A decided proposal's reviewer as the listing gives it (SMD-3338 PR 2): the
 * key's name and its kinds, and whether an agent was recorded — not which: no
 * other read shows a key's agent id to another key, and it outlives a
 * rotation, so it would tie one key's decisions together for any reader
 * (review pass 3). The decision's own reply carries the caller's id.
 */
export type ListedReviewer = Omit<Reviewer, "agentId"> & { agentRecorded: boolean };

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
    reviewer: null,
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

// ── Work threads (SMD-3306 PR 7a-2a) ─────────────────────────────────────────

/** How many linked threads a ticket's thread names; the rest are counted. */
export const THREAD_LINKS_SHOWN = 50;
/** How much of a member's text a thread read carries: its title's worth (thoughts.ts thoughtTitle reads the first line). */
export const THREAD_HEAD_CHARS = 500;
/**
 * Which page of a thread to read: from its start, after a member's position (a cursor's, ListPosition's form), or
 * around a member — up to `before` members ahead of it, then it and the rest — `limit` members in all.
 */
export type ThreadWindow = { limit: number } & ({ after?: ListPosition; around?: undefined } | { around: string; before: number; after?: undefined });
/** A board ticket's own row (its head row), as a member: its ticket and its status as that row records it — the row is rewritten in place, so it keeps its first place. */
export type ThreadTicket = { issue: string; status: string | null; statusType: string | null };
/** A thread's member: its place (1 the first), its position (the cursor's), its time, its text's head, and its ticket when it is a board ticket's own row. */
export type ThreadMember = { id: string; place: number; at: string | null; created_at: string | null; content: string; ticket: ThreadTicket | null };
/** How a linked ticket stands to this thread's: its parent or child, it blocks or is blocked by this one, or they relate. */
export type ThreadLinkRelation = "parent" | "child" | "blocks" | "blocked_by" | "relates_to";
export const THREAD_LINK_RELATIONS = ["parent", "child", "blocks", "blocked_by", "relates_to"] as const satisfies readonly ThreadLinkRelation[];
/** A linked thread: its key, how its ticket stands to this one, and how many thoughts it holds (0: none yet). */
export type ThreadLink = { key: string; relation: ThreadLinkRelation; total: number };
/** A thread's page: its key and size, the members picked, and — a ticket's — its linked threads, `linksMore` when more than those shown. */
export type ThreadPage = { key: string; total: number; members: ThreadMember[]; links: ThreadLink[]; linksMore: boolean };
export type ThreadNeighbour = Pick<ThreadMember, "id" | "created_at" | "content">;
export type ThreadPlace = { key: string; place: number; total: number; previous: ThreadNeighbour | null; next: ThreadNeighbour | null };

const textOrNull = (v: unknown): string | null => (typeof v === "string" ? v : null);

/**
 * A thread member's row (threadPage's jsonb element) → ThreadMember: its ticket only when it is a board ticket's own
 * row — `metadata.source` `linear`, which board-sync alone writes (capture and update_thought refuse it to every key,
 * REFUSED_SOURCE_RESERVED); the ticket's head row (`head`: 068's ob1_ticket_head, the rule node_state and the
 * stated-status label read — board-sync chains a ticket's older rows under its head, and a former head kept its
 * status: review pass 3); and `metadata.issue` a ticket's shape (a team of one letter or more, as board-sync's
 * identifiers are). Its status type is kept only as one lower-case word, as Linear's are (backlog, started, …).
 * A write key may set `issue`, `status` and `status_type` on its own rows to any text (review pass 1 found a forged
 * issue printed as a ticket's row, pass 2 a forged status type forging lines of the text): such a row carries no
 * ticket. On board-sync's row it may patch them too, as it may for node_state's reading; the status is said as the
 * row records it.
 */
export function normaliseThreadMember(r: Record<string, unknown>): ThreadMember {
  const raw = textOrNull(r.issue), type = textOrNull(r.status_type);
  const issue = r.source === "linear" && r.head === true && raw !== null && /^[A-Z][A-Z0-9]*-[0-9]+$/.test(raw) ? raw : null;
  return {
    id: String(r.id), place: Number(r.place), at: textOrNull(r.at), created_at: isoTimestampOrNull(r.created_at ?? null),
    content: String(r.content ?? ""),
    ticket: issue === null ? null : { issue, status: textOrNull(r.status), statusType: type !== null && /^[a-z_]{1,20}$/.test(type) ? type : null },
  };
}

/** A linked thread's row → ThreadLink, or null for a relation this read does not make. */
export function normaliseThreadLink(r: Record<string, unknown>): ThreadLink | null {
  const relation = (THREAD_LINK_RELATIONS as readonly unknown[]).includes(r.relation) ? r.relation as ThreadLinkRelation : null;
  return relation === null || typeof r.other !== "string" ? null : { key: `ticket:${r.other}`, relation, total: Number(r.total) };
}

/** threadPlaces' row → ThreadPlace: a neighbour only where the row names one. */
export function normaliseThreadPlace(r: Record<string, unknown>): ThreadPlace {
  const side = (p: "prev" | "next"): ThreadNeighbour | null => r[`${p}_id`] == null ? null
    : { id: String(r[`${p}_id`]), created_at: isoTimestampOrNull(r[`${p}_created_at`] ?? null), content: String(r[`${p}_content`] ?? "") };
  return { key: String(r.key), place: Number(r.place), total: Number(r.total), previous: side("prev"), next: side("next") };
}

// ── Judged relations, read (SMD-2726; SMD-3306 PR 7a-2b) ─────────────────────

/** The consolidation judge's words (084, 102's distinct): every one shown (the maintainer's call, 2026-11-07). */
export type RelationWord = "related" | "evolves" | "duplicate" | "distinct";
export const RELATION_WORDS = ["related", "evolves", "duplicate", "distinct"] as const satisfies readonly RelationWord[];
/** How many relations a search or list result carries; the rest are counted. */
export const RELATIONS_SHOWN = 5;
/** How many a fetched thought carries; the rest are counted, and the `relations` read pages them. */
export const RELATIONS_FETCHED = 20;
/**
 * Where a page of one thought's relations ends, in their order — strongest first: the confidence rounded to six
 * places (absent as -1), then the newest recorded (the facet's created_at, which nothing moves: ordered by when last
 * judged, pass 2's, a kept re-judge between two pages moved a relation to before a walk's cursor — review pass 3), then
 * the relation's id, each descending. `rank` is Postgres's text of that rounded numeric — a confidence 084 takes
 * unrounded from a direct write keeps a cursor short (review pass 1) — and `at` its text of that time, so a cursor
 * compares exactly what the order read.
 */
export type RelationPosition = { rank: string; at: string; id: string };
/**
 * One judged relation as seen from one thought's side: the relation's id (its facet's) and word, the other thought
 * (its id, time, its text's head and its `metadata.trust`) and whether it is the older or the newer of the pair — a
 * relation sits on the newer and names the older, so evolves reads "evolves from" on the newer and "evolved into" on
 * the older — the confidence (null when the judge gave none), when it was last judged (its lineage row's produced_at,
 * which a re-judge keeping the word moves while the facet stays: review pass 1; the facet's created_at without one),
 * its position, and whether either text moved since (`stale`: the lineage row's fingerprints no longer those of the
 * two texts, as --list relations' EDITED SINCE JUDGED; a relation with no lineage row reads not stale, as there).
 */
export type RelationEdge = {
  id: string; relation: RelationWord; otherIs: "older" | "newer"; other: { id: string; created_at: string | null; content: string; trust: string | null };
  confidence: number | null; judgedAt: string | null; position: RelationPosition; stale: boolean;
};
/** A thought's relations as read: how many stand under the read's filter, and the page of them. */
export type RelationsOf = { total: number; edges: RelationEdge[] };
/** Which of a thought's relations to read: one word or all, `limit` of them, after a position; `heads` false leaves out the other thoughts' text heads, for a read that shows no title. */
export type RelationsWindow = { relation?: RelationWord; limit: number; after?: RelationPosition; heads?: boolean };

/** A relation's row (relationsAmong's jsonb element) → RelationEdge, or null for a word or side this read does not make. */
export function normaliseRelationEdge(r: Record<string, unknown>): RelationEdge | null {
  const relation = (RELATION_WORDS as readonly unknown[]).includes(r.relation) ? r.relation as RelationWord : null;
  const otherIs = r.other_is === "older" || r.other_is === "newer" ? r.other_is : null;
  if (relation === null || otherIs === null || typeof r.id !== "string" || typeof r.other_id !== "string") return null;
  const confidence = r.confidence == null ? null : Number(r.confidence);
  return {
    id: r.id, relation, otherIs,
    other: { id: r.other_id, created_at: isoTimestampOrNull(r.other_created_at ?? null), content: String(r.other_content ?? ""), trust: textOrNull(r.other_trust) },
    confidence: confidence !== null && Number.isFinite(confidence) ? confidence : null,
    judgedAt: isoTimestampOrNull(r.judged_at ?? null),
    position: { rank: String(r.rank), at: String(r.at), id: r.id },
    stale: r.stale === true,
  };
}

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
 * A ticket the brain records as closed (migration 118, SMD-3600): its head is an
 * importer's row with a settled status type, so board-sync releases every claim
 * on it at its next pass. The status as the board names it, and its type.
 */
export type ClosedTicket = { status: string | null; statusType: string };

/**
 * A work claim as migration 115's functions answer it (SMD-3597): who holds a
 * ticket, or one piece of it, under a lease. Never its token or the token's
 * hash: neither leaves the database but in claim_work's one answer.
 */
export type WorkClaim = {
  id: string;
  issue: string;
  piece: string | null;
  holder: string;
  holderAgentId: string | null;
  holderKind: string | null;
  label: string | null;
  claimedAt: string;
  renewedAt: string | null;
  expiresAt: string;
  releasedAt: string | null;
  releasedBy: string | null;
  releasedByKind: string | null;
  releaseReason: string | null;
  state: "live" | "lapsed" | "released";
};
/** The refusal codes 115's writers answer with (SMD-3597). */
export type ClaimRefusalCode = "WORK_CLAIMED" | "CLAIM_NOT_FOUND" | "CLAIM_NOT_YOURS" | "CLAIM_RELEASED";
/** A claim's lease as a renewal starts from it (SMD-3654), and the work claim_work asks it about: store.claimLease. Its ticket as 115 keyed it, and the releaser's kind, read whether board-sync ended it (SMD-3600). `byAgentId` (claim_work's form): the claim was made under an agent id, so 115's holder test needs that id to read it as the caller's (SMD-3705). */
export type ClaimLease = { id: string; expiresAt: string; releasedAt: string | null; releasedBy: string | null; releaseReason: string | null; ownOnThisWork?: boolean; byAgentId?: boolean; issue?: string; releasedByKind?: string | null };
export type ClaimLeaseWork = { ticket: string; piece?: string; name: string; agentId?: string };
/**
 * One of 115's writers' jsonb answers, read: its outcome, its refusal code, the
 * claim, the claims in the way, and the token — set on claim_work's `claimed`
 * alone, and passed through untouched to the caller who claimed.
 */
export type ClaimAnswer = {
  outcome: "claimed" | "renewed" | "released" | "already_released" | "refused";
  code: ClaimRefusalCode | null;
  claim: WorkClaim | null;
  heldBy: WorkClaim[];
  token: string | null;
};

/**
 * A call 115 refused by raising rather than answering (SMD-3598): a malformed
 * argument (SQLSTATE 22023), told by which (`problem`), or a key the registry
 * calls ingested (42501). Its message is the database's, which names the
 * argument's rule and never a token (115 words its token refusal without the
 * value). Any other raise stays the store's fault.
 */
export class ClaimRefused extends Error {
  constructor(readonly kind: "argument" | "ingested", readonly problem: ClaimProblem, message: string) {
    super(message);
    this.name = "ClaimRefused";
  }
}
export type ClaimProblem = "ticket" | "piece" | "label" | "reason" | "token" | "lease" | "key_name" | "ingested" | "other";

/** Which argument a 22023 from 115 names, by its message's opening words (115's own wording, one rule each). */
export function claimProblemOf(message: string): ClaimProblem {
  if (/^not a ticket key\b/.test(message)) return "ticket";
  if (/^a piece (?:is at most|was given but is blank)/.test(message)) return "piece";
  if (/^a label is at most/.test(message)) return "label";
  if (/^a reason is at most|needs a reason$/.test(message)) return "reason";
  if (/^not a claim token|needs the claim's token/.test(message)) return "token";
  if (/^a lease is /.test(message)) return "lease";
  if (/a holder's key name is at most/.test(message)) return "key_name";
  return "other";
}

const CLAIM_STATES = new Set(["live", "lapsed", "released"]);
const CLAIM_OUTCOMES = new Set(["claimed", "renewed", "released", "already_released", "refused"]);
const CLAIM_CODES = new Set(["WORK_CLAIMED", "CLAIM_NOT_FOUND", "CLAIM_NOT_YOURS", "CLAIM_RELEASED"]);
const TOKEN_SHAPE = /^wc_[0-9a-f]{64}$/;

/** One claim from 115's ob1_work_claim_json, or list_work_claims' row (the same names); a row that is neither throws, unprinted. */
export function normaliseWorkClaim(r: unknown, what: string): WorkClaim {
  const o = r !== null && typeof r === "object" ? (r as Record<string, unknown>) : undefined;
  const text = (v: unknown): string | null => (typeof v === "string" ? v : null);
  const time = (v: unknown): string | null => (v === null || v === undefined ? null : isoTimestamp(v as string | Date));
  if (!o || typeof o.id !== "string" || typeof o.issue !== "string" || typeof o.holder !== "string" || !CLAIM_STATES.has(o.state as string)) {
    // Never the row itself: a writer's answer carries the token beside its claim.
    throw new Error(`${what} answered a claim this server cannot read`);
  }
  return {
    id: o.id, issue: o.issue, piece: text(o.piece), holder: o.holder,
    holderAgentId: text(o.holder_agent_id), holderKind: text(o.holder_kind), label: text(o.label),
    claimedAt: time(o.claimed_at) as string, renewedAt: time(o.renewed_at), expiresAt: time(o.expires_at) as string,
    releasedAt: time(o.released_at), releasedBy: text(o.released_by), releasedByKind: text(o.released_by_kind),
    releaseReason: text(o.release_reason), state: o.state as WorkClaim["state"],
  };
}

/**
 * One of 115's writers' jsonb answers as the store's ClaimAnswer. An outcome or
 * code the functions do not name, or a token not in its shape, throws — and
 * the throw never prints the answer, which may carry the token (SMD-3598).
 */
export function normaliseClaimAnswer(r: unknown, what: string): ClaimAnswer {
  const o = r !== null && typeof r === "object" ? (r as Record<string, unknown>) : undefined;
  if (!o || !CLAIM_OUTCOMES.has(o.outcome as string) || (o.code !== null && o.code !== undefined && !CLAIM_CODES.has(o.code as string))) {
    throw new Error(`${what} answered no envelope this server reads`);
  }
  const token = o.token === null || o.token === undefined ? null : typeof o.token === "string" && TOKEN_SHAPE.test(o.token) ? o.token : undefined;
  if (token === undefined) throw new Error(`${what} answered a token not in its shape`);
  return {
    outcome: o.outcome as ClaimAnswer["outcome"],
    code: (o.code ?? null) as ClaimRefusalCode | null,
    claim: o.claim === null || o.claim === undefined ? null : normaliseWorkClaim(o.claim, what),
    heldBy: Array.isArray(o.held_by) ? (o.held_by as unknown[]).map((c) => normaliseWorkClaim(c, what)) : [],
    token,
  };
}

/** An item a priority is stated on (migration 116, SMD-3663): its kind and its key, as 116 normalised them. */
export type PriorityItem = { kind: PriorityKind; key: string };
export { PRIORITY_KINDS };
// Types alone: open-items.ts reads isoTimestamp from here, so its values are imported from it directly (review pass 1:
// a value re-exported both ways was an import cycle).
export type { ItemAnswer, ItemListRow, ItemProposal, ItemRecord, ItemStatus, OpenItem, OpenItemEvent } from "./open-items.ts";
/**
 * One priority assertion as 116's ob1_priority_json answers it (SMD-3664): the
 * item, the level and times, the reason (the maker's free text, data), the
 * maker as the registry stamped it at the write, its tier, and its window.
 * Nothing in it proves a key.
 */
export type PriorityAssertion = {
  id: string;
  item: PriorityItem;
  level: number;
  dueAt: string | null;
  notBefore: string | null;
  dueRef: PriorityItem | null;
  reason: string | null;
  inferred: boolean;
  maker: { name: string; agentId: string | null; kind: string | null; trust: string | null; scope: string | null; source: boolean };
  tier: 1 | 2 | 3 | 4;
  tierName: "operator" | "source" | "agent" | "inferred";
  assertedAt: string;
  closedAt: string | null;
  closeReason: "replaced" | "cleared" | null;
  closedBy: string | null;
};
/** The refusal codes 116's writers answer with. */
export type PriorityRefusalCode = "READ_ONLY_KEY" | "ITEM_NOT_YOURS" | "ITEM_NOT_FOUND";
/** One of 116's writers' jsonb answers, read: assert_priority's and clear_priority's outcomes share it. */
export type PriorityAnswer = {
  outcome: "asserted" | "unchanged" | "cleared" | "nothing_to_clear" | "refused";
  code: PriorityRefusalCode | null;
  /** The database's words for a refusal; null otherwise. */
  message: string | null;
  assertion: PriorityAssertion | null;
  replaced: PriorityAssertion | null;
  winner: PriorityAssertion | null;
};
/**
 * One item's record, read in one statement: the rule's winner (ob1_priority_winner), its level, and every statement
 * in the order written (priority_history); `exists`, whether the brain holds the item now (116's own test) — a thought deleted since
 * keeps its statements (116's section 8).
 */
export type PriorityRecord = { item: PriorityItem; exists: boolean; level: number | null; winner: PriorityAssertion | null; history: PriorityAssertion[] };

/**
 * docs/priority.md's weights, as migration 122's effective_priority names them (SMD-3667). A read passes the ones it
 * overrides; the read's defaults stand for the rest, read from ob1_priority_defaults() since migration 128
 * (SMD-4194), level first since migration 127 (SMD-4177): unknown 2, hop 1,
 * hops 2, soon 0.4 by the end of soon_days 1, week 0.2 by the end of week_days 7, overdue 0.6, unblocks_one 0.1,
 * unblocks_many 0.2 from unblocks_many_at 3, depth 3, cap 50, count_inferred false. The terms after the level add at
 * most 0.8 under the defaults; a caller's own weights may make them cross a level (122's were soon 2, week 1,
 * overdue 3, unblocks_one 0.5, unblocks_many 1).
 */
export type PriorityWeights = {
  unknown: number; hop: number; hops: number; soon: number; soon_days: number; week: number; week_days: number; overdue: number;
  unblocks_one: number; unblocks_many: number; unblocks_many_at: number; depth: number; cap: number; count_inferred: boolean;
};
/** One term of an effective priority, named, with what it read (`detail`: the window and due time, the count, the item inherited from, the open item a thought read its level or due time from: `item`, migration 125). */
export type PriorityTerm = { term: "level" | "from_items" | "inherited" | "unknown" | "urgency" | "overdue" | "unblocks"; value: number; detail: Record<string, unknown> };
/**
 * One item's effective priority (migration 122, SMD-3667): the order a ranking read uses and every term that made
 * it. `level` is the counted statement's (null: unknown, inherited, or read from a thought's open items, its first
 * term then `from_items`, migration 125); `inheritedFrom` the item it inherits from, its level and how many hops;
 * `dueFrom` where the due time came from (`from_items`: the soonest of a thought's open items); `waiting`, a
 * not_before still ahead; `passedOver` every other open statement, inferred ones among them when they are not counted.
 */
export type EffectivePriority = {
  item: PriorityItem;
  effective: number;
  level: number | null;
  inheritedFrom: (PriorityItem & { level: number; hops: number }) | null;
  dueAt: string | null;
  dueFrom: "stated" | "due_ref" | "item" | "from_items" | null;
  urgency: number;
  overdue: boolean;
  unblocks: number;
  settled: boolean;
  notBefore: string | null;
  waiting: boolean;
  terms: PriorityTerm[];
  winner: PriorityAssertion | null;
  passedOver: PriorityAssertion[];
};

/**
 * An argument 116 refused by raising (SQLSTATE 22023), or a time Postgres could not
 * cast (`time`), told by which (`problem`), as ClaimRefused tells 115's. Its message
 * is the database's, which quotes the argument it could not read, cut. Any other
 * raise stays the store's fault.
 */
export class PriorityRefused extends Error {
  constructor(readonly problem: PriorityProblem, message: string) {
    super(message);
    this.name = "PriorityRefused";
  }
}
export type PriorityProblem = "kind" | "key" | "level" | "not_before" | "due_ref" | "reason" | "key_name" | "time" | "weight" | "other";

/** Which argument a 22023 from 116 or 122 names, by its message's opening words (116's, 115's and 122's own wording, one rule each). */
export function priorityProblemOf(message: string): PriorityProblem {
  if (/^not an item kind\b/.test(message)) return "kind";
  if (/^not a (?:thought|entity|item) id\b|^not a ticket key\b/.test(message)) return "key";
  if (/^a priority level is\b/.test(message)) return "level";
  if (/^not_before is after due_at\b/.test(message)) return "not_before";
  if (/^a due reference takes\b|due reference may not name itself/.test(message)) return "due_ref";
  if (/^a reason is at most\b/.test(message)) return "reason";
  if (/a maker's key name is at most\b|p_actor must be a JSON object/.test(message)) return "key_name";
  if (/^not a weight\b|^a weight out of range\b|^effective_priority's weights\b/.test(message)) return "weight";
  if (/^effective_priority's clock is a moment\b/.test(message)) return "time";
  return "other";
}

const PRIORITY_OUTCOMES = new Set(["asserted", "unchanged", "cleared", "nothing_to_clear", "refused"]);
const PRIORITY_CODES = new Set(["READ_ONLY_KEY", "ITEM_NOT_YOURS", "ITEM_NOT_FOUND"]);
const TIER_NAMES = new Set(["operator", "source", "agent", "inferred"]);

const priorityItemOf = (v: unknown): PriorityItem | null => {
  const o = v !== null && typeof v === "object" ? (v as Record<string, unknown>) : undefined;
  return o && (PRIORITY_KINDS as readonly unknown[]).includes(o.kind) && typeof o.key === "string" ? { kind: o.kind as PriorityItem["kind"], key: o.key } : null;
};

/** One assertion from 116's ob1_priority_json; a row that is not one throws, naming the call and nothing of the row. */
export function normalisePriorityAssertion(r: unknown, what: string): PriorityAssertion {
  const o = r !== null && typeof r === "object" ? (r as Record<string, unknown>) : undefined;
  const m = o?.maker !== null && typeof o?.maker === "object" ? (o.maker as Record<string, unknown>) : undefined;
  const text = (v: unknown): string | null => (typeof v === "string" ? v : null);
  const time = (v: unknown): string | null => (v === null || v === undefined ? null : isoTimestamp(v as string | Date));
  const item = priorityItemOf(o?.item);
  const tier = Number(o?.tier);
  const refGiven = o?.due_ref !== null && o?.due_ref !== undefined;
  const dueRef = refGiven ? priorityItemOf(o?.due_ref) : null;
  // Every field read, or the row refused: a missing time or a due reference of no kind 116 has is no row to show
  // with a null in its place (review pass 3). The tier's name is 116's own (tier_name), held to the four.
  if (!o || !m || typeof o.id !== "string" || !item || typeof o.level !== "number" || typeof m.name !== "string" || ![1, 2, 3, 4].includes(tier)
      || !TIER_NAMES.has(o.tier_name as string) || o.asserted_at === null || o.asserted_at === undefined || (refGiven && !dueRef)
      || (o.close_reason !== null && o.close_reason !== "replaced" && o.close_reason !== "cleared")) {
    throw new Error(`${what} answered an assertion this server cannot read`);
  }
  return {
    id: o.id, item, level: o.level, dueAt: time(o.due_at), notBefore: time(o.not_before), dueRef,
    reason: text(o.reason), inferred: o.inferred === true,
    maker: { name: m.name, agentId: text(m.agent_id), kind: text(m.kind), trust: text(m.trust), scope: text(m.scope), source: m.source === true },
    tier: tier as PriorityAssertion["tier"], tierName: o.tier_name as PriorityAssertion["tierName"],
    assertedAt: time(o.asserted_at) as string, closedAt: time(o.closed_at), closeReason: (o.close_reason ?? null) as PriorityAssertion["closeReason"], closedBy: text(o.closed_by),
  };
}

// from_items: a thought's open items (migration 125, SMD-4149).
const TERM_NAMES = new Set(["level", "from_items", "inherited", "unknown", "urgency", "overdue", "unblocks"]);
const DUE_FROM = new Set(["stated", "due_ref", "item", "from_items"]);

/** One row of 122's effective_priority; a row that is not one throws, naming the call and nothing of the row. */
export function normaliseEffectivePriority(r: unknown, what: string): EffectivePriority {
  const o = r !== null && typeof r === "object" ? (r as Record<string, unknown>) : undefined;
  const item = o ? priorityItemOf({ kind: o.item_kind, key: o.item_key }) : null;
  const num = (v: unknown): number => (typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN);
  const time = (v: unknown): string | null => (v === null || v === undefined ? null : isoTimestamp(v as string | Date));
  const inh = o?.inherited_from !== null && typeof o?.inherited_from === "object" ? (o.inherited_from as Record<string, unknown>) : null;
  const inhItem = inh ? priorityItemOf(inh) : null;
  const terms = Array.isArray(o?.terms) ? (o.terms as unknown[]) : null;
  const termOk = (t: unknown) => t !== null && typeof t === "object" && TERM_NAMES.has((t as Record<string, unknown>).term as string) && Number.isFinite(num((t as Record<string, unknown>).value));
  const level = o?.level === null || o?.level === undefined ? null : num(o.level);
  if (!o || !item || !Number.isFinite(num(o.effective)) || (level !== null && !Number.isInteger(level)) || (inh !== null && (!inhItem || !Number.isInteger(num(inh.level)) || !Number.isInteger(num(inh.hops))))
      || (o.due_from !== null && o.due_from !== undefined && !DUE_FROM.has(o.due_from as string)) || !Number.isFinite(num(o.urgency)) || !Number.isInteger(num(o.unblocks))
      || typeof o.overdue !== "boolean" || typeof o.settled !== "boolean" || typeof o.waiting !== "boolean" || !terms || !terms.every(termOk) || !Array.isArray(o.passed_over)) {
    throw new Error(`${what} answered a row this server cannot read`);
  }
  return {
    item, effective: num(o.effective), level,
    inheritedFrom: inh && inhItem ? { ...inhItem, level: num(inh.level), hops: num(inh.hops) } : null,
    dueAt: time(o.due_at), dueFrom: (o.due_from ?? null) as EffectivePriority["dueFrom"],
    urgency: num(o.urgency), overdue: o.overdue, unblocks: num(o.unblocks), settled: o.settled,
    notBefore: time(o.not_before), waiting: o.waiting,
    terms: terms.map((t) => {
      const { term, value, ...detail } = t as Record<string, unknown>;
      return { term: term as PriorityTerm["term"], value: num(value), detail };
    }),
    winner: o.winner === null || o.winner === undefined ? null : normalisePriorityAssertion(o.winner, what),
    passedOver: (o.passed_over as unknown[]).map((a) => normalisePriorityAssertion(a, what)),
  };
}

/** A live or lapsed claim an agenda item names (115): the holder's key name, the piece, and when its lease ends or ended. */
export type AgendaClaim = { holder: string; piece: string | null; label: string | null; at: string };
/** The agenda's orders (migration 129, SMD-4192). */
export const AGENDA_ORDERS = ["priority", "due"] as const;
export type AgendaOrder = (typeof AGENDA_ORDERS)[number];
/**
 * One agenda item (migrations 123 and 124, SMD-3669, SMD-4162): a ticket or an open item, its place, what it is, and
 * 122's terms behind its place. `status` is a ticket's Linear status (`statusType` its type: triage, backlog,
 * unstarted or started) or an open item's (open or proposed, `statusType` null). `claimed` names live claims (shown only with
 * include_claimed or holder mine), `lapsedClaim` claims never released whose lease ran out, `blockers` the open items
 * blocking it (shown only with include_blocked).
 */
export type AgendaItem = {
  rank: number;
  kind: "ticket" | "item";
  key: string;
  source: string;
  title: string;
  project: string | null;
  status: string | null;
  statusType: string | null;
  owner: string | null;
  effective: number;
  level: number | null;
  inheritedFrom: (PriorityItem & { level: number; hops: number }) | null;
  dueAt: string | null;
  dueFrom: "stated" | "due_ref" | "item" | "from_items" | null;
  urgency: number;
  overdue: boolean;
  unblocks: number;
  terms: PriorityTerm[];
  winner: PriorityAssertion | null;
  claimed: AgendaClaim[];
  lapsedClaim: AgendaClaim[];
  blockers: string[];
};
/** An agenda (migrations 123 and 124): the first `limit` items, how many passed the filters, how many carry no priority, what was left out and why, board-sync's last heartbeat, and the live claims the brain records. */
export type AgendaResult = {
  items: AgendaItem[];
  total: number;
  unknown: number;
  leftOut: { blocked: number; claimed: number; started: number; waiting: number };
  boardSync: { at: string; outcome: unknown } | null;
  /** False when the role may not read work_claims (the claims group is soft): no claim was filtered or named. */
  claimsRead: boolean;
  /**
   * The live claims this brain records on any ticket (124); null when claimsRead is false. 0 means no claim could
   * leave anything out, as on a brain whose board is claimed through another brain.
   */
  claimsLive: number | null;
  /**
   * With a `keys` scope (126, SMD-2684), the named tickets it does not list: `others`, a ticket whose head is
   * settled or carries a status type the brain does not know, with its status; `waiting`, one a not_before ahead
   * keeps out; `missing`, a key no thought records. A named key is in exactly one of items and these.
   * Null without keys, and from a brain before 126.
   */
  keyed: { others: AgendaOther[]; waiting: AgendaWaiting[]; missing: string[] } | null;
  /** The order applied (129): `priority` from a brain before 129, which has no other. */
  order: AgendaOrder;
  now: string;
};
/** A named ticket the agenda does not rank (126): settled, or a status type the brain does not know. */
export type AgendaOther = { key: string; title: string; status: string | null; statusType: string | null; settled: boolean };
/** A named ticket a not_before ahead keeps out (126, review pass 1): not yet startable, and when it will be. */
export type AgendaWaiting = { key: string; title: string; status: string | null; statusType: string | null; notBefore: string | null };

const claimsOf = (v: unknown, what: string): AgendaClaim[] => {
  if (v === null || v === undefined) return [];
  if (!Array.isArray(v)) throw new Error(`${what} answered claims this server cannot read`);
  return v.map((c) => {
    const o = c !== null && typeof c === "object" ? (c as Record<string, unknown>) : undefined;
    const at = o?.expires_at ?? o?.expired_at;
    if (!o || typeof o.holder !== "string" || (typeof at !== "string" && !(at instanceof Date))) throw new Error(`${what} answered claims this server cannot read`);
    return { holder: o.holder, piece: typeof o.piece === "string" ? o.piece : null, label: typeof o.label === "string" ? o.label : null, at: isoTimestamp(at as string | Date) };
  });
};

/** migration 124's agenda answer; anything else throws, naming the call and nothing of the answer. */
export function normaliseAgenda(r: unknown, what: string): AgendaResult {
  const o = r !== null && typeof r === "object" ? (r as Record<string, unknown>) : undefined;
  const lo = o?.left_out !== null && typeof o?.left_out === "object" ? (o.left_out as Record<string, unknown>) : undefined;
  const num = (v: unknown): number => (typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN);
  if (!o || !Array.isArray(o.items) || !Number.isInteger(num(o.total)) || !Number.isInteger(num(o.unknown)) || !lo
      || ![lo.blocked, lo.claimed, lo.started, lo.waiting].every((n) => Number.isInteger(num(n))) || (typeof o.now !== "string" && !(o.now instanceof Date)) || typeof o.claims_read !== "boolean"
      || (o.claims_live !== null && !Number.isInteger(num(o.claims_live)))
      || (o.order !== undefined && !(AGENDA_ORDERS as readonly unknown[]).includes(o.order))) {
    throw new Error(`${what} answered no agenda this server reads`);
  }
  const bs = o.board_sync !== null && typeof o.board_sync === "object" ? (o.board_sync as Record<string, unknown>) : null;
  const keyed = keyedOf(o.keyed, what);
  const items = (o.items as unknown[]).map((it) => {
    const i = it !== null && typeof it === "object" ? (it as Record<string, unknown>) : undefined;
    if (!i || (i.kind !== "ticket" && i.kind !== "item") || typeof i.key !== "string" || typeof i.source !== "string" || !Number.isInteger(num(i.rank))
        || !Array.isArray(i.blockers) || !(i.blockers as unknown[]).every((b) => typeof b === "string")) {
      throw new Error(`${what} answered an agenda item this server cannot read`);
    }
    // 122's row, as effective_priority answers it: the same normaliser reads the terms, the winner and the due time.
    const e = normaliseEffectivePriority({
      item_kind: i.kind, item_key: i.key, effective: i.effective, level: i.level, inherited_from: i.inherited_from, due_at: i.due_at, due_from: i.due_from,
      urgency: i.urgency, overdue: i.overdue, unblocks: i.unblocks, settled: false, not_before: null, waiting: false, terms: i.terms, winner: i.winner, passed_over: [],
    }, what);
    return {
      rank: num(i.rank), kind: i.kind as AgendaItem["kind"], key: i.key, source: i.source,
      title: typeof i.title === "string" ? i.title : "", project: typeof i.project === "string" ? i.project : null,
      status: typeof i.status === "string" ? i.status : null, statusType: typeof i.status_type === "string" ? i.status_type : null,
      owner: typeof i.owner === "string" ? i.owner : null,
      effective: e.effective, level: e.level, inheritedFrom: e.inheritedFrom, dueAt: e.dueAt, dueFrom: e.dueFrom, urgency: e.urgency,
      overdue: e.overdue, unblocks: e.unblocks, terms: e.terms, winner: e.winner,
      claimed: claimsOf(i.claimed, what), lapsedClaim: claimsOf(i.lapsed_claim, what), blockers: i.blockers as string[],
    };
  });
  return {
    items, total: num(o.total), unknown: num(o.unknown),
    leftOut: { blocked: num(lo.blocked), claimed: num(lo.claimed), started: num(lo.started), waiting: num(lo.waiting) },
    boardSync: bs && (typeof bs.at === "string" || bs.at instanceof Date) ? { at: isoTimestamp(bs.at as string | Date), outcome: bs.outcome ?? null } : null,
    claimsRead: o.claims_read as boolean,
    claimsLive: o.claims_live === null ? null : num(o.claims_live),
    keyed,
    order: (o.order as AgendaOrder | undefined) ?? "priority",
    now: isoTimestamp(o.now as string | Date),
  };
}

/** 126's `keyed`: null or absent is null (no keys, or a brain before 126); any other shape throws. */
function keyedOf(v: unknown, what: string): AgendaResult["keyed"] {
  if (v === null || v === undefined) return null;
  const o = typeof v === "object" ? (v as Record<string, unknown>) : undefined;
  if (!o || !Array.isArray(o.others) || !Array.isArray(o.waiting) || !Array.isArray(o.missing) || !(o.missing as unknown[]).every((k) => typeof k === "string")) {
    throw new Error(`${what} answered named tickets this server cannot read`);
  }
  const others = (o.others as unknown[]).map((x) => {
    const t = x !== null && typeof x === "object" ? (x as Record<string, unknown>) : undefined;
    if (!t || typeof t.key !== "string" || typeof t.settled !== "boolean") throw new Error(`${what} answered named tickets this server cannot read`);
    return { key: t.key, title: typeof t.title === "string" ? t.title : "", status: typeof t.status === "string" ? t.status : null,
             statusType: typeof t.status_type === "string" ? t.status_type : null, settled: t.settled };
  });
  const waiting = (o.waiting as unknown[]).map((x) => {
    const t = x !== null && typeof x === "object" ? (x as Record<string, unknown>) : undefined;
    if (!t || typeof t.key !== "string") throw new Error(`${what} answered named tickets this server cannot read`);
    const nb = t.not_before;
    return { key: t.key, title: typeof t.title === "string" ? t.title : "", status: typeof t.status === "string" ? t.status : null,
             statusType: typeof t.status_type === "string" ? t.status_type : null,
             notBefore: typeof nb === "string" || nb instanceof Date ? isoTimestamp(nb as string | Date) : null };
  });
  return { others, waiting, missing: o.missing as string[] };
}

/** One of 116's writers' jsonb answers as the store's PriorityAnswer; an outcome or code 116 does not name throws. */
export function normalisePriorityAnswer(r: unknown, what: string): PriorityAnswer {
  const o = r !== null && typeof r === "object" ? (r as Record<string, unknown>) : undefined;
  if (!o || !PRIORITY_OUTCOMES.has(o.outcome as string) || (o.code !== null && o.code !== undefined && !PRIORITY_CODES.has(o.code as string))) {
    throw new Error(`${what} answered no envelope this server reads`);
  }
  const one = (v: unknown) => (v === null || v === undefined ? null : normalisePriorityAssertion(v, what));
  return {
    outcome: o.outcome as PriorityAnswer["outcome"],
    code: (o.code ?? null) as PriorityRefusalCode | null,
    message: typeof o.message === "string" ? o.message : null,
    assertion: one(o.assertion), replaced: one(o.replaced), winner: one(o.winner),
  };
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

/**
 * A plan_context call's row (migration 126, SMD-2684): the request, its limit, the knowledge hits' ids and scores and
 * their arm, the board's tickets in the order shown, and `filter` saying why the board was not read ({} when it was).
 */
export type QueryPlanContextLog = {
  agentId?: string;
  query: string;
  matchCount: number;
  arm: string;
  resultIds: string[];
  resultScores: (number | null)[];
  items: { kind: string; key: string; effective: number }[];
  filter: Record<string, unknown>;
  tier?: string;
};

/**
 * An 'agenda' row for the query log (migration 123, SMD-3669): the call's scope, holder and flags in `filter`, its
 * limit as `matchCount`, and the items returned, in order, each with its effective priority.
 */
export type QueryAgendaLog = {
  agentId?: string;
  filter: Record<string, unknown>;
  matchCount: number;
  items: { kind: string; key: string; effective: number }[];
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
   * Work claims (migration 115, SMD-3598): claim_work, renew_work_claim and
   * release_work_claim, each one statement in its own transaction (the
   * functions refuse above READ COMMITTED and lock their ticket), the actor
   * as the holder's envelope, every value — the token above all — a bind
   * parameter. A malformed argument or an ingested key throws ClaimRefused;
   * any other raise is the store's fault. A database before 115 throws.
   */
  claimWork(opts: { issue: string; piece?: string; label?: string; leaseSeconds?: number; token?: string; actor?: Actor }): Promise<ClaimAnswer>;
  renewClaim(opts: { id: string; token: string; leaseSeconds?: number; actor?: Actor }): Promise<ClaimAnswer>;
  releaseClaim(opts: { id: string; token?: string; reason?: string; force?: boolean; actor?: Actor }): Promise<ClaimAnswer>;
  /** Whether a token is this claim's, by 115's hash (a token in its shape: the writer that refused it read it so); never the hash itself. */
  claimTokenIs(id: string, token: string): Promise<boolean>;
  /** list_work_claims: the live claims (every claim with includeEnded) of one ticket or all, of one holder's key name or all. */
  listClaims(opts: { issue?: string; holder?: string; includeEnded?: boolean; limit?: number }): Promise<WorkClaim[]>;
  /**
   * The unreleased claims — live, and lapsed but never released — on the tickets `issues` names, keyed as 115 keys
   * them (SMD-3599: a read's whole page at once, so a result says who holds a ticket it names, or held it and may
   * have paused). By ticket, piece and claim time; at most `limit`. Never a token or its hash.
   */
  unreleasedClaimsOn(issues: string[], limit: number): Promise<WorkClaim[]>;
  /** Whether the brain records this ticket (keyed as 115 keys it) as closed — 118's ob1_work_claim_closed_head; null when open, unknown, or on a brain before 118 (SMD-3600). */
  closedTicket(issue: string): Promise<ClosedTicket | null>;
  /**
   * The lease of the claim a token proves, read before a renewal (SMD-3654): its
   * id, its expiry and whether it was released, by whom and why — never the
   * token or its hash. Given `work` (claim_work's), `ownOnThisWork` says whether
   * the claim is the caller's own on exactly that work, by 115's own cleaning of
   * the ticket and piece and its own holder test, or — no agent id, the registry
   * away — a claim made with one under the caller's name, as ownWhileAway reads
   * it (review pass 5). Its own ended claim on that work is where 115's writer
   * makes a new claim without a word (review pass 4: the refusal read any work,
   * and refused a split's fresh claims). `byAgentId` says the claim was made
   * under an agent id, which 115's holder test then needs (SMD-3705): its own
   * unreleased claim, read with no id to hand, is refused rather than taken over.
   * Null when no claim has that token (or, given `id`, when that claim hasn't).
   * 115's writers report the new lease, not the one renewed, so a renewal that
   * revived a lapsed claim learns it here. renew_claim gives the id, which the
   * primary key finds; claim_work has only the token.
   */
  claimLease(token: string, id?: string, work?: ClaimLeaseWork): Promise<ClaimLease | null>;
  /**
   * The claims on work overlapping a claim's — its ticket's whole, its piece, or
   * any piece of a whole-ticket claim, by 115's piece key — made or renewed after
   * `since`, oldest first, the claim itself left out (SMD-3654): what another
   * agent may have built on while that claim had lapsed. Renewed counts: a claim
   * made before the lapse and revived during it was live then (review pass 2:
   * it was missed). Ended ones included. The first `limit`, and `total` of all.
   */
  claimsMadeSince(id: string, since: string, limit: number): Promise<{ claims: WorkClaim[]; total: number }>;
  /**
   * Priority assertions (migration 116, SMD-3664): assert_priority and
   * clear_priority, each one statement in its own transaction (the functions
   * refuse above READ COMMITTED and lock their item), the actor as the maker's
   * envelope with `scope` stated — `write` for a write key, `capture` for a
   * capture-only key — since 116 refuses an envelope stating neither. A
   * malformed argument throws PriorityRefused; any other raise is the store's
   * fault. A database before 116 throws.
   */
  assertPriority(opts: {
    kind: string; key: string; level: number; dueAt?: string; notBefore?: string; dueRef?: { kind: string; key: string }; reason?: string; inferred?: boolean;
    actor?: Actor; scope: "write" | "capture"; plugin?: string;
  }): Promise<PriorityAnswer>;
  clearPriority(opts: { kind: string; key: string; actor?: Actor; scope: "write" | "capture" }): Promise<PriorityAnswer>;
  /** An item's priority record: the rule's winner and its level and priority_history's statements, in one statement. Throws PriorityRefused for a malformed item. */
  priorityRecord(kind: string, key: string): Promise<PriorityRecord>;
  /** An item as 116 keys it (ob1_priority_item) and whether the brain holds it (ob1_priority_item_exists): what a refusal names. Throws PriorityRefused for a malformed item. */
  priorityItem(kind: string, key: string): Promise<{ item: PriorityItem; exists: boolean }>;
  /**
   * Effective priority (migration 122, SMD-3667): effective_priority's rows for the items, in the order asked, an item
   * asked twice answered once — the counted level, else the inherited one, else unknown's; urgency from the due time
   * in calendar days in UTC; the open items it blocks; every term named. `weights` overrides docs/priority.md's by
   * name, and `now` pins the clock (an eval, a test). Throws PriorityRefused for a malformed item (`kind`, `key`) or
   * weight (`weight`), or a clock that is no moment (`time`). A database before 122 throws.
   */
  effectivePriority(items: { kind: string; key: string }[], opts?: { weights?: Partial<PriorityWeights>; now?: string }): Promise<EffectivePriority[]>;
  /**
   * The largest effective priority the brain's default weights allow (migration 128's ob1_priority_span, SMD-4194):
   * a critical level plus the largest urgency and unblocks terms. Search's priority_weight divides by it. A database
   * before 128 throws. `weights` (SMD-4193): the span under them laid over the defaults (migration 131's
   * ob1_priority_span(jsonb), which checks them as 122 does and refuses a bad one 22023); a database before 131 throws.
   */
  prioritySpan(weights?: Partial<PriorityWeights>): Promise<number>;
  /**
   * The agenda (migration 123, SMD-3669): open, startable, unclaimed tickets and open items in a scope, ranked by
   * 122's effective priority, with what was left out and why. `holder` is the calling key, for `mine`. One
   * statement. A database before 123 throws, and so does any raise of 123's: the schema checks every argument
   * first, and the core answers holder mine's 42501 as CLAIMS_UNREADABLE.
   */
  agenda(opts: {
    /** `keys` (126): those tickets alone, 1 to 100 upper-case keys; the named ones it does not rank come back in `keyed`. */
    scope?: { source?: string; project?: string; label?: string; keys?: string[] }; holder?: { name: string; agentId?: string }; limit: number;
    includeBlocked: boolean; includeClaimed: boolean; includeProposed: boolean;
    /** Also list started tickets (124); absent is false: started work is left out, and counted. */
    includeStarted?: boolean; now?: string;
    /**
     * The order (129, SMD-4192): `priority`, the default, by effective priority; `due`, the dated items first, soonest
     * first (the longest overdue leads), then the undated by effective priority, a stated None among them. Applied
     * before `limit`. `due` needs migration 129; `priority` reads any brain from 123.
     */
    order?: AgendaOrder;
    /** The call's own weights (SMD-4193), overriding the defaults by name: 123's agenda takes them and checks them as 122 does, refusing a bad one 22023. */
    weights?: Partial<PriorityWeights>;
    /** A ceiling on the call's statement, in ms (plan_context's deadline, SMD-2684); a stricter role or database setting is kept. Past it the call throws 57014. */
    timeoutMs?: number;
  }): Promise<AgendaResult>;
  /** One agenda row in query_log (migration 123): the scope and the items returned, in order. */
  logAgenda(row: QueryAgendaLog): Promise<void>;
  /** One plan_context row in query_log (migration 126, SMD-2684): the request, the knowledge hits and the board's tickets, in order. */
  logPlanContext(row: QueryPlanContextLog): Promise<void>;
  /**
   * Open items (migration 117, SMD-3665 PR 2): 117's writers, each one statement in its own transaction, the actor
   * as the maker's envelope with `scope` stated (as 116's) and `plugin` the plugin a call came through (a plugin's
   * ctx.call; never a caller's argument). A malformed argument throws ItemRefused; any other raise is the store's
   * fault. A database before 117 throws.
   */
  openItem(opts: { text: string; owner?: string; dueAt?: string; originThought?: string; pluginRow?: string; proposed?: boolean; actor?: Actor; scope: "write" | "capture"; plugin?: string }): Promise<ItemAnswer>;
  updateItem(opts: { id: string; changes: { text?: string; owner?: string | null; dueAt?: string | null }; actor?: Actor; scope: "write" | "capture"; plugin?: string }): Promise<ItemAnswer>;
  setItemStatus(opts: { id: string; status: "open" | "done" | "dropped"; reason?: string; actor?: Actor; scope: "write" | "capture"; plugin?: string }): Promise<ItemAnswer>;
  proposeItemClose(opts: { id: string; status: "done" | "dropped"; evidenceThought?: string; label?: string; reason?: string; actor?: Actor; scope: "write" | "capture"; plugin?: string }): Promise<ItemAnswer>;
  decideItemClose(opts: { proposal: string; accept: boolean; reason?: string; actor?: Actor; scope: "write" | "capture"; plugin?: string }): Promise<ItemAnswer>;
  /** One item's record (117's open_item_history), in one statement. Throws ItemRefused for a malformed id. */
  itemHistory(id: string): Promise<ItemRecord>;
  /**
   * Open items by status (any of `statuses`), overdue alone when asked (open or proposed, due before the read),
   * from one origin thought or one plugin when asked: the first `limit` by due time (none last), then the newest
   * noted, then id, and whether more stood beyond them. One statement.
   */
  listItems(opts: { statuses: ItemStatus[]; overdue: boolean; originThought?: string; plugin?: string; limit: number }): Promise<{ items: ItemListRow[]; truncated: boolean }>;
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
   * One work thread's page (SMD-3306 PR 7a-2a): the thoughts holding standing subject `key` (111), in the thread's
   * order — created_at, ties by id, an undated thought last, as 120's thread_relink orders it — read from the
   * subjects, not the edges, so a thread is whole before db/threads.ts links it. `window` picks the page: from the
   * start, after a member's position, or around a member (`around`, up to `before` members ahead of it). A ticket
   * key's page carries the threads its ticket's board links reach (053's linear links on the ticket's rows, either
   * direction), each with its member count, the first THREAD_LINKS_SHOWN. Throws ListCursorRefused for a cursor
   * whose time Postgres cannot read, else what Postgres throws: a role that cannot read thought_facets is the
   * caller's to say.
   */
  threadPage(key: string, window: ThreadWindow): Promise<ThreadPage>;

  /**
   * Each thread a thought stands in (SMD-3306 PR 7a-2a), one per standing subject key, in key order: its place, the
   * thread's size, and the members before and after it — fetch's "continues" and "continued by". Empty for a thought
   * with no standing subject, or no such thought. Throws as threadPage does.
   */
  threadPlaces(id: string): Promise<ThreadPlace[]>;

  /**
   * Each thought's standing judged relations (SMD-2726; SMD-3306 PR 7a-2b): 084's `relation` facets of origin
   * `judged` — a work thread's edges (origin `thread`, 120) are the thread read's — on the thought (it the newer) and
   * naming it (it the older), every word, strongest first; per thought the first `shown` and how many stand. A thought
   * with none is absent. Throws what Postgres throws: a role that cannot read thought_facets or derivations is the
   * caller's to say.
   */
  relationsAmong(ids: string[], shown: number, heads?: boolean): Promise<Record<string, RelationsOf>>;

  /**
   * One thought's standing judged relations, a page of them (the `relations` read): `window` filters by word and
   * picks the page after a position. `total` counts every one under the filter. Throws ListCursorRefused for a
   * cursor whose time Postgres cannot read, else as relationsAmong does.
   */
  relationsPage(id: string, window: RelationsWindow): Promise<RelationsOf>;

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
  /** The secret each plugin's login role's password is derived from (db/config.mjs's pluginLoginPassword, SMD-2310, SMD-2756); unset, a plugin's tables are refused. */
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
  resetCaptureStamp: true, reviewProposal: true, claimWork: true, renewClaim: true, releaseClaim: true, claimTokenIs: true, listClaims: true, unreleasedClaimsOn: true, closedTicket: true, claimLease: true, claimsMadeSince: true, assertPriority: true, clearPriority: true, priorityRecord: true, priorityItem: true, effectivePriority: true, agenda: true, logAgenda: true, logPlanContext: true, openItem: true, updateItem: true, setItemStatus: true, proposeItemClose: true, decideItemClose: true, itemHistory: true, listItems: true, resolveAgent: true, captureActorOf: true, takenFromCapturer: true, existingIds: true, thoughtsNamed: true, keyAtText: true, traceProvenance: true,
  prioritySpan: true, findDerivatives: true, supersededAmong: true, ticketStatusInputs: true, threadPage: true, threadPlaces: true, relationsAmong: true, relationsPage: true, listSupersessionProposals: true, listChanges: true, logSearch: true, logActions: true,
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
