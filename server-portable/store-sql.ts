/**
 * store-sql.ts — direct SQL. No PostgREST, no supabase-js.
 *
 * Phase 2 of the migration: the layer the plan calls "the real cost". Uses Bun's
 * built-in Postgres client, so it adds no driver dependency.
 *
 * ── Behaviour must not change ────────────────────────────────────────────────
 * Every query here reproduces what the PostgREST store asked for, including two
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
 *
 * ── Not for Cloudflare Workers ───────────────────────────────────────────────
 * Workers cannot hold a connection pool. This module is imported dynamically by
 * store.ts precisely so a Workers build never pulls it in.
 */

import { SQL } from "bun";
import type { JobSink, JobRow, PublicJob, JobStatus, JobProgress } from "./jobs.ts";
import { readDatabaseFacts, type DatabaseFacts, type ReadOptions, type ReadProgress } from "./brain-info.ts";
import { RESOLVE_LOCK_TIMEOUT_MS } from "./agents.ts";
import type { Lineage } from "./lineage.ts";
import { actorPayload, captureEnvelope, isoTimestampOrNull, normaliseActionRows, normaliseAgentResolution, normaliseChange, normaliseDerivative, normaliseHybridRow, normaliseKeywordRow, normaliseListItem, normaliseMatchRow, normaliseMutation, normaliseProposal, normaliseProvenanceNode, normaliseThoughtMeta, normaliseThoughtRecord, provenanceEnvelope, RECENCY_DEFAULTS, UUID_RE, idList } from "./store.ts";
import type {
  Actor,
  AgentResolution,
  AuditChange,
  CaptureResult,
  ChangeFilters,
  Derivative,
  ListFilters,
  DeleteResult,
  ProvenanceNode,
  QueryActionLog,
  QuerySearchLog,
  SupersessionProposal,
  ThoughtHybridMatch,
  ThoughtKeywordMatch,
  LoggedSearchPage,
  WorkerStatusRow,
  RetryFailedResult,
  ReleaseLeasesOpts,
  ReleaseLeasesResult,
  DryRunClaimResult,
  ThoughtIdPage,
  ThoughtListItem,
  ThoughtMatch,
  RecencyOpts,
  ThoughtMeta,
  ThoughtStats,
  ThoughtRecord,
  ThoughtStore,
  UpdateProvenance,
  UpdateResult,
  WriteEvent,
} from "./store.ts";

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

export class SqlStore implements ThoughtStore {
  readonly kind = "sql" as const;
  private sql: SQL;

