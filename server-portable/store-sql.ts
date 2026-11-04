/**
 * store-sql.ts — direct SQL, the brain's one store (SMD-3152 retired the
 * PostgREST store it replaced).
 *
 * Uses Bun's built-in Postgres client, so it adds no driver dependency.
 *
 * ── Behaviour must not change ────────────────────────────────────────────────
 * Every query here reproduced what the PostgREST store asked for, including two
 * details that are easy to lose in translation and silent when lost:
 *
 *   1. `match_thoughts` compares `> match_threshold` STRICTLY. A row whose
 *      similarity exactly equals the threshold is excluded. Calling the stored
 *      function rather than reimplementing the ranking keeps that guaranteed.
 *
 *   2. jsonb parameters must arrive as objects. Bun.sql binds a JS *string* to a
 *      jsonb parameter as jsonb_typeof='string', and `p_payload->'metadata'` then
 *      returns NULL, so metadata is silently stored as {}. Migration 005 rejects
 *      that outright; this file never constructs the payload as a string.
 */

import { SQL } from "bun";
import type { JobSink, JobRow, PublicJob, JobStatus, JobProgress } from "./jobs.ts";
import { readDatabaseFacts, readHeartbeats, type DatabaseFacts, type ReadOptions, type ReadProgress } from "./brain-info.ts";
import { RESOLVE_LOCK_TIMEOUT_MS } from "./agents.ts";
import { PLUGIN_NAME_RE, pluginIdents, pluginLoginUrl, quoteIdent } from "../db/config.mjs";
import type { Lineage } from "./lineage.ts";
import { reviewersOf, reviewProposal, type ReviewResult } from "./proposal-review.ts";
import { ItemRefused, itemProblemOf, normaliseItemAnswer, normaliseItemRecord, normaliseOpenItem, type ItemAnswer, type ItemListRow, type ItemRecord, type ItemStatus } from "./open-items.ts";
import { ClaimRefused, claimProblemOf, normalisePriorityAnswer, normalisePriorityAssertion, PRIORITY_KINDS, PriorityRefused, priorityProblemOf, type PriorityAnswer, type PriorityItem, type PriorityRecord, ListCursorRefused, normaliseClaimAnswer, normaliseWorkClaim, timeCastFailed, type ProposalPage, type ProposalPosition, actorPayload, captureEnvelope, isoTimestampOrNull, normaliseActionRows, normaliseAgentResolution, normaliseChange, normaliseDerivative, normaliseHybridRow, normaliseKeywordRow, normaliseListItem, normaliseMatchRow, normaliseMutation, normaliseProposal, normaliseProvenanceNode, withWriters, WRITERS_MISSING, normaliseRecaptureLabel, normaliseResetStamp, normaliseThoughtMeta, normaliseThoughtRecord, normaliseVectorlessRow, provenanceEnvelope, RECENCY_DEFAULTS, UUID_RE, idList, labelReadFailed, labelReadOk, normaliseTicketStatusInputs, ticketList, TEXT_PAGE, type ClaimLease, type ClaimLeaseWork } from "./store.ts";
import type {
  Actor,
  AgentResolution,
  ClaimAnswer,
  WorkClaim,
  AuditChange,
  CaptureResult,
  ChangeFilters,
  Derivative,
  ListFilters,
  ListPosition,
  ThoughtListPage,
  DeleteResult,
  ResetStampResult,
  ProvenanceNode,
  QueryActionLog,
  QuerySearchLog,
  SupersessionProposal,
  ThoughtHybridMatch,
  ThoughtKeywordMatch,
  LoggedSearchPage,
  WorkerStatusRow,
  HeartbeatRead,
  RetryFailedResult,
  ReleaseLeasesOpts,
  ReleaseLeasesResult,
  DryRunClaimResult,
  ThoughtIdPage,
  VectorlessRow,
  ThoughtListItem,
  ThoughtMatch,
  RecencyOpts,
  ThoughtMeta,
  ThoughtStats,
  ThoughtRecord,
  ThoughtStore,
  TicketStatusInputs,
  PluginSql,
  UpdateProvenance,
  UpdateResult,
  WriteEvent,
} from "./store.ts";

/**
 * One of 115's writers, run and read (SMD-3598): its jsonb answer as a ClaimAnswer, a malformed argument (22023) or
 * an ingested key (42501, by its words) as ClaimRefused, any other raise rethrown as the store's fault. The SQLSTATE
 * is Bun's PostgresError's errno.
 */
async function claimCall(what: string, run: () => Promise<Record<string, unknown>[]>): Promise<ClaimAnswer> {
  let rows: Record<string, unknown>[];
  try {
    rows = await run();
  } catch (e) {
    const state = String((e as { errno?: unknown }).errno ?? "");
    const message = String((e as Error)?.message ?? "");
    if (state === "22023") throw new ClaimRefused("argument", claimProblemOf(message), message);
    if (state === "42501" && /is an ingested key/.test(message)) throw new ClaimRefused("ingested", "ingested", message);
    throw e;
  }
  return normaliseClaimAnswer(rows[0]?.r, what);
}

/**
 * A 22023 from 116 as PriorityRefused, by its words; a time the schema took that Postgres cannot cast (22007, 22008,
 * 22009: a year 0000, an offset out of range) as one too, problem `time` (review pass 2: a 500); any other raise as it
 * was, the store's fault.
 */
function priorityRefusedOr(e: unknown): unknown {
  const message = String((e as Error)?.message ?? "");
  if (timeCastFailed(e)) return new PriorityRefused("time", `due_at or not_before is no time Postgres can read: ${message}`);
  return String((e as { errno?: unknown }).errno ?? "") === "22023" ? new PriorityRefused(priorityProblemOf(message), message) : e;
}

/** One of 116's writers, run and read (SMD-3664): its jsonb answer as a PriorityAnswer, a malformed argument as PriorityRefused. */
async function priorityCall(what: string, run: () => Promise<Record<string, unknown>[]>): Promise<PriorityAnswer> {
  let rows: Record<string, unknown>[];
  try {
    rows = await run();
  } catch (e) {
    throw priorityRefusedOr(e);
  }
  return normalisePriorityAnswer(rows[0]?.r, what);
}

/**
 * The maker's envelope for 116's and 117's calls: the actor's own, its scope stated, and the plugin a call came
 * through (SMD-3665 PR 2: a plugin's ctx.call names it, and 117 reads it there alone — a plugin row's item is the
 * plugin's — never from an argument). Only here: the actor's `scope` is otherwise a capture key's alone, which 082
 * reads off an audit row, and a write key's envelope on a thought write states none.
 */
const itemEnvelope = (actor: Actor | undefined, scope: "write" | "capture", plugin: string | undefined) =>
  (actor ? { ...actorPayload(actor), scope, ...(plugin !== undefined ? { plugin } : {}) } : null);

/** A raise 117 means as a refused argument: its 22023, or a uuid Postgres could not cast (22P02); any other, the store's fault. */
function itemRefusedOr(e: unknown): unknown {
  const errno = String((e as { errno?: unknown }).errno ?? "");
  const message = String((e as Error)?.message ?? "");
  return errno === "22023" || errno === "22P02" ? new ItemRefused(errno === "22P02" ? "id" : itemProblemOf(message), message) : e;
}

/** One of 117's writers, run and read: its jsonb answer as an ItemAnswer, a malformed argument as ItemRefused. */
async function itemCall(what: string, run: () => Promise<Record<string, unknown>[]>): Promise<ItemAnswer> {
  let rows: Record<string, unknown>[];
  try {
    rows = await run();
  } catch (e) {
    throw itemRefusedOr(e);
  }
  return normaliseItemAnswer(rows[0]?.r, what);
}

/** pgvector accepts a bracketed list; a JS number[] does not bind as a vector. */
function toVector(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}

/**
 * A Postgres array literal for a `::uuid[]` bind. Bun binds a JS array to a
 * text parameter comma-joined — no braces — so the literal is built by hand,
 * as toVector builds a vector. Ids are validated before they reach here (the
 * search results' own ids; normaliseActionRows for the query log); a null
 * element is the NULL element (the log's nullable agent column). By hand
 * rather than sql.array because the driver renders a null element as the text
 * `null`, which uuid[] refuses (probed, seventh review pass). Empty stays `{}`.
 */
function toUuidArray(ids: (string | null)[]): string {
  return `{${ids.map((x) => x ?? "NULL").join(",")}}`;
}

/**
 * A Postgres array literal for a `::real[]` bind, aligned to a uuid array. A
 * null or non-finite score is the keyword NULL (a returned id whose score the
 * retrieval path did not carry); a finite number is itself.
 */
function toRealArray(xs: (number | null)[]): string {
  return `{${xs.map((x) => (x === null || !Number.isFinite(x as number) ? "NULL" : String(x))).join(",")}}`;
}

/** The pool size when OB1_PG_POOL is unset. */
export const DEFAULT_PG_POOL = 10;

/**
 * OB1_PG_POOL as a pool size: a positive integer, else the default. `""` is
 * unset — deploy/compose.yaml forwards every optional knob as `${VAR:-}`, so a
 * composed server sees "" wherever deploy/.env set nothing, and Number("") is
 * 0, which Bun's SQL refuses at construction (`options.max` must be at least
 * 1) — the server would have failed preflight at the data layer over a
 * default that should have been 10 (SMD-1843; the same rule as embed.ts's
 * numberOr and db/config.mjs's ENV proxy).
 */