  constructor(url: string, opts: { max?: number } = {}) {
    // A bounded pool. PostgREST was stateless HTTP, so nothing upstream limits
    // concurrency for us any more — an unbounded pool would let a burst of
    // captures exhaust the server's connection slots.
    this.sql = new SQL({ url, max: opts.max ?? poolSizeFrom(process.env.OB1_PG_POOL) });
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
    embedding: number[];
    threshold: number;
    limit: number;
    filter: Record<string, unknown>;
    preferCurrent?: boolean;
    minTrust?: string;
  } & RecencyOpts): Promise<ThoughtHybridMatch[]> {
    // The function extracts the needles and does the fusion, so neither store
    // has a copy of either rule to get out of step — the same reason the two
    // methods above call their functions rather than inlining them. Under
    // prefer_current the demotion is 059's function's too (SMD-2255); a tagged
    // template cannot bind a function name, so the two calls are two literals.
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
            ${toVector(opts.embedding)}::vector,
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
            ${toVector(opts.embedding)}::vector,
            ${opts.query}::text,
            ${opts.threshold}::float,
            ${opts.limit}::int,
            ${opts.filter}::jsonb,
            ${weight}::float,
            ${halfLife}::float
          )`;
    return rows.map((r: Record<string, unknown>) => normaliseHybridRow(r));
  }

  /** hybridThoughts with min_trust: 075's 8-argument forms, the same columns as the 7's. */
  private async hybridAtTrust(opts: { query: string; embedding: number[]; threshold: number; limit: number; filter: Record<string, unknown>; preferCurrent?: boolean }, weight: number, halfLife: number, minTrust: string): Promise<ThoughtHybridMatch[]> {
    const rows = opts.preferCurrent === true
      ? await this.sql`
          SELECT id, content, metadata, created_at, similarity,
                 matched_needles, needles, needle_counts, common_needles, literal_only, score,
                 fused, demoted, window_rows, window_known, window_demoted, window_synced_at, window_exact
          FROM search_thoughts_current(
            ${toVector(opts.embedding)}::vector,
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
            ${toVector(opts.embedding)}::vector,
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

  async listThoughts(f: ListFilters): Promise<ThoughtListItem[]> {
    // PostgREST's .contains() is jsonb containment, `@>`. Reproduced exactly.
    // Undefined filters are passed as NULL and short-circuited in SQL, which keeps
    // this a single prepared statement instead of a concatenated query.
    const since = f.days ? new Date(Date.now() - f.days * 86_400_000).toISOString() : null;
    // The ladder's words (SMD-1724) as an array literal, toUuidArray's way: Bun
    // binds a JS array comma-joined, without braces. Enum words, no quoting.
    const trustIn = f.trustIn ? `{${f.trustIn.join(",")}}` : null;

    const rows = await this.sql`
      SELECT id, content, metadata, created_at
      FROM thoughts
      WHERE (${f.type ?? null}::text  IS NULL OR metadata @> jsonb_build_object('type', ${f.type ?? null}::text))
        AND (${f.topic ?? null}::text IS NULL OR metadata @> jsonb_build_object('topics', jsonb_build_array(${f.topic ?? null}::text)))
        AND (${f.person ?? null}::text IS NULL OR metadata @> jsonb_build_object('people', jsonb_build_array(${f.person ?? null}::text)))
        AND (${f.saidBy ?? null}::text IS NULL OR metadata @> jsonb_build_object('actor_kind', ${f.saidBy ?? null}::text))
        AND (${f.actor?.trim() || null}::text IS NULL OR metadata @> jsonb_build_object('actor_name', ${f.actor?.trim() || null}::text))
        AND (${trustIn}::text[] IS NULL OR metadata->>'trust' = ANY(${trustIn}::text[]))
        AND (${since}::timestamptz IS NULL OR created_at >= ${since}::timestamptz)
      ORDER BY created_at DESC
      LIMIT ${f.limit}::int`;

    return rows.map(normaliseListItem);
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

  async listLoggedSearches(opts: { since: string | null; limit: number }): Promise<LoggedSearchPage> {
    // The search rows of query_log (migration 034), most recent first, windowed by
    // `since`. One extra row over the limit tells the caller more matched without a
    // count query. query_log is opt-in (OB1_QUERY_LOG); when it was never on this
    // is simply empty.
    // "" is not a time: normalise it to null (no window) rather than cast it and
    // fail, so a direct caller matches the PostgREST store, which treats it as falsy.
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
    // The active pools, from ob1_config: the extraction key verbatim, and the reembed
    // key built from the recorded embedding model and dim. consolidate records no key,
    // so its work_types report active: null rather than a false negative.
    const cfg = Object.fromEntries(
      (await this.sql`SELECT key, value FROM ob1_config WHERE key IN ('entity_extraction_key', 'embedding_model', 'embedding_dim')`)
        .map((r: { key: string; value: string }) => [r.key, r.value]),
    ) as Record<string, string | undefined>;
    const reembedKey = cfg.embedding_model && cfg.embedding_dim ? `reembed:${cfg.embedding_model}@${cfg.embedding_dim}` : null;
    const activeOf = (wt: string): boolean | null => {
      if (wt === cfg.entity_extraction_key) return true;
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
    // and the tool never prints a truncation note on this path. (The PostgREST
    // store still walks and can truncate; that is the divergence the interface
    // documents.) jsonb comes back from Bun.sql already parsed into JS values.
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
    // Note what is NOT here: the 1000-row cap. That was a PostgREST default, not a
    // Postgres one. The paging loop upstream of this call is still correct and
    // still worth keeping — it bounds memory and lets the tool report truncation —
    // but the silent ceiling it was written to work around does not exist in SQL.
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
     * the call means the SQL and PostgREST stores use one mechanism — an
     * earlier version wrapped this in a transaction and left PostgREST
     * unattributed.
     */
    // The model rides the same way (021): upsert_thought writes
    // p_payload.embedding_model beside the vector, and an envelope without the
    // key leaves the row's label unknown.
    // 025: derived_from / supersedes ride it too; upsert_thought validates
    // derived_from and refuses a bad one — see store.ts's captureEnvelope.
    // 061: the lineage envelope — the windows' and the tags' recipes — rides
    // the same way, and upsert_thought records them with the write.
    const envelope = captureEnvelope(opts.payload, opts.actor, opts.embeddingModel,
      { derivedFrom: opts.derivedFrom, supersedes: opts.supersedes }, opts.lineage, opts.event);

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

    const r = rows[0]?.r as { id?: string; existed?: unknown; supersedes?: unknown } | undefined;
    const id = r?.id;
    if (!id) throw new Error("upsert_thought returned no id.");
    // 035: `existed` says the text was already there and the envelope's
    // provenance was not written. Passed on only when the body said (a
    // database before 035 returns none, and a guess would be a lie).
    return { id, ...(typeof r?.existed === "boolean" ? { existed: r.existed, supersedes: typeof r.supersedes === "string" ? r.supersedes : null } : {}) };
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
    // spelling it keeps the call one signature on both stores.
    const rows = await this.sql`
      SELECT delete_thought(${opts.id}::uuid, ${actorPayload(opts.actor)}::jsonb, ${opts.detach === true}::boolean) AS r`;
    return normaliseMutation(rows[0]?.r as Record<string, unknown>);
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

  async existingIds(ids: string[]): Promise<Set<string>> {
    const valid = idList(ids);
    if (valid.length === 0) return new Set();
    const rows = await this.sql`SELECT id::text AS id FROM thoughts WHERE id = ANY(${this.sql.array(valid, "TEXT")}::uuid[])`;
    return new Set((rows as { id: string }[]).map((r) => String(r.id).toLowerCase()));
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

  async listSupersessionProposals(opts: { status?: "pending" | "accepted" | "rejected" | "stale" | null; limit?: number; lineage?: boolean }): Promise<SupersessionProposal[]> {
    // Migration 029, under 070's three-argument form. NULL status lists every
    // state, NULL lineage every pair; the function caps the limit. Three
    // arguments, always: 029 re-applied by hand lands its two-argument form
    // beside 070's, and a call short of three is then ambiguous (not unique)
    // and fails; three resolve (preflight's lineage check names the leftover).
    const rows = await this.sql`
      SELECT * FROM list_supersession_proposals(${opts.status === undefined ? "pending" : opts.status}::text, ${opts.limit ?? null}::int, ${opts.lineage ?? null}::boolean)`;
    return rows.map((r: Record<string, unknown>) => normaliseProposal(r));
  }

  async listChanges(f: ChangeFilters): Promise<AuditChange[]> {
    // Migration 052. NULL for an absent bound or filter — the function reads
    // NULL as "no bound" and refuses a time beside a cursor itself. The actions
    // bind through sql.array (the driver has no array-literal form of its own,
    // as supersededAmong says); a null element is refused by the function.
    const rows = await this.sql`
      SELECT * FROM thought_changes(
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
    // column before the statement — is normaliseActionRows (store.ts), the
    // same call the PostgREST writer makes. One statement for one row or
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
  jobSink(): JobSink {
    const sql = this.sql;
    return {
      async write(row: JobRow): Promise<void> {
        await sql`
          INSERT INTO jobs (id, kind, owner_key_hash, actor, status, progress, result, error, created_at, started_at, ended_at, updated_at)
          VALUES (
            ${row.id}::uuid, ${row.kind}, ${row.ownerKeyHash}, ${row.actor}, ${row.status},
            ${row.progress ?? null}::jsonb,
            ${row.result ?? null}::jsonb,
            ${row.error ?? null}::jsonb,
            to_timestamp(${row.createdAt}::double precision / 1000.0),
            to_timestamp(${row.startedAt ?? null}::double precision / 1000.0),
            to_timestamp(${row.endedAt ?? null}::double precision / 1000.0),
            now()
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
          RETURNING id`;
        return rows.length;
      },
    };
  }

  async close(): Promise<void> {
    await this.sql.close();
  }
}