export function poolSizeFrom(raw: string | undefined, fallback = DEFAULT_PG_POOL): number {
  const n = raw && raw.trim() ? Number(raw.trim()) : NaN;
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** Connections in each plugin's own pool (SMD-2310): its handlers' transactions queue past two. */
const PLUGIN_POOL_SIZE = 2;

export class SqlStore implements ThoughtStore {
  readonly kind = "sql" as const;
  private sql: SQL;

  /**
   * Each plugin's own pool (SMD-2310), made at its first transaction and
   * logged in as the plugin's own login role (SMD-2756): what a plugin's SQL
   * leaves on a session — a temp table, which Postgres searches before any
   * schema and so would stand in for `thoughts` in a core query that later
   * used the connection, a session setting, an advisory lock, a cursor held
   * past commit — stays on connections no core query and no other plugin
   * uses (review pass 1).
   */
  private readonly pluginPools = new Map<string, SQL>();
  /** The plugins whose pool has been seen logged in as the plugin's login role: checked once, at its first transaction. */
  private readonly pluginLogins = new Set<string>();
  /** The store's own database URL and OB1_PLUGIN_DB_PASSWORD: a plugin's login URL is built from them at its first transaction. */
  private readonly url: string;
  private readonly pluginPassword: string | undefined;
  /** The vector mender's leader lock's own connection (SMD-2889): opened at the first tick, never one of the pool's. */
  private lockSql: SQL | null = null;
  /** How often that connection has closed: an unlock on a new session after one is no pooler's doing. */
  private lockCloses = 0;

  /** `pluginPassword`: OB1_PLUGIN_DB_PASSWORD, the secret each plugin's login password is derived from (SMD-2310, SMD-2756). */
  constructor(url: string, opts: { max?: number; pluginPassword?: string } = {}) {
    // A bounded pool. PostgREST was stateless HTTP, so nothing upstream limits
    // concurrency for us any more — an unbounded pool would let a burst of
    // captures exhaust the server's connection slots.
    this.sql = new SQL({ url, max: opts.max ?? poolSizeFrom(process.env.OB1_PG_POOL) });
    // Kept, not turned into the login URL here: a URL that cannot carry the
    // login role (no host) is the plugin's transaction to refuse, not the
    // whole server's start (final review).
    this.url = url;
    this.pluginPassword = opts.pluginPassword;
  }

  async matchThoughts(opts: {
    embedding: number[];
    threshold: number;
    limit: number;
    filter: Record<string, unknown>;
  } & RecencyOpts): Promise<ThoughtMatch[]> {
    // Call the stored function rather than inlining the ranking, so the strict
    // threshold comparison and the ordering stay defined in exactly one place.
    // All six arguments, always — store.ts's RecencyOpts says why.
    const rows = await this.sql`
      SELECT id, content, metadata, similarity, created_at, score
      FROM match_thoughts(
        ${toVector(opts.embedding)}::vector,
        ${opts.threshold}::float,
        ${opts.limit}::int,
        ${opts.filter}::jsonb,
        ${opts.recencyWeight ?? RECENCY_DEFAULTS.weight}::float,
        ${opts.halfLifeDays ?? RECENCY_DEFAULTS.halfLifeDays}::float
      )`;
    return rows.map(normaliseMatchRow);
  }

  async keywordThoughts(opts: {
    query: string;
    limit: number;
    offset: number;
    filter: Record<string, unknown>;
    minTrust?: string;
  }): Promise<ThoughtKeywordMatch[]> {
    // Call the function rather than inlining the ILIKE, for the same reason
    // matchThoughts calls match_thoughts: the wildcard escaping and the stable
    // ORDER BY are correctness, and two copies of them is one copy too many.
    // min_trust (074, SMD-1724) is its fifth argument, sent only when set.
    const rows = opts.minTrust === undefined
      ? await this.sql`
          SELECT id, content, metadata, created_at, occurrences, total_count
          FROM search_thoughts_keyword(
            ${opts.query}::text,
            ${opts.limit}::int,
            ${opts.offset}::int,
            ${opts.filter}::jsonb
          )`
      : await this.sql`
          SELECT id, content, metadata, created_at, occurrences, total_count
          FROM search_thoughts_keyword(
            ${opts.query}::text,
            ${opts.limit}::int,
            ${opts.offset}::int,
            ${opts.filter}::jsonb,
            ${opts.minTrust}::text
          )`;
    return rows.map(normaliseKeywordRow);
  }

  async hybridThoughts(opts: {
    query: string;
    embedding: number[] | null;
    threshold: number;
    limit: number;
    filter: Record<string, unknown>;
    preferCurrent?: boolean;
    minTrust?: string;
  } & RecencyOpts): Promise<ThoughtHybridMatch[]> {
    // The function extracts the needles and does the fusion, so the server
    // has no copy of either rule to get out of step — the same reason the two
    // methods above call their functions rather than inlining them. Under
    // prefer_current the demotion is 059's function's too (SMD-2255); a tagged
    // template cannot bind a function name, so the two calls are two literals.
    // A null embedding is a query the provider could not embed (SMD-2891):
    // NULL::vector, on which match_thoughts returns nothing, so each function
    // answers its exact-literal arm alone, with the same needle facts.
    const weight = opts.recencyWeight ?? RECENCY_DEFAULTS.weight;
    const halfLife = opts.halfLifeDays ?? RECENCY_DEFAULTS.halfLifeDays;
    // min_trust (SMD-1724) is the eighth argument of 075's forms, which take
    // every argument; sent only when set, so the seven-argument call stays the
    // one a brain before 075 answers.
    if (opts.minTrust !== undefined) return this.hybridAtTrust(opts, weight, halfLife, opts.minTrust);
    const rows = opts.preferCurrent === true
      ? await this.sql`
          SELECT id, content, metadata, created_at, similarity,
                 matched_needles, needles, needle_counts, common_needles, literal_only, score,
                 fused, demoted, window_rows, window_known, window_demoted, window_synced_at, window_exact
          FROM search_thoughts_current(
            ${opts.embedding ? toVector(opts.embedding) : null}::vector,
            ${opts.query}::text,
            ${opts.threshold}::float,
            ${opts.limit}::int,
            ${opts.filter}::jsonb,
            ${weight}::float,
            ${halfLife}::float
          )`
      : await this.sql`
          SELECT id, content, metadata, created_at, similarity,
                 matched_needles, needles, needle_counts, common_needles, literal_only, score
          FROM search_thoughts_hybrid(
            ${opts.embedding ? toVector(opts.embedding) : null}::vector,
            ${opts.query}::text,
            ${opts.threshold}::float,
            ${opts.limit}::int,
            ${opts.filter}::jsonb,
            ${weight}::float,
            ${halfLife}::float
          )`;
    return rows.map((r: Record<string, unknown>) => normaliseHybridRow(r));
  }

  async literalFacts(query: string): Promise<{ literals: { needle: string; common: boolean }[]; textable: boolean }> {
    // 017's needles, each probed for its 101st matching row exactly as 075's
    // hybrid probes it — the pattern escaped as 012 escapes it (test-e2e-sql
    // [23] plants decoys only an unescaped `_`, `%` or `\` gets wrong), and the
    // OFFSET that plans it through the trigram index: a bare EXISTS plans a
    // sequential scan, the whole table for an absent needle (SMD-2891, review
    // pass 3: 150 ms a needle at 200,000 thoughts, 1 ms this way).
    // `textable` is 017's rule for a quoted span, on the whole query (review pass 5).
    const [row] = await this.sql`
      SELECT COALESCE((SELECT jsonb_agg(jsonb_build_object('needle', n.needle, 'common',
                         EXISTS (SELECT 1 FROM thoughts t
                                 WHERE t.content ILIKE '%' || replace(replace(replace(n.needle, '\\', '\\\\'), '%', '\\%'), '_', '\\_') || '%'
                                 OFFSET 100 LIMIT 1)) ORDER BY n.ord)
                       FROM unnest(extract_search_needles(${query}::text)) WITH ORDINALITY AS n(needle, ord)), '[]'::jsonb) AS literals,
             length(btrim(${query}::text)) BETWEEN 3 AND 64 AND length(to_tsvector('english', ${query}::text)) > 0 AS textable`;
    const literals = (typeof row.literals === "string" ? JSON.parse(row.literals) : row.literals) as { needle: string; common: boolean }[];
    return { literals: literals.map((l) => ({ needle: String(l.needle), common: l.common === true })), textable: row.textable === true };
  }

  async textThoughts(opts: { query: string; limit: number; filter: Record<string, unknown>; minTrust?: string }): Promise<ThoughtKeywordMatch[]> {
    // 075's probe shape, bounded: the escaped pattern, the filter and the
    // trust floor in one scan that stops at the page's last row, then the
    // page ordered newest first. Never search_thoughts_keyword's function,
    // whose count(*) OVER () and per-row occurrences read the whole match set
    // (review pass 8). A row says how many the page held; a page past
    // TEXT_PAGE says "more than".
    const minTrust = opts.minTrust ?? null;
    const rows = await this.sql`
      WITH page AS (
        SELECT t.id, t.content, t.metadata, t.created_at
        FROM thoughts t
        WHERE t.content ILIKE '%' || replace(replace(replace(${opts.query}::text, '\\', '\\\\'), '%', '\\%'), '_', '\\_') || '%'
          AND (${opts.filter}::jsonb = '{}'::jsonb OR t.metadata @> ${opts.filter}::jsonb)
          AND (ob1_min_trust_rank(${minTrust}::text) = 0 OR ob1_trust_rank(t.metadata->>'trust') >= ob1_min_trust_rank(${minTrust}::text))
        LIMIT ${TEXT_PAGE + 1}
      )
      SELECT id, content, metadata, created_at, 1 AS occurrences, (SELECT count(*) FROM page)::int AS total_count
      FROM page
      ORDER BY created_at DESC NULLS LAST, id
      LIMIT ${opts.limit}::int`;
    return rows.map(normaliseKeywordRow);
  }

  /** hybridThoughts with min_trust: 075's 8-argument forms, the same columns as the 7's. */
  private async hybridAtTrust(opts: { query: string; embedding: number[] | null; threshold: number; limit: number; filter: Record<string, unknown>; preferCurrent?: boolean }, weight: number, halfLife: number, minTrust: string): Promise<ThoughtHybridMatch[]> {
    const rows = opts.preferCurrent === true
      ? await this.sql`
          SELECT id, content, metadata, created_at, similarity,
                 matched_needles, needles, needle_counts, common_needles, literal_only, score,
                 fused, demoted, window_rows, window_known, window_demoted, window_synced_at, window_exact
          FROM search_thoughts_current(
            ${opts.embedding ? toVector(opts.embedding) : null}::vector,
            ${opts.query}::text,
            ${opts.threshold}::float,
            ${opts.limit}::int,
            ${opts.filter}::jsonb,
            ${weight}::float,
            ${halfLife}::float,
            ${minTrust}::text
          )`
      : await this.sql`
          SELECT id, content, metadata, created_at, similarity,
                 matched_needles, needles, needle_counts, common_needles, literal_only, score
          FROM search_thoughts_hybrid(
            ${opts.embedding ? toVector(opts.embedding) : null}::vector,
            ${opts.query}::text,
            ${opts.threshold}::float,
            ${opts.limit}::int,
            ${opts.filter}::jsonb,
            ${weight}::float,
            ${halfLife}::float,
            ${minTrust}::text
          )`;
    return rows.map((r: Record<string, unknown>) => normaliseHybridRow(r));
  }

  async getThought(id: string): Promise<ThoughtRecord | null> {
    // `id` is a uuid column, so a malformed value is a cast error rather than a
    // not-found. Treat it as not-found: an MCP client passing a bad id should get
    // a clean answer, not a Postgres error string.
    if (!UUID_RE.test(id)) return null;

    const rows = await this.sql`
      SELECT id, content, metadata, created_at, updated_at
      FROM thoughts WHERE id = ${id}::uuid LIMIT 1`;
    if (rows.length === 0) return null;
    return normaliseThoughtRecord(rows[0]);
  }

  async listThoughts(f: ListFilters): Promise<ThoughtListPage> {
    // Each filter is jsonb containment, `@>`. Undefined filters are passed as NULL and short-circuited in SQL, which keeps
    // this a single prepared statement instead of a concatenated query.
    const since = f.days ? new Date(Date.now() - f.days * 86_400_000).toISOString() : null;
    // The ladder's words (SMD-1724) as an array literal, toUuidArray's way: Bun
    // binds a JS array comma-joined, without braces. Enum words, no quoting.
    const trustIn = f.trustIn ? `{${f.trustIn.join(",")}}` : null;
    const filters = this.sql`
          (${f.type ?? null}::text  IS NULL OR metadata @> jsonb_build_object('type', ${f.type ?? null}::text))
      AND (${f.topic ?? null}::text IS NULL OR metadata @> jsonb_build_object('topics', jsonb_build_array(${f.topic ?? null}::text)))
      AND (${f.person ?? null}::text IS NULL OR metadata @> jsonb_build_object('people', jsonb_build_array(${f.person ?? null}::text)))
      AND (${f.saidBy ?? null}::text IS NULL OR metadata @> jsonb_build_object('actor_kind', ${f.saidBy ?? null}::text))
      AND (${f.actor?.trim() || null}::text IS NULL OR metadata @> jsonb_build_object('actor_name', ${f.actor?.trim() || null}::text))
      AND (${trustIn}::text[] IS NULL OR metadata->>'trust' = ANY(${trustIn}::text[]))
      AND (${since}::timestamptz IS NULL OR created_at >= ${since}::timestamptz)`;
    // SMD-2995: a keyset on (created_at, id). Newest first is 001's index's
    // own order, `created_at DESC` with the undated first, ties by id; oldest
    // first is its reverse. Each order is two runs, the undated and the
    // dated, and each run is read by a plain index condition — `created_at IS
    // NULL`, or `created_at <=`/`>=` the cursor's — never a predicate OR-ing
    // the two, which the planner reads as a filter over every row before the
    // cursor (oldest first past a dated row read 150,001 rows to return 51,
    // measured). The first run left is read first; the next only when the
    // page is not yet full. One row past the page says whether more follow.
    const want = f.limit + 1;
    const oldest = f.sort === "oldest";
    const after = f.after ?? null;
    const pick = this.sql`SELECT id, content, metadata, created_at, created_at::text AS created_at_text FROM thoughts`;
    const undated = (id: string | null, limit: number) => oldest
      ? this.sql`${pick} WHERE ${filters} AND created_at IS NULL AND (${id}::uuid IS NULL OR id > ${id}::uuid) ORDER BY id ASC LIMIT ${limit}::int`
      : this.sql`${pick} WHERE ${filters} AND created_at IS NULL AND (${id}::uuid IS NULL OR id < ${id}::uuid) ORDER BY id DESC LIMIT ${limit}::int`;
    const dated = (pos: ListPosition | null, limit: number) => pos === null || pos.at === null
      ? oldest
        ? this.sql`${pick} WHERE ${filters} AND created_at IS NOT NULL ORDER BY created_at ASC, id ASC LIMIT ${limit}::int`
        : this.sql`${pick} WHERE ${filters} AND created_at IS NOT NULL ORDER BY created_at DESC, id DESC LIMIT ${limit}::int`
      : oldest
        ? this.sql`${pick} WHERE ${filters} AND created_at >= ${pos.at}::timestamptz AND (created_at > ${pos.at}::timestamptz OR id > ${pos.id}::uuid) ORDER BY created_at ASC, id ASC LIMIT ${limit}::int`
        : this.sql`${pick} WHERE ${filters} AND created_at <= ${pos.at}::timestamptz AND (created_at < ${pos.at}::timestamptz OR id < ${pos.id}::uuid) ORDER BY created_at DESC, id DESC LIMIT ${limit}::int`;
    // The runs in this order's turn, each from where the cursor leaves it: newest first the undated then the dated,
    // oldest first the reverse. A cursor in the second run has passed the first.
    const runs: ((limit: number) => Promise<Record<string, unknown>[]>)[] = oldest
      ? after?.at === null ? [(n) => undated(after.id, n)] : [(n) => dated(after, n), (n) => undated(null, n)]
      : after === null ? [(n) => undated(null, n), (n) => dated(null, n)]
        : after.at === null ? [(n) => undated(after.id, n), (n) => dated(null, n)] : [(n) => dated(after, n)];
    const rows: Record<string, unknown>[] = [];
    try {
      for (const run of runs) {
        if (rows.length >= want) break;
        rows.push(...(await run(want - rows.length)));
      }
    } catch (e) {
      // A time cast that failed: the cursor's time is read alone, and if that fails too it is the caller's value of
      // the right shape Postgres cannot read, refused. Alone, so a cast error of anything else — `days` read back as
      // a time — is never taken for the cursor's (review pass 2), and only after a failure, so a good page pays no
      // round trip before it (review pass 3).
      if (!after?.at || !timeCastFailed(e)) throw e;
      const unread = await this.sql`SELECT ${after.at}::timestamptz`.then(() => false, (p: unknown) => (timeCastFailed(p) ? true : Promise.reject(p)));
      if (unread) throw new ListCursorRefused();
      throw e;
    }
    const shown = rows.slice(0, f.limit);
    const last = shown[shown.length - 1];
    return {
      thoughts: shown.map(normaliseListItem),
      next: rows.length > f.limit && last ? { at: last.created_at_text === null ? null : String(last.created_at_text), id: String(last.id) } : null,
    };
  }

  async countThoughts(): Promise<number> {
    const rows = await this.sql`SELECT count(*)::int AS c FROM thoughts`;
    return Number(rows[0].c);
  }

  async listThoughtIds(opts: { limit: number; after: string | null }): Promise<ThoughtIdPage> {
    // Keyset by id: a stable order a multi-row INSERT cannot disturb (unlike
    // created_at), so a paged walk never repeats or drops an id. A malformed
    // cursor reads as the start rather than a driver cast error.
    const after = opts.after && UUID_RE.test(opts.after) ? opts.after.toLowerCase() : null;
    const rows = await this.sql`
      SELECT id FROM thoughts
      WHERE (${after}::uuid IS NULL OR id > ${after}::uuid)
      ORDER BY id ASC
      LIMIT ${opts.limit}::int`;
    const ids = rows.map((r: { id: string }) => String(r.id));
    // A full page means more may follow; the cursor is its last id.
    // A full page (limit rows) means more may follow; its last id is the cursor. The
    // `> 0` guards a limit of 0 (unreachable via the tool, but a direct caller) from
    // an undefined cursor (review pass 3).
    const cursor = ids.length === opts.limit && ids.length > 0 ? ids[ids.length - 1] : null;
    // total and the whole-corpus digest ride the first page only — one extra scan,
    // skipped while paging. string_agg over zero rows is NULL, so an empty corpus
    // has a null digest (never mistaken for a match — the caller requires equal
    // NON-null digests before it skips enumeration).
    let total = 0;
    let digest: string | null = null;
    if (after === null) {
      const [agg] = await this.sql`
        SELECT count(*)::int AS total, md5(string_agg(id::text, ',' ORDER BY id)) AS digest FROM thoughts`;
      total = Number(agg.total);
      digest = (agg.digest as string | null) ?? null;
    }
    return { ids, total, digest, cursor };
  }

  async listVectorless(opts: { limit: number; after: string | null }): Promise<VectorlessRow[]> {
    // Through 100's partial index on (id) WHERE embedding IS NULL, both forms:
    // the page is the index's first rows from where it starts, 0.005-0.04 ms
    // at 100,000 thoughts with 0, 1 or 10% waiting (SMD-3056; before it, a scan
    // of every row whenever none waited past the cursor, 2-4 ms there).
    const after = opts.after && UUID_RE.test(opts.after) ? opts.after.toLowerCase() : null;
    // Two statements, not one with `$1 IS NULL OR id > $1`: under a generic
    // plan that form walked the index from its start every page (129 ms a
    // page at 100,000 thoughts, review pass 3); each of these has one plan.
    const origin = this.sql`(SELECT a.origin FROM thought_audit a WHERE a.thought_id = t.id AND a.action = 'capture' ORDER BY a.created_at ASC, a.id ASC LIMIT 1)`;
    const rows = after === null
      ? await this.sql`
          SELECT id, content, COALESCE(updated_at, created_at) AS updated_at, metadata, ${origin} AS origin
          FROM thoughts t WHERE embedding IS NULL ORDER BY id ASC LIMIT ${opts.limit}::int`
      : await this.sql`
          SELECT id, content, COALESCE(updated_at, created_at) AS updated_at, metadata, ${origin} AS origin
          FROM thoughts t WHERE embedding IS NULL AND id > ${after}::uuid ORDER BY id ASC LIMIT ${opts.limit}::int`;
    return rows.map((r: Record<string, unknown>) => normaliseVectorlessRow(r));
  }

  async mendLock(): Promise<(() => Promise<boolean>) | null> {
    // A session-level lock, held for the tick, on a client of one connection
    // of its own: never a pool connection, so live requests do not wait on a
    // tick's provider calls, and a pool of one does not wedge — the tick's
    // own reads and writes went through the pool while its lock held the
    // pool's only connection (review pass 2: OB1_PG_POOL=1 hung the server).
    this.lockSql ??= new SQL({ url: this.url, max: 1, onclose: () => { this.lockCloses++; } });
    const lock = this.lockSql;
    const closes = this.lockCloses;
    const [r] = await lock`SELECT pg_try_advisory_lock(hashtext('ob1:vector-mender')) AS got`;
    if (r.got !== true) return null;
    // False when the session that took it is not the one that lets it go —
    // a pooler in statement or transaction mode between here and Postgres —
    // and the lock is then left on a backend no tick will reach; the mender
    // says so. Not when that session closed since (a restart, a dropped
    // connection): the lock went with it (review pass 3).
    return async () => {
      const [u] = await lock`SELECT pg_advisory_unlock(hashtext('ob1:vector-mender')) AS released`;
      return u.released === true || this.lockCloses !== closes;
    };
  }

  async listLoggedSearches(opts: { since: string | null; limit: number }): Promise<LoggedSearchPage> {
    // The search rows of query_log (migration 034), most recent first, windowed by
    // `since`. One extra row over the limit tells the caller more matched without a
    // count query. query_log is opt-in (OB1_QUERY_LOG); when it was never on this
    // is simply empty.
    // "" is not a time: normalise it to null (no window) rather than cast it and
    // fail.
    const since = opts.since || null;
    const rows = await this.sql`
      SELECT query, arm, tier, logged_at, match_count, threshold, recency_weight, filter
      FROM query_log
      WHERE kind = 'search'
        AND query IS NOT NULL
        AND (${since}::timestamptz IS NULL OR logged_at > ${since}::timestamptz)
      ORDER BY logged_at DESC, id DESC
      LIMIT ${opts.limit + 1}::int`;
    const truncated = rows.length > opts.limit;
    const searches = rows.slice(0, opts.limit).map((r: Record<string, unknown>) => ({
      query: r.query as string,
      arm: (r.arm as LoggedSearchPage["searches"][number]["arm"]) ?? null,
      tier: (r.tier as string | null) ?? null,
      loggedAt: isoTimestampOrNull(r.logged_at as string | null),
      matchCount: (r.match_count as number | null) ?? null,
      threshold: (r.threshold as number | null) ?? null,
      recencyWeight: (r.recency_weight as number | null) ?? null,
      filter: (r.filter as Record<string, unknown> | null) ?? {},
    }));
    return { searches, truncated };
  }

  async heartbeats(): Promise<HeartbeatRead> {
    return readHeartbeats(this.sql as never);
  }

  async workerStatus(): Promise<WorkerStatusRow[]> {
    // Per work_type: the four status counts as the workers count them — a stale
    // lease stays 'claimed' until the next claim_thoughts() reaps it, so it is in
    // `claimed`, not `pending` (migration 015). `stale` is the derived subset, with
    // the oldest lease's time and holder. One GROUP BY, read-only, no lock, no write.
    // `thoughts` (the corpus total) rides the SAME statement as the per-work_type
    // counts, so both come from one snapshot: pooled ≤ total always, and `unpooled`
    // can never read negative under a concurrent delete of a pooled thought (a
    // separate count query is a torn read that could — review pass 2). `unpooled` =
    // corpus − pooled; the PK (thought_id, work_type) makes a work_type's claim rows
    // exactly its pooled thoughts, so this equals db/extract-entities.ts counts()'s
    // `NOT EXISTS` without the correlated scan. (reembed/consolidate keys pool by
    // model-aware rules; this generic definition matches extraction — fragment.)
    const rows = await this.sql`
      SELECT work_type,
             count(*) FILTER (WHERE status = 'pending')::int   AS pending,
             count(*) FILTER (WHERE status = 'claimed')::int   AS claimed,
             count(*) FILTER (WHERE status = 'succeeded')::int AS succeeded,
             count(*) FILTER (WHERE status = 'failed')::int    AS failed,
             count(*) FILTER (WHERE status = 'claimed' AND ttl_expires_at < now())::int AS stale,
             min(claimed_at) FILTER (WHERE status = 'claimed' AND ttl_expires_at < now()) AS oldest_stale_claimed_at,
             (array_agg(worker_id ORDER BY claimed_at) FILTER (WHERE status = 'claimed' AND ttl_expires_at < now()))[1] AS stale_worker_id,
             (SELECT count(*)::int FROM thoughts) AS thoughts
      FROM thought_work_claims
      GROUP BY work_type
      ORDER BY work_type`;
    // The active pools, from ob1_config: the extraction key and the subject pool's
    // (113, SMD-3306) verbatim, and the reembed key built from the recorded embedding
    // model and dim. consolidate records no key, so its work_types report active: null
    // rather than a false negative.
    const cfg = Object.fromEntries(
      (await this.sql`SELECT key, value FROM ob1_config WHERE key IN ('entity_extraction_key', 'subject_pool_key', 'embedding_model', 'embedding_dim')`)
        .map((r: { key: string; value: string }) => [r.key, r.value]),
    ) as Record<string, string | undefined>;
    const reembedKey = cfg.embedding_model && cfg.embedding_dim ? `reembed:${cfg.embedding_model}@${cfg.embedding_dim}` : null;
    const activeOf = (wt: string): boolean | null => {
      if (wt === cfg.entity_extraction_key || wt === cfg.subject_pool_key) return true;
      if (reembedKey !== null && wt === reembedKey) return true;
      if (wt.startsWith("consolidate:")) return null;
      return false;
    };
    return rows.map((r: Record<string, unknown>) => {
      const pending = Number(r.pending);
      const claimed = Number(r.claimed);
      const succeeded = Number(r.succeeded);
      const failed = Number(r.failed);
      const total = Number(r.thoughts);
      return {
        workType: String(r.work_type),
        pending,
        claimed,
        succeeded,
        failed,
        unpooled: total - (pending + claimed + succeeded + failed),
        thoughts: total,
        stale: Number(r.stale),
        oldestStaleClaimedAt: isoTimestampOrNull(r.oldest_stale_claimed_at as string | null),
        staleWorkerId: (r.stale_worker_id as string | null) ?? null,
        active: activeOf(String(r.work_type)),
      };
    });
  }

  async retryFailed(workType: string): Promise<RetryFailedResult> {
    // The write half of workerStatus, over thought_work_claims (SMD-2132): the
    // db/*.ts --retry-failed path (extract-entities.ts:413-420) as one statement.
    // Scoped to the one pool — WHERE work_type = $1 AND status = 'failed' — so a
    // sibling pool's failures are untouched; a fresh attempt clears the recorded
    // error, the finish time and the count (015's REQUEUE_SET_SQL shape). The
    // caller has already gated the write scope. RETURNING the ids feeds the audit.
    const rows = await this.sql`
      UPDATE thought_work_claims
         SET status = 'pending', last_error = NULL, finished_at = NULL, attempt_count = 0
       WHERE work_type = ${workType} AND status = 'failed'
      RETURNING thought_id`;
    const ids = rows.map((r: { thought_id: string }) => String(r.thought_id));
    return { workType, retried: ids.length, ids };
  }

  async releaseStaleLeases(opts: ReleaseLeasesOpts): Promise<ReleaseLeasesResult> {
    // The write half of workerStatus (SMD-2132): return `claimed` rows to the
    // pool, the release_claims_for_worker(...) path (migration 015:362-382) over a
    // tool. The SET mirrors that function — pending, TTL cleared, attempt
    // decremented (an un-run lease is not penalised, so a released row is not one
    // attempt closer to 'failed'). One static statement; the optional scoping and
    // the live-lease switch ride as parameters rather than composed SQL, so there
    // is no interpolation to escape (see the bun-sql template rules). Without
    // includeLive only past-ttl_expires_at leases match — a live lease is left for
    // its holder. The caller has gated the write scope and refused includeLive
    // without a workerId; this method trusts that and does the mutation.
    const workType = opts.workType ?? null;
    const workerId = opts.workerId ?? null;
    const includeLive = opts.includeLive === true;
    // Defense in depth: the surfaces refuse includeLive without a workerId as a
    // value (with a code), and never reach here without one — but a direct caller
    // must not be able to release EVERY live lease across every pool by omitting it.
    if (includeLive && (workerId === null || workerId.trim() === "")) {
      throw new Error("releaseStaleLeases: includeLive requires a workerId — refusing to release every live lease");
    }
    const rows = await this.sql`
      UPDATE thought_work_claims
         SET status = 'pending', ttl_expires_at = NULL, attempt_count = GREATEST(attempt_count - 1, 0)
       WHERE status = 'claimed'
         AND (${workType}::text IS NULL OR work_type = ${workType})
         AND (${workerId}::text IS NULL OR worker_id = ${workerId})
         AND (${includeLive} OR ttl_expires_at < now())
      RETURNING thought_id, worker_id`;
    const claimed = rows as Record<string, unknown>[];
    const ids = claimed.map((r) => String(r.thought_id));
    const workers = Array.from(new Set(
      claimed.map((r) => r.worker_id).filter((w): w is string => typeof w === "string"),
    ));
    return { released: ids.length, ids, workers };
  }

  async dryRunClaim(workType: string, limit?: number): Promise<DryRunClaimResult> {
    // The dry_run half of run_worker (SMD-2272): a pure SELECT preview, claiming
    // nothing. The census is workerStatus's per-work_type row, scoped to one pool
    // — the SAME four status counts and stale subset, and `unpooled` = corpus −
    // pooled — so a dry run and worker_status agree by construction (the guard's
    // "reports the same pool worker_status shows"). No GROUP BY: the aggregate over
    // a single work_type always returns exactly one row (all-zero when the pool has
    // no claim rows yet), so an un-enqueued pool reads unpooled = the whole corpus.
    // `thoughts` rides the same statement as the per-pool counts (one snapshot, so
    // unpooled can never read negative under a concurrent delete — workerStatus's
    // review-pass-2 reasoning). NO claim_thoughts, enqueue_thoughts or lease — the
    // executing drain is deferred to SMD-2304's callable core. SQL-backend only.
    const rows = await this.sql`
      SELECT count(*) FILTER (WHERE status = 'pending')::int   AS pending,
             count(*) FILTER (WHERE status = 'claimed')::int   AS claimed,
             count(*) FILTER (WHERE status = 'succeeded')::int AS succeeded,
             count(*) FILTER (WHERE status = 'failed')::int    AS failed,
             count(*) FILTER (WHERE status = 'claimed' AND ttl_expires_at < now())::int AS stale,
             (SELECT count(*)::int FROM thoughts) AS thoughts
        FROM thought_work_claims
       WHERE work_type = ${workType}`;
    const r = (rows[0] ?? {}) as Record<string, unknown>;
    const pending = Number(r.pending ?? 0);
    const claimed = Number(r.claimed ?? 0);
    const succeeded = Number(r.succeeded ?? 0);
    const failed = Number(r.failed ?? 0);
    const total = Number(r.thoughts ?? 0);
    const stale = Number(r.stale ?? 0);
    const unpooled = total - (pending + claimed + succeeded + failed);
    // A full pass reaps expired (stale) leases back to the pool BEFORE it claims —
    // claim_thoughts() "returns expired leases for the work_type to the pool, then
    // takes up to p_batch pending rows" (migration 015) — so a stale lease is
    // drainable now too, not only a `pending` or `unpooled` row. Hence backlog =
    // pending + stale + unpooled (the three disjoint drainable sets; live `claimed`
    // rows are held by a live worker and skipped). A stale row already at
    // p_max_attempts is failed rather than re-claimed, so this stays an upper bound.
    const backlog = pending + stale + unpooled;
    const wouldClaim = limit !== undefined ? Math.min(backlog, limit) : backlog;
    return {
      workType,
      pending,
      claimed,
      succeeded,
      failed,
      stale,
      unpooled,
      thoughts: total,
      backlog,
      wouldClaim,
      limit: limit ?? null,
    };
  }

  async databaseFacts(opts?: ReadOptions, progress?: ReadProgress): Promise<DatabaseFacts> {
    return readDatabaseFacts(this.sql, opts, progress);
  }

  async statsSummary(): Promise<ThoughtStats> {
    // Migration 024: the whole corpus aggregated in one statement. No page walk,
    // no cap — Postgres reads the table directly, so `aggregated` is the total
    // and the tool never prints a truncation note. jsonb comes back from Bun.sql already parsed into JS values.
    // One row, one jsonb, every key present — 024 builds the object with all
    // six, so no optional keys and no empty-object fallback: a missing key
    // would be a changed function, and isoTimestampOrNull throws on it.
    const rows = await this.sql`SELECT thought_stats_summary() AS s`;
    const s = rows[0].s as {
      total: number;
      first_ts: string | null;
      last_ts: string | null;
      types: Record<string, number>;
      topics: Record<string, number>;
      people: Record<string, number>;
    };
    const total = Number(s.total);
    return {
      total,
      oldest: isoTimestampOrNull(s.first_ts),
      newest: isoTimestampOrNull(s.last_ts),
      types: s.types,
      topics: s.topics,
      people: s.people,
      aggregated: total,
    };
  }

  async pageThoughtMeta(offset: number, limit: number): Promise<ThoughtMeta[]> {
    // No 1000-row cap: that was a PostgREST default, not a Postgres one. The
    // caller's paging bounds memory; no silent ceiling stands behind it.
    const rows = await this.sql`
      SELECT metadata, created_at
      FROM thoughts
      ORDER BY created_at DESC, id DESC
      LIMIT ${limit}::int OFFSET ${offset}::int`;
    return rows.map(normaliseThoughtMeta);
  }

  async captureThought(opts: {
    content: string;
    payload: { metadata: Record<string, unknown> };
    embedding: number[] | null;
    chunks?: { content: string; embedding: number[]; context?: string }[];
    actor?: Actor;
    embeddingModel?: string;
    derivedFrom?: string[];
    supersedes?: string;
    lineage?: Lineage;
    event?: WriteEvent;
    recapture?: "keep";
  }): Promise<CaptureResult> {
    // One statement. No two-step fallback and no PGRST202 handling: over SQL a
    // missing function is a migration failure, and silently degrading to a
    // non-atomic write would reintroduce exactly the bug migration 004 removes.
    // `payload` is passed as an object — see the double-encoding note at the top.
    // The array is passed as an object, NOT JSON.stringify'd — see the
    // double-encoding note at the top of this file. A pre-stringified value binds
    // as a jsonb *scalar string*, and jsonb_array_length then fails with "cannot
    // get array length of a scalar".
    //
    // The 4-arg overload also replaces the thought's chunk rows, in the same
    // statement, so a long capture cannot end up half-chunked. The 3-arg form is
    // kept for the ordinary case rather than passing an empty array, so a
    // deployment that has not applied migration 007 keeps working unchanged.
    const chunks = opts.chunks ?? [];
    /**
     * The actor rides in the payload envelope, which migration 008's
     * upsert_thought reads into a transaction-local setting for the audit
     * trigger. Doing it here rather than with an explicit `set_config` around
     * the call keeps attribution in the function, for every caller — an
     * earlier version wrapped this in a transaction and left the PostgREST
     * store (retired in SMD-3152) unattributed.
     */
    // The model rides the same way (021): upsert_thought writes
    // p_payload.embedding_model beside the vector, and an envelope without the
    // key leaves the row's label unknown.
    // 025: derived_from / supersedes ride it too; upsert_thought validates
    // derived_from and refuses a bad one — see store.ts's captureEnvelope.
    // 061: the lineage envelope — the windows' and the tags' recipes — rides
    // the same way, and upsert_thought records them with the write.
    // 080: and the recapture word, "keep" for a key that cannot read.
    const envelope = captureEnvelope(opts.payload, opts.actor, opts.embeddingModel,
      { derivedFrom: opts.derivedFrom, supersedes: opts.supersedes }, opts.lineage, opts.event, opts.recapture);

    const rows = chunks.length
      ? await this.sql`
          SELECT upsert_thought(
            ${opts.content}::text,
            ${envelope}::jsonb,
            ${opts.embedding ? toVector(opts.embedding) : null}::vector,
            ${chunks.map((c) => ({ content: c.content, embedding: toVector(c.embedding), context: c.context ?? null }))}::jsonb
          ) AS r`
      : await this.sql`
          SELECT upsert_thought(
            ${opts.content}::text,
            ${envelope}::jsonb,
            ${opts.embedding ? toVector(opts.embedding) : null}::vector
          ) AS r`;

    const r = rows[0]?.r as { id?: string; fingerprint?: unknown; existed?: unknown; supersedes?: unknown } | undefined;
    const id = r?.id;
    if (!id) throw new Error("upsert_thought returned no id.");
    // 082: a key that can read landed on a row that already held the text —
    // recorded, so the row stops being its capturer's (SMD-2638), even when
    // the merge changed nothing and wrote no event. A second statement: a
    // pooler in statement mode passes it, and a failure here throws after the
    // capture landed, so the caller's retry lands on the row again and the
    // note is made then. A database before 082 has no such function, and the
    // capture stands without it.
    if (r?.existed === true && opts.recapture !== "keep") {
      try {
        await this.sql`SELECT ob1_note_recapture(${id}::uuid, ${actorPayload(opts.actor)}::jsonb)`;
      } catch (e) {
        if (String((e as { errno?: unknown }).errno ?? "") !== "42883") throw e;
      }
    }
    // 085: and when the row's stamp is still a capture-only key's, at a trust
    // above it, the stamp moves to this key (SMD-2664) — the trust this write
    // declares, checked against the text it captured. Made the way the note
    // is made, and after it, so a restamp that fails never holds up the note.
    // 090: through ob1_weigh_recapture, which says what it did to the label
    // (SMD-2898); a database at 085–089 has only ob1_restamp_recapture, which
    // moves it and says nothing, and one before 085 neither.
    let label;
    if (r?.existed === true && opts.recapture !== "keep") {
      const args = [id, typeof r.fingerprint === "string" ? r.fingerprint : null, actorPayload(opts.actor), opts.event?.trust ?? null] as const;
      try {
        label = normaliseRecaptureLabel((await this.sql`SELECT ob1_weigh_recapture(${args[0]}::uuid, ${args[1]}::text, ${args[2]}::jsonb, ${args[3]}::text) AS r`)[0]?.r);
      } catch (e) {
        // Only the function's own absence falls back: a 42883 from inside it
        // (a helper it calls gone) is a broken schema, said rather than
        // swallowed (review pass 1).
        if (String((e as { errno?: unknown }).errno ?? "") !== "42883" || !/ob1_weigh_recapture\(/.test(String((e as Error).message))) throw e;
        try {
          await this.sql`SELECT ob1_restamp_recapture(${args[0]}::uuid, ${args[1]}::text, ${args[2]}::jsonb, ${args[3]}::text)`;
        } catch (e2) {
          if (String((e2 as { errno?: unknown }).errno ?? "") !== "42883") throw e2;
        }
      }
    }
    // 035: `existed` says the text was already there and the envelope's
    // provenance was not written. Passed on only when the body said (a
    // database before 035 returns none, and a guess would be a lie).
    return { id, ...(typeof r?.existed === "boolean" ? { existed: r.existed, supersedes: typeof r.supersedes === "string" ? r.supersedes : null } : {}), ...(label ? { label } : {}) };
  }

  async updateThought(opts: {
    id: string;
    content?: string;
    metadataPatch?: Record<string, unknown>;
    embedding?: number[];
    chunks?: { content: string; embedding: number[]; context?: string }[];
    ifUnchangedSince?: string;
    actor?: Actor;
    embeddingModel?: string;
    provenance?: UpdateProvenance;
    lineage?: Lineage;
  }): Promise<UpdateResult> {
    const chunks = (opts.chunks ?? []).map((c) => ({
      content: c.content,
      embedding: toVector(c.embedding),
      context: c.context ?? null,
    }));
    // Eleven arguments since migration 061: the model beside the vector (021),
    // the provenance envelope — NULL when the edit named none (032) — the
    // write event, which this server does not send on an edit (046: NULL),
    // and the lineage envelope, the windows' and the tags' recipes (061) —
    // NULL when the edit carries neither.
    const rows = await this.sql`
      SELECT update_thought(
        ${opts.id}::uuid,
        ${opts.content ?? null}::text,
        ${opts.metadataPatch ?? null}::jsonb,
        ${opts.embedding ? toVector(opts.embedding) : null}::vector,
        ${chunks.length ? chunks : null}::jsonb,
        ${opts.ifUnchangedSince ?? null}::timestamptz,
        ${actorPayload(opts.actor)}::jsonb,
        ${opts.embeddingModel ?? null}::text,
        ${provenanceEnvelope(opts.provenance)}::jsonb,
        NULL::jsonb,
        ${opts.lineage ?? null}::jsonb
      ) AS r`;
    return normaliseMutation(rows[0]?.r as Record<string, unknown>);
  }

  async deleteThought(opts: {
    id: string;
    actor?: Actor;
    detach?: boolean;
  }): Promise<DeleteResult> {
    // 042's third argument, always sent: the function's default is false, and
    // spelling it keeps the call to one signature.
    const rows = await this.sql`
      SELECT delete_thought(${opts.id}::uuid, ${actorPayload(opts.actor)}::jsonb, ${opts.detach === true}::boolean) AS r`;
    return normaliseMutation(rows[0]?.r as Record<string, unknown>);
  }

  async resetCaptureStamp(opts: { id: string; actor?: Actor }): Promise<ResetStampResult> {
    // 086: one statement, as the note and the restamp are made; the function
    // decides who may, and names the actor in the event it appends.
    const rows = await this.sql`SELECT ob1_reset_capture_stamp(${opts.id}::uuid, ${actorPayload(opts.actor)}::jsonb) AS r`;
    return normaliseResetStamp(rows[0]?.r);
  }

  // Work claims (migration 115, SMD-3598): one statement each, so each call is its own READ COMMITTED transaction
  // and takes one ticket's lock (115's rule: one writer call per transaction). Every value is a bind parameter: the
  // token above all, which a statement's text would show in pg_stat_activity and error lines.
  async claimWork(opts: { issue: string; piece?: string; label?: string; leaseSeconds?: number; token?: string; actor?: Actor }): Promise<ClaimAnswer> {
    return claimCall("claim_work", () => this.sql`
      SELECT claim_work(${opts.issue}::text, ${opts.piece ?? null}::text, ${opts.label ?? null}::text, ${opts.leaseSeconds ?? 14400}::int,
                        ${opts.token ?? null}::text, ${actorPayload(opts.actor)}::jsonb) AS r`);
  }

  async renewClaim(opts: { id: string; token: string; leaseSeconds?: number; actor?: Actor }): Promise<ClaimAnswer> {
    return claimCall("renew_work_claim", () => this.sql`
      SELECT renew_work_claim(${opts.id}::uuid, ${opts.token}::text, ${opts.leaseSeconds ?? 14400}::int, ${actorPayload(opts.actor)}::jsonb) AS r`);
  }

  async releaseClaim(opts: { id: string; token?: string; reason?: string; force?: boolean; actor?: Actor }): Promise<ClaimAnswer> {
    return claimCall("release_work_claim", () => this.sql`
      SELECT release_work_claim(${opts.id}::uuid, ${opts.token ?? null}::text, ${opts.reason ?? null}::text, ${opts.force === true}::boolean,
                                ${actorPayload(opts.actor)}::jsonb) AS r`);
  }

  async claimTokenIs(id: string, token: string): Promise<boolean> {
    const rows = await this.sql`
      SELECT EXISTS (SELECT 1 FROM work_claims WHERE id = ${id}::uuid AND token_hash = ob1_work_claim_token_hash(${token}::text)) AS mine` as { mine: boolean }[];
    return rows[0]?.mine === true;
  }

  async listClaims(opts: { issue?: string; holder?: string; includeEnded?: boolean; limit?: number }): Promise<WorkClaim[]> {
    const rows = await this.sql`
      SELECT id, issue, piece, holder, holder_agent_id, holder_kind, label, claimed_at, renewed_at, expires_at,
             released_at, released_by, released_by_kind, release_reason, state
        FROM list_work_claims(${opts.issue === undefined ? null : this.sql.array([opts.issue], "TEXT")}::text[], ${opts.holder ?? null}::text,
                              ${opts.includeEnded === true}::boolean, ${opts.limit ?? 100}::int)` as Record<string, unknown>[];
    return rows.map((r) => normaliseWorkClaim(r, "list_work_claims"));
  }

  async unreleasedClaimsOn(issues: string[], limit: number): Promise<WorkClaim[]> {
    // SMD-3599: 115's partial index on the unreleased claims (work_claims_one_unreleased, issue and piece key) finds
    // them; list_work_claims gives live ones, or every one, released included, which would spend the limit on history.
    // The keys are the ones a hit is filed under and names, upper-case as 115 stores them; the server role's existing SELECT reads the table.
    const rows = await this.sql`
      SELECT ob1_work_claim_json(c, now()) AS j
        FROM work_claims c
       WHERE c.issue = ANY (${this.sql.array(issues, "TEXT")}::text[]) AND c.released_at IS NULL
       ORDER BY c.issue, c.piece_key, c.claimed_at, c.id
       LIMIT ${limit}::int` as { j: unknown }[];
    return rows.map((r) => normaliseWorkClaim(r.j, "ob1_work_claim_json"));
  }

  // SMD-3654: the lease a renewal starts from, and what was claimed on the work while it had lapsed — two reads beside
  // 115's writers, the token a bind parameter matched by its hash, as claimTokenIs does. Neither returns a token or hash.
  async claimLease(token: string, id?: string, work?: ClaimLeaseWork): Promise<ClaimLease | null> {
    // Separate statements, not `$id IS NULL OR id = $id`: a generic plan would lose the primary key. claim_work's form
    // asks, with 115's own functions, whether the claim is the caller's on exactly the work asked: a ticket or piece
    // 115 would refuse raises here as it would there, and the writer then answers it; a piece blank once cleaned, which
    // 115 refuses rather than reading as the whole ticket, is no match (review pass 5). The caller's own: 115's holder
    // test, or — the registry away, so no agent id — a claim made with an id under the caller's name, as ownWhileAway
    // reads it for renew_claim (review pass 5: such a call made a new claim again).
    const rows = (id !== undefined
      ? await this.sql`SELECT id, expires_at, released_at, released_by, release_reason FROM work_claims WHERE id = ${id}::uuid AND token_hash = ob1_work_claim_token_hash(${token}::text)`
      : work === undefined
        ? await this.sql`SELECT id, expires_at, released_at, released_by, release_reason FROM work_claims WHERE token_hash = ob1_work_claim_token_hash(${token}::text)`
        : await this.sql`
            SELECT id, expires_at, released_at, released_by, release_reason,
                   (c.issue = ob1_work_claim_issue(${work.ticket}::text)
                    AND NOT (${work.piece ?? null}::text IS NOT NULL AND ob1_work_claim_text(${work.piece ?? null}::text, 100, 'a piece') IS NULL)
                    AND c.piece_key = COALESCE(lower(ob1_work_claim_text(${work.piece ?? null}::text, 100, 'a piece')), '')
                    AND (ob1_work_claim_is_holder(c, ${work.name}::text, ${work.agentId ?? null}::uuid, c.token_hash)
                         OR (${work.agentId ?? null}::uuid IS NULL AND c.holder_agent_id IS NOT NULL AND c.holder_name = ${work.name}::text))) AS own_on_this_work
              FROM work_claims c WHERE token_hash = ob1_work_claim_token_hash(${token}::text)`) as Record<string, unknown>[];
    const r = rows[0];
    if (!r || typeof r.id !== "string" || r.expires_at == null) return null;
    return {
      id: r.id, expiresAt: isoTimestampOrNull(r.expires_at) as string, releasedAt: isoTimestampOrNull(r.released_at ?? null),
      releasedBy: typeof r.released_by === "string" ? r.released_by : null, releaseReason: typeof r.release_reason === "string" ? r.release_reason : null,
      ...(work !== undefined ? { ownOnThisWork: r.own_on_this_work === true } : {}),
    };
  }

  async claimsMadeSince(id: string, since: string, limit: number): Promise<{ claims: WorkClaim[]; total: number }> {
    // 115's overlap (ob1_work_claims_in_the_way): the same piece key, or either the whole ticket. Made or renewed
    // since: no overlapping claim was live while this one was, so either time after the lapse means live in it.
    const rows = await this.sql`
      SELECT ob1_work_claim_json(c, now()) AS j, count(*) OVER () AS total
        FROM work_claims c JOIN work_claims m ON m.id = ${id}::uuid AND c.issue = m.issue AND c.id <> m.id
       WHERE (c.claimed_at > ${since}::timestamptz OR c.renewed_at > ${since}::timestamptz)
         AND (c.piece_key = m.piece_key OR c.piece_key = '' OR m.piece_key = '')
       ORDER BY c.claimed_at, c.id
       LIMIT ${limit}::int` as { j: unknown; total: unknown }[];
    return { claims: rows.map((r) => normaliseWorkClaim(r.j, "ob1_work_claim_json")), total: rows.length ? Number(rows[0].total) : 0 };
  }

  // SMD-3664: 116's writers, the envelope stating the key's scope — 116 refuses one stating neither write nor capture,
  // and the server's actor carries a scope for a capture key alone — and every value a bind parameter.
  async assertPriority(opts: {
    kind: string; key: string; level: number; dueAt?: string; notBefore?: string; dueRef?: { kind: string; key: string }; reason?: string; inferred?: boolean;
    actor?: Actor; scope: "write" | "capture"; plugin?: string;
  }): Promise<PriorityAnswer> {
    // 117's envelope: the plugin a ctx.call came through, which owns the items its rows stand for (SMD-3665 PR 2).
    return priorityCall("assert_priority", () => this.sql`
      SELECT assert_priority(${opts.kind}::text, ${opts.key}::text, ${opts.level}::int, ${opts.dueAt ?? null}::timestamptz, ${opts.notBefore ?? null}::timestamptz,
                             ${opts.dueRef?.kind ?? null}::text, ${opts.dueRef?.key ?? null}::text, ${opts.reason ?? null}::text, ${opts.inferred === true}::boolean,
                             ${itemEnvelope(opts.actor, opts.scope, opts.plugin)}::jsonb) AS r`);
  }

  async clearPriority(opts: { kind: string; key: string; actor?: Actor; scope: "write" | "capture" }): Promise<PriorityAnswer> {
    return priorityCall("clear_priority", () => this.sql`
      SELECT clear_priority(${opts.kind}::text, ${opts.key}::text, ${itemEnvelope(opts.actor, opts.scope, undefined)}::jsonb) AS r`);
  }

  async priorityRecord(kind: string, key: string): Promise<PriorityRecord> {
    // One statement, so the winner and the history are one snapshot's: a write between two reads could leave a
    // winner the history does not hold. The item keyed once by 116's ob1_priority_item, the winner by its rule
    // (ob1_priority_winner), the statements aggregated once, by priority_history (review pass 1: priority_of's list
    // was a second aggregation, thrown away).
    let rows: Record<string, unknown>[];
    try {
      rows = await this.sql`
        SELECT i.kind AS item_kind, i.key AS item_key, ob1_priority_item_exists(i.kind, i.key) AS exists,
               (SELECT ob1_priority_json(w) FROM ob1_priority_winner(i.kind, i.key) w WHERE w.id IS NOT NULL) AS winner,
               priority_history(i.kind, i.key) AS history
          FROM ob1_priority_item(${kind}::text, ${key}::text) i` as Record<string, unknown>[];
    } catch (e) {
      throw priorityRefusedOr(e);
    }
    const r = rows[0];
    if (!r || !(PRIORITY_KINDS as readonly unknown[]).includes(r.item_kind) || typeof r.item_key !== "string" || !Array.isArray(r.history)) {
      throw new Error("ob1_priority_item answered no item this server reads");
    }
    const winner = r.winner === null || r.winner === undefined ? null : normalisePriorityAssertion(r.winner, "ob1_priority_winner");
    return {
      item: { kind: r.item_kind as PriorityItem["kind"], key: r.item_key },
      exists: r.exists === true,
      level: winner?.level ?? null,
      winner,
      history: (r.history as unknown[]).map((a) => normalisePriorityAssertion(a, "priority_history")),
    };
  }

  async priorityItem(kind: string, key: string): Promise<{ item: PriorityItem; exists: boolean }> {
    let rows: Record<string, unknown>[];
    try {
      rows = await this.sql`
        SELECT i.kind, i.key, ob1_priority_item_exists(i.kind, i.key) AS exists FROM ob1_priority_item(${kind}::text, ${key}::text) i` as Record<string, unknown>[];
    } catch (e) {
      throw priorityRefusedOr(e);
    }
    const r = rows[0];
    if (!r || !(PRIORITY_KINDS as readonly unknown[]).includes(r.kind) || typeof r.key !== "string") throw new Error("ob1_priority_item answered no item this server reads");
    return { item: { kind: r.kind as PriorityItem["kind"], key: r.key }, exists: r.exists === true };
  }

  // SMD-3665 PR 2: 117's writers, the envelope stating the key's scope and the plugin a call came through, and every
  // value a bind parameter. A due time rides as text: 117 reads it (ISO 8601, UTC without an offset).
  async openItem(opts: { text: string; owner?: string; dueAt?: string; originThought?: string; pluginRow?: string; proposed?: boolean; actor?: Actor; scope: "write" | "capture"; plugin?: string }): Promise<ItemAnswer> {
    return itemCall("open_item", () => this.sql`
      SELECT open_item(${opts.text}::text, ${opts.owner ?? null}::text, ${opts.dueAt ?? null}::text, ${opts.originThought ?? null}::uuid,
                       ${opts.pluginRow ?? null}::text, ${opts.proposed === true}::boolean, ${itemEnvelope(opts.actor, opts.scope, opts.plugin)}::jsonb) AS r`);
  }

  async updateItem(opts: { id: string; changes: { text?: string; owner?: string | null; dueAt?: string | null }; actor?: Actor; scope: "write" | "capture"; plugin?: string }): Promise<ItemAnswer> {
    // Only the fields given: a JSON null clears owner or due_at, an absent one keeps it.
    const c = opts.changes;
    const changes = { ...(c.text !== undefined ? { text: c.text } : {}), ...(c.owner !== undefined ? { owner: c.owner } : {}), ...(c.dueAt !== undefined ? { due_at: c.dueAt } : {}) };
    return itemCall("update_item", () => this.sql`
      SELECT update_item(${opts.id}::text, ${changes}::jsonb, ${itemEnvelope(opts.actor, opts.scope, opts.plugin)}::jsonb) AS r`);
  }

  async setItemStatus(opts: { id: string; status: "open" | "done" | "dropped"; reason?: string; actor?: Actor; scope: "write" | "capture"; plugin?: string }): Promise<ItemAnswer> {
    return itemCall("set_item_status", () => this.sql`
      SELECT set_item_status(${opts.id}::text, ${opts.status}::text, ${opts.reason ?? null}::text, ${itemEnvelope(opts.actor, opts.scope, opts.plugin)}::jsonb) AS r`);
  }

  async proposeItemClose(opts: { id: string; status: "done" | "dropped"; evidenceThought?: string; label?: string; reason?: string; actor?: Actor; scope: "write" | "capture"; plugin?: string }): Promise<ItemAnswer> {
    return itemCall("propose_item_close", () => this.sql`
      SELECT propose_item_close(${opts.id}::text, ${opts.status}::text, ${opts.evidenceThought ?? null}::uuid, ${opts.label ?? null}::text, ${opts.reason ?? null}::text,
                                ${itemEnvelope(opts.actor, opts.scope, opts.plugin)}::jsonb) AS r`);
  }

  async decideItemClose(opts: { proposal: string; accept: boolean; reason?: string; actor?: Actor; scope: "write" | "capture"; plugin?: string }): Promise<ItemAnswer> {
    return itemCall("decide_item_close", () => this.sql`
      SELECT decide_item_close(${opts.proposal}::uuid, ${opts.accept}::boolean, ${opts.reason ?? null}::text, ${itemEnvelope(opts.actor, opts.scope, opts.plugin)}::jsonb) AS r`);
  }

  async itemHistory(id: string): Promise<ItemRecord> {
    let rows: Record<string, unknown>[];
    try {
      rows = await this.sql`SELECT open_item_history(${id}::text) AS r` as Record<string, unknown>[];
    } catch (e) {
      throw itemRefusedOr(e);
    }
    return normaliseItemRecord(rows[0]?.r, "open_item_history");
  }

  async listItems(opts: { statuses: ItemStatus[]; overdue: boolean; originThought?: string; plugin?: string; limit: number }): Promise<{ items: ItemListRow[]; truncated: boolean }> {
    // One more than the limit, so `truncated` is read rather than guessed. Overdue on the read's clock (now()): an
    // open or proposed item due before it. The pending count is the item's closes still waiting on a decision.
    let rows: Record<string, unknown>[];
    try {
      rows = await this.sql`
        SELECT ob1_item_json(i) AS j,
               (i.status IN ('open', 'proposed') AND i.due_at < now()) AS overdue,
               (SELECT count(*)::int FROM open_item_close_proposals p WHERE p.item_id = i.item_id AND p.decision IS NULL) AS pending
          FROM open_items i
         WHERE i.status = ANY(${this.sql.array(opts.statuses, "TEXT")}::text[])
           AND (NOT ${opts.overdue}::boolean OR (i.status IN ('open', 'proposed') AND i.due_at < now()))
           AND (${opts.originThought ?? null}::uuid IS NULL OR i.origin_thought_id = ${opts.originThought ?? null}::uuid)
           AND (${opts.plugin ?? null}::text IS NULL OR i.plugin = ${opts.plugin ?? null}::text)
         ORDER BY i.due_at NULLS LAST, i.noted_at DESC, i.item_id
         LIMIT ${opts.limit + 1}::int` as Record<string, unknown>[];
    } catch (e) {
      throw itemRefusedOr(e);
    }
    const items = rows.slice(0, opts.limit).map((r) => ({ ...normaliseOpenItem(r.j, "ob1_item_json"), overdue: r.overdue === true, pendingProposals: Number(r.pending ?? 0) }));
    return { items, truncated: rows.length > opts.limit };
  }

  async reviewProposal(opts: { id: string; decision: "accept" | "reject"; note?: string; direction?: "newer" | "older"; force?: boolean; actor?: Actor }): Promise<ReviewResult> {
    // SMD-3338: one transaction, under 029's lock — the CLI's own decision
    // (proposal-review.ts). The audit rows name the actor as its envelope does.
    return reviewProposal(this.sql, { id: opts.id, decision: opts.decision, note: opts.note ?? null, direction: opts.direction ?? null, force: opts.force === true, actor: actorPayload(opts.actor), actorName: opts.actor?.name ?? "" });
  }

  async resolveAgent(opts: { keyHash: string; label: string; scope?: string }): Promise<AgentResolution> {
    // Each lock wait capped (RESOLVE_LOCK_TIMEOUT_MS), so a lookup of a locked
    // registry holds its connection for the cap, not for the lock; the timeout
    // raises 55P03 and agents.ts retries, then answers the key as busy. One
    // statement, no BEGIN, so a pooler in statement mode passes it (one that
    // carries Bun's prepared statements — PgBouncer 1.21+ with
    // max_prepared_statements set): the materialised CTE sets the ceiling (a
    // stricter setting kept) before resolve_agent — volatile, so evaluated per
    // row of it — plans its reads, and lock_timeout is read as each wait
    // begins. One row whatever pg_settings holds (the scalar subquery; NULL is
    // the cap), so resolve_agent always runs. set_config's `true` ends it with
    // the statement's implicit transaction; the pooled connection keeps its own.
    const rows = await this.sql`
      WITH cap AS MATERIALIZED (
        SELECT set_config('lock_timeout', (CASE WHEN s.lt IS NULL OR s.lt = 0 OR s.lt > ${RESOLVE_LOCK_TIMEOUT_MS}::int THEN ${RESOLVE_LOCK_TIMEOUT_MS}::int ELSE s.lt END)::text, true)
          FROM (SELECT (SELECT setting::int FROM pg_settings WHERE name = 'lock_timeout') AS lt) s)
      SELECT resolve_agent(${opts.keyHash}::text, ${opts.label}::text, ${opts.scope ?? null}::text) AS r FROM cap`;
    return normaliseAgentResolution(rows[0]?.r);
  }

  async captureActorOf(id: string): Promise<{ actorName: string | null; agentId: string | null } | null> {
    if (!UUID_RE.test(id)) return null;
    // The FIRST capture row: a re-capture of the same text by another key
    // writes no new row (035), and an update is not a capture.
    const rows = await this.sql`
      SELECT actor_name, canonical_agent_id::text AS agent_id FROM thought_audit
      WHERE thought_id = ${id}::uuid AND action = 'capture' ORDER BY created_at ASC, id ASC LIMIT 1`; // id is a uuid (008): the tiebreak is stable, not chronological — a thought has one capture row by construction (035), so the tie is theory
    const r = rows[0] as { actor_name?: string | null; agent_id?: string | null } | undefined;
    return r ? { actorName: r.actor_name ?? null, agentId: r.agent_id ?? null } : null;
  }

  async takenFromCapturer(id: string): Promise<boolean> {
    if (!UUID_RE.test(id)) return true;
    const rows = await this.sql`SELECT ob1_thought_taken(${id}::uuid) AS taken`;
    return (rows[0] as { taken?: boolean } | undefined)?.taken !== false;
  }

  async existingIds(ids: string[]): Promise<Set<string>> {
    const valid = idList(ids);
    if (valid.length === 0) return new Set();
    const rows = await this.sql`SELECT id::text AS id FROM thoughts WHERE id = ANY(${this.sql.array(valid, "TEXT")}::uuid[])`;
    return new Set((rows as { id: string }[]).map((r) => String(r.id).toLowerCase()));
  }

  async thoughtsNamed(names: string[]): Promise<Map<string, string>> {
    const valid = idList(names);
    if (valid.length === 0) return new Map();
    // The id first: a thought a refresh copied has its source's id, and a key
    // equal to it names that thought. The key's arm reads 112's partial
    // unique index (an equality implies its IS NOT NULL predicate).
    const rows = await this.sql`
      SELECT n.name, COALESCE(
        (SELECT t.id::text FROM thoughts t WHERE t.id = n.name::uuid),
        (SELECT t.id::text FROM thoughts t WHERE t.metadata->>'client_key' = n.name)) AS id
      FROM unnest(${this.sql.array(valid, "TEXT")}::text[]) AS n(name)`;
    const named = new Map<string, string>();
    for (const r of rows as { name: string; id: string | null }[]) if (r.id) named.set(r.name, String(r.id).toLowerCase());
    return named;
  }

  async keyAtText(content: string): Promise<{ id: string; clientKey: string | null } | null> {
    const rows = await this.sql`
      SELECT id::text AS id, metadata->>'client_key' AS client_key FROM thoughts
      WHERE content_fingerprint = content_fingerprint_of(${content}::text) LIMIT 1`;
    const r = rows[0] as { id: string; client_key: string | null } | undefined;
    return r ? { id: String(r.id).toLowerCase(), clientKey: r.client_key ?? null } : null;
  }

  async traceProvenance(opts: { id: string; maxDepth?: number; nodeCap?: number }): Promise<ProvenanceNode[]> {
    if (!UUID_RE.test(opts.id)) return [];
    // Migration 025. NULLs pass the function's own defaults (and its clamps).
    const rows = await this.sql`
      SELECT thought_id, depth, parent_id, content, type, source_type, derivation_method, created_at, cycle
      FROM trace_provenance(${opts.id}::uuid, ${opts.maxDepth ?? null}::int, ${opts.nodeCap ?? null}::int)`;
    return rows.map(normaliseProvenanceNode);
  }

  async findDerivatives(opts: { id: string; limit?: number }): Promise<Derivative[]> {
    if (!UUID_RE.test(opts.id)) return [];
    const rows = await this.sql`
      SELECT id, content, type, source_type, derivation_method, created_at
      FROM find_derivatives(${opts.id}::uuid, ${opts.limit ?? null}::int)`;
    return rows.map(normaliseDerivative);
  }

  async listSupersessionProposals(opts: { status?: "pending" | "accepted" | "rejected" | "stale" | null; limit?: number; lineage?: boolean; judgeKey?: string; after?: ProposalPosition }): Promise<ProposalPage> {
    // Migration 029, under 110's seven-argument form. NULL status lists every
    // state, NULL lineage every pair, NULL judge key every pass, a NULL cursor
    // from the top; the function caps the limit after the selection. Seven
    // arguments, always: 029, 070 or 109 re-applied by hand lands its form
    // beside 110's, and a call both forms take (under three arguments beside
    // 029's, four beside 070's, five beside 109's) is then ambiguous (not
    // unique) and fails; seven resolve (preflight's lineage check names the
    // leftover). Its columns by name, never `*`: a migration that adds one to
    // the function leaves this statement's result type as it was, so the
    // connection's prepared plan is re-planned rather than failing 0A000
    // ("cached plan must not change result type") until the server restarts
    // (SMD-3302). The writers' read and thought_changes' name theirs too.
    const a = opts.after;
    let rows: Record<string, unknown>[];
    try {
      rows = await this.sql`
        SELECT id, status, verdict, confidence, reason, similarity, judge_key, judged_at, reviewed_at, review_note, superseding_id,
               older_id, older_content, older_created_at, newer_id, newer_content, newer_created_at, older_edited, newer_edited,
               lineage, page_key, remaining
          FROM list_supersession_proposals(${opts.status === undefined ? "pending" : opts.status}::text, ${opts.limit ?? null}::int, ${opts.lineage ?? null}::boolean, ${opts.judgeKey ?? null}::text,
                                           ${a?.confidence ?? null}::numeric, ${a?.judgedAt ?? null}::timestamptz, ${a?.id ?? null}::uuid)`;
    } catch (e) {
      // list_thoughts' rule (SMD-2995): a time cast that failed is read alone, and only a cursor time Postgres cannot
      // read is the caller's, refused; anything else is the store's fault.
      if (!a || !timeCastFailed(e)) throw e;
      const unread = await this.sql`SELECT ${a.judgedAt}::timestamptz`.then(() => false, (p: unknown) => (timeCastFailed(p) ? true : Promise.reject(p)));
      if (unread) throw new ListCursorRefused();
      throw e;
    }
    // 110: each row's page_key is its place for the next call; remaining counts the selection from this page's first
    // on, so what follows the page is that less the rows listed. Read off the listing as it came back, before a row
    // the writers' read drops (a proposal gone in between): the cursor and the count are the listing's.
    const remaining = rows.length ? Math.max(0, Number(rows[0].remaining) - rows.length) : 0;
    const lastKey = remaining > 0 ? JSON.parse(String(rows[rows.length - 1].page_key)) as string[] : null;
    const next: ProposalPosition | null = lastKey ? { confidence: lastKey[0], judgedAt: lastKey[1], id: lastKey[2] } : null;
    // 094 (SMD-2707): each side's writer, by the page's ids. A brain short of
    // 094 has no such function: the page goes out without writers, and the
    // reply says so.
    let writers: Record<string, unknown>[] = [];
    let read = false;
    if (rows.length) {
      try {
        writers = await this.sql`
          SELECT id, older_actor_name, older_actor_kind, older_trust, older_capture_only, older_superseded_by, older_lapses, older_takes,
                 newer_actor_name, newer_actor_kind, newer_trust, newer_capture_only, newer_superseded_by, newer_lapses, newer_takes,
                 same_capturer
            FROM list_proposal_writers(${this.sql.array(rows.map((r: Record<string, unknown>) => String(r.id)), "UUID")}::uuid[])`;
        read = true;
      } catch (e) {
        if (!WRITERS_MISSING.test((e as Error).message)) throw e;
      }
    }
    // SMD-3338: who decided each accepted or rejected row (114's columns, SMD-2608), by the page's ids as the writers
    // are — the listing (110) is not widened, since 110 re-applied after a wider form fails. Probed, not caught: a
    // brain short of 114 lists its rows as before, the page saying it read none.
    const proposals = withWriters(rows, writers, read).map(normaliseProposal);
    const decided = proposals.filter((p) => p.status === "accepted" || p.status === "rejected").map((p) => p.id);
    const reviewers = await reviewersOf(this.sql, decided);
    // A decided row that records none (a raw call, or a decision before 114 that wrote no pointer) reads null, as an
    // undecided one does: `reviewer` null is "none recorded" to a client (review pass 1 of PR 2).
    if (reviewers !== "no-114") {
      for (const p of proposals) {
        const r = reviewers.get(p.id);
        // An empty name is none, as the reply reads it (pass 2); the agent's id stays out (pass 3, ListedReviewer).
        p.reviewer = r && (r.name || r.agentId) ? { name: r.name, agentRecorded: r.agentId !== null, kind: r.kind, kindNow: r.kindNow } : null;
      }
    }
    return { proposals, next, remaining, reviewersRead: reviewers !== "no-114" };
  }

  async listChanges(f: ChangeFilters): Promise<AuditChange[]> {
    // Migration 052. NULL for an absent bound or filter — the function reads
    // NULL as "no bound" and refuses a time beside a cursor itself. The actions
    // bind through sql.array (the driver has no array-literal form of its own,
    // as supersededAmong says); a null element is refused by the function.
    const rows = await this.sql`
      SELECT id, created_at, action, thought_id, actor_name, actor_kind, origin, source, present, head, changed, metadata_keys,
             supersedes_before, supersedes_after, derivation
        FROM thought_changes(
          ${f.since ?? null}::timestamptz, ${f.after ?? null}::uuid,
          ${f.agent ?? null}::text, ${f.notAgent ?? null}::text,
          ${f.actions ? this.sql.array(f.actions, "TEXT") : null}::text[], ${f.limit}::int)`;
    return rows.map((r: Record<string, unknown>) => normaliseChange(r));
  }

  async supersededAmong(ids: string[]): Promise<Record<string, string>> {
    const valid = idList(ids);
    if (valid.length === 0) return {};
    // For each hit that a newer thought supersedes, the newest such thought.
    // Best-effort: a database without migration 025 has no `supersedes` column,
    // so a failure here must not break the search that called it — the label is
    // an enhancement, and preflight's `provenance` check names the missing 025.
    try {
      const rows = await this.sql`
        SELECT DISTINCT ON (supersedes) supersedes AS old_id, id AS new_id
        FROM thoughts
        WHERE supersedes = ANY(${this.sql.array(valid, "TEXT")}::uuid[])
        ORDER BY supersedes, created_at DESC, id DESC`;
      const out: Record<string, string> = {};
      for (const r of rows) out[String((r as Record<string, unknown>).old_id)] = String((r as Record<string, unknown>).new_id);
      return out;
    } catch {
      return {};
    }
  }

  async ticketStatusInputs(ids: string[], tickets: string[]): Promise<TicketStatusInputs | null> {
    const valid = idList(ids), keys = ticketList(tickets);
    if (keys.length === 0) return normaliseTicketStatusInputs([]);
    // Best-effort, as supersededAmong: before 095, or without the order's
    // ob1_config grant, the label is left off and the search goes on. A row
    // 095 does not return is skipped by the normaliser, which never throws.
    let rows: Record<string, unknown>[];
    try {
      rows = await this.sql`
        SELECT kind, thought_id::text AS thought_id, issue, status, status_type, history
          FROM ticket_status_inputs(${this.sql.array(valid, "TEXT")}::uuid[], ${this.sql.array(keys, "TEXT")}::text[])`;
    } catch (e) {
      // Said once (labelReadFailed): a lock 098 gave up on, a grant, a timeout — not a brain before 095.
      // errno is the SQLSTATE; a client-side failure (refused, closed) carries Bun's code instead, as db/ reads it.
      labelReadFailed(String((e as { errno?: unknown; code?: unknown })?.errno ?? (e as { code?: unknown })?.code ?? ""), (e as Error)?.message ?? String(e));
      return null;
    }
    labelReadOk();
    return normaliseTicketStatusInputs(rows);
  }

  async logSearch(row: QuerySearchLog): Promise<void> {
    // Migration 034. Arrays bind as Postgres arrays and cast to their element
    // type; result_scores may carry nulls, which bind cleanly. filter is an
    // object, never a string (the jsonb rule at the top of this file).
    await this.sql`
      INSERT INTO query_log
        (kind, tool, agent_id, query, match_count, threshold, recency_weight, filter, result_ids, result_scores, arm, tier)
      VALUES
        ('search', ${row.tool}::text, ${row.agentId ?? null}::uuid, ${row.query}::text,
         ${row.matchCount}::int, ${row.threshold}::real, ${row.recencyWeight}::real,
         ${row.filter}::jsonb, ${toUuidArray(row.resultIds)}::uuid[], ${toRealArray(row.resultScores)}::real[],
         ${row.arm ?? null}::text, ${row.tier ?? null}::text)`;
  }

  async logActions(rows: QueryActionLog[]): Promise<void> {
    if (rows.length === 0) return;
    // The batch's contract — absent agent → NULL, every id a uuid, refused by
    // column before the statement — is normaliseActionRows (store.ts). One statement for one row or
    // forty: the tools, agents and targets as aligned arrays, unnested side by
    // side. The tool column binds through the driver's own sql.array (a quote,
    // a backslash, a comma and a brace carried intact — probed); the uuid
    // columns as by-hand literals, because sql.array renders a null element as
    // the text `null` and the agent column is nullable. The one writer of
    // action rows — a single-row VALUES twin was removed so there is one
    // INSERT shape to keep right (SMD-1719, fourth pass).
    const clean = normaliseActionRows(rows);
    // tier is the writing server's OB1_TIER — one server per batch, so it is a
    // scalar across the rows, not a per-row column (SMD-1806).
    const tier = rows[0]?.tier ?? null;
    await this.sql`
      INSERT INTO query_log (kind, tool, agent_id, target_id, tier)
      SELECT 'action', t.tool, t.agent_id, t.target_id, ${tier}::text
        FROM unnest(${this.sql.array(clean.map((r) => r.tool), "TEXT")}::text[],
                    ${toUuidArray(clean.map((r) => r.agentId))}::uuid[],
                    ${toUuidArray(clean.map((r) => r.targetId))}::uuid[]) AS t(tool, agent_id, target_id)`;
  }

  /**
   * The durable backing store for the async job registry (SMD-2318, migration
   * 069's `jobs` table). Timestamps cross as epoch ms (the public shape), so the
   * writes convert to timestamptz with to_timestamp and the read back with
   * extract(epoch …). The upsert freezes a terminal row: `WHERE jobs.ended_at IS
   * NULL` on the conflict path means a late write after the startup reconcile (or
   * any out-of-order arrival the per-record chain did not already serialize)
   * cannot move a finished job back to a live state.
   */
  jobSink(door: string): JobSink {
    const sql = this.sql;
    return {
      async write(row: JobRow): Promise<void> {
        await sql`
          INSERT INTO jobs (id, kind, owner_key_hash, actor, status, progress, result, error, created_at, started_at, ended_at, updated_at, door)
          VALUES (
            ${row.id}::uuid, ${row.kind}, ${row.ownerKeyHash}, ${row.actor}, ${row.status},
            ${row.progress ?? null}::jsonb,
            ${row.result ?? null}::jsonb,
            ${row.error ?? null}::jsonb,
            to_timestamp(${row.createdAt}::double precision / 1000.0),
            to_timestamp(${row.startedAt ?? null}::double precision / 1000.0),
            to_timestamp(${row.endedAt ?? null}::double precision / 1000.0),
            now(),
            ${door}
          )
          ON CONFLICT (id) DO UPDATE SET
            status     = EXCLUDED.status,
            progress   = EXCLUDED.progress,
            result     = EXCLUDED.result,
            error      = EXCLUDED.error,
            started_at = EXCLUDED.started_at,
            ended_at   = EXCLUDED.ended_at,
            updated_at = now()
          WHERE jobs.ended_at IS NULL`;
      },
      async read(ownerKeyHash: string, id: string): Promise<PublicJob | null> {
        // A non-uuid id would throw on the ::uuid cast; the poll answers it as an
        // unknown id (null → the route's 404), not a 500.
        if (!UUID_RE.test(id)) return null;
        const rows = await sql`
          SELECT id, kind, status, actor, progress, result, error,
                 (extract(epoch FROM created_at) * 1000)::bigint AS created_ms,
                 (extract(epoch FROM started_at) * 1000)::bigint AS started_ms,
                 (extract(epoch FROM ended_at)   * 1000)::bigint AS ended_ms
            FROM jobs
           WHERE id = ${id}::uuid AND owner_key_hash = ${ownerKeyHash}`;
        const r = rows[0];
        if (!r) return null;
        return {
          jobId: String(r.id),
          kind: String(r.kind),
          status: String(r.status) as JobStatus,
          actor: String(r.actor),
          createdAt: Number(r.created_ms),
          ...(r.started_ms != null ? { startedAt: Number(r.started_ms) } : {}),
          ...(r.ended_ms != null ? { endedAt: Number(r.ended_ms) } : {}),
          ...(r.progress != null ? { progress: r.progress as JobProgress } : {}),
          ...(r.result != null ? { result: r.result } : {}),
          ...(r.error != null ? { error: r.error as { message: string; code?: string } } : {}),
        };
      },
      async reconcileRunningLost(): Promise<number> {
        const rows = await sql`
          UPDATE jobs
             SET status     = 'lost',
                 ended_at   = now(),
                 updated_at = now(),
                 error      = ${{ message: "the server restarted before the job finished; re-run it (a detached run does not survive a restart)", code: "SERVER_RESTARTED" }}::jsonb
           WHERE status IN ('pending', 'running')
             AND door = ${door}
          RETURNING id`;
        return rows.length;
      },
    };
  }

  /**
   * A plugin's transaction (SMD-2310), on a connection logged in as the
   * plugin's own login role (db/config.mjs's pluginIdents, SMD-2756), then
   * SET LOCAL ROLE to the plugin's role with its schema first on the path, as
   * the migrator made them: its tables are named bare, and the core's are
   * Postgres's to refuse. SQL that undoes the role lands on the login role,
   * which holds nothing on the core either, and may SET ROLE to its own
   * plugin's role alone, so no other plugin's tables — the boundary is
   * Postgres's, not the code's good behaviour (review pass 1 of PR 3). The
   * plugin is handed a tagged template alone: no unsafe(), no second
   * transaction.
   */
  pluginTx<T>(plugin: string, fn: (sql: PluginSql) => Promise<T>): Promise<T> {
    if (!PLUGIN_NAME_RE.test(plugin) || plugin.length > 32) return Promise.reject(new Error(`${JSON.stringify(plugin)} is not a plugin name`));
    const { schema, role, login } = pluginIdents(plugin);
    if (!this.pluginPassword) return Promise.reject(new Error(`a plugin's tables need OB1_PLUGIN_DB_PASSWORD, the secret the password of ${login}, the login role the migrator made, is derived from`));
    let pool = this.pluginPools.get(plugin);
    if (!pool) {
      let loginUrl: string;
      try {
        loginUrl = pluginLoginUrl(this.url, plugin, this.pluginPassword);
      } catch (e) {
        return Promise.reject(e);
      }
      pool = new SQL({ url: loginUrl, max: PLUGIN_POOL_SIZE });
      this.pluginPools.set(plugin, pool);
    }
    return pool.begin(async (tx: SQL) => {
      // The pool's own login, once: plugin SQL never runs on the server's role (PR 3 review pass 2).
      if (!this.pluginLogins.has(plugin)) {
        const [{ who }] = (await tx`SELECT session_user AS who`) as { who: string }[];
        if (who !== login) throw new Error(`plugin ${plugin}'s pool logged in as ${who}, not ${login}`);
        this.pluginLogins.add(plugin);
      }
      // No role: a plugin with no migrations, or one the migrator has not run
      // for — said as that, not as Postgres's bare "does not exist".
      await tx.unsafe(`SET LOCAL ROLE ${quoteIdent(role)}`).catch((e: Error) => {
        throw /does not exist/.test(e.message)
          ? new Error(`plugin ${plugin} has no role ${role}: ctx.db reaches the tables its migrations make (plugins/${plugin}/migrations/), and the migrator makes the role when it applies them`)
          : e;
      });
      await tx.unsafe(`SET LOCAL search_path TO ${quoteIdent(schema)}, public`);
      // A template's own strings array alone: frozen, with its frozen raw
      // twin — an array built at run time is text, not a template.
      const query: PluginSql = (strings, ...values) => {
        if (!Object.isFrozen(strings) || !Array.isArray(strings.raw) || !Object.isFrozen(strings.raw)) throw new Error("ctx.db's sql is a tagged template: sql`…`");
        return tx(strings, ...values) as never;
      };
      return fn(query);
    }).catch((e: Error) => {
      // A pool that never logged in, refused its login: a plugin with no
      // migrations, or one the migrator has not run for, has no login role
      // (SMD-2756) — said as that, not as Postgres's bare refusal, which says
      // the same for a role made under another secret.
      throw !this.pluginLogins.has(plugin) && /password authentication failed|role ".*" does not exist/.test(e.message)
        ? new Error(`plugin ${plugin} cannot log in as ${login}: ctx.db reaches the tables its migrations make (plugins/${plugin}/migrations/), and the migrator makes the role, its password derived from OB1_PLUGIN_DB_PASSWORD, when it applies them — or the role was made under another secret (${e.message})`)
        : e;
    }) as Promise<T>;
  }

  async close(): Promise<void> {
    await Promise.all([this.sql.close(), ...(this.lockSql ? [this.lockSql.close()] : []), ...[...this.pluginPools.values()].map((pool) => pool.close())]);
  }
}
