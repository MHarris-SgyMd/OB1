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
import { actorPayload, normaliseAgentResolution, normaliseMutation } from "./store.ts";
import type {
  Actor,
  AgentResolution,
  CaptureResult,
  ListFilters,
  MutationError,
  MutationResult,
  ThoughtKeywordMatch,
  ThoughtListItem,
  ThoughtMatch,
  ThoughtMeta,
  ThoughtRecord,
  ThoughtStore,
  UpdateResult,
} from "./store.ts";

/** pgvector accepts a bracketed list; a JS number[] does not bind as a vector. */
function toVector(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}

export class SqlStore implements ThoughtStore {
  readonly kind = "sql" as const;
  private sql: SQL;

  constructor(url: string, opts: { max?: number } = {}) {
    // A bounded pool. PostgREST was stateless HTTP, so nothing upstream limits
    // concurrency for us any more — an unbounded pool would let a burst of
    // captures exhaust the server's connection slots.
    this.sql = new SQL({ url, max: opts.max ?? Number(process.env.OB1_PG_POOL ?? 10) });
  }

  async matchThoughts(opts: {
    embedding: number[];
    threshold: number;
    limit: number;
    filter: Record<string, unknown>;
  }): Promise<ThoughtMatch[]> {
    // Call the stored function rather than inlining the ranking, so the strict
    // threshold comparison and the ordering stay defined in exactly one place.
    const rows = await this.sql`
      SELECT id, content, metadata, similarity, created_at
      FROM match_thoughts(
        ${toVector(opts.embedding)}::vector,
        ${opts.threshold}::float,
        ${opts.limit}::int,
        ${opts.filter}::jsonb
      )`;
    return rows.map((r: Record<string, unknown>) => ({
      id: String(r.id),
      content: String(r.content),
      metadata: (r.metadata ?? {}) as Record<string, unknown>,
      similarity: Number(r.similarity),
      created_at: new Date(r.created_at as string).toISOString(),
    }));
  }

  async keywordThoughts(opts: {
    query: string;
    limit: number;
    offset: number;
    filter: Record<string, unknown>;
  }): Promise<ThoughtKeywordMatch[]> {
    // Call the function rather than inlining the ILIKE, for the same reason
    // matchThoughts calls match_thoughts: the wildcard escaping and the stable
    // ORDER BY are correctness, and two copies of them is one copy too many.
    const rows = await this.sql`
      SELECT id, content, metadata, created_at, occurrences, total_count
      FROM search_thoughts_keyword(
        ${opts.query}::text,
        ${opts.limit}::int,
        ${opts.offset}::int,
        ${opts.filter}::jsonb
      )`;
    return rows.map((r: Record<string, unknown>) => ({
      id: String(r.id),
      content: String(r.content),
      metadata: (r.metadata ?? {}) as Record<string, unknown>,
      created_at: new Date(r.created_at as string).toISOString(),
      occurrences: Number(r.occurrences),
      // bigint. Bun hands it back as a string, and Number(undefined) is NaN, so
      // the fallback is 0 rather than a quiet NaN in the caller's "N of M".
      totalCount: Number(r.total_count ?? 0),
    }));
  }

  async getThought(id: string): Promise<ThoughtRecord | null> {
    // `id` is a uuid column, so a malformed value is a cast error rather than a
    // not-found. Treat it as not-found: an MCP client passing a bad id should get
    // a clean answer, not a Postgres error string.
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return null;

    const rows = await this.sql`
      SELECT id, content, metadata, created_at, updated_at
      FROM thoughts WHERE id = ${id}::uuid LIMIT 1`;
    if (rows.length === 0) return null;
    const r = rows[0];
    return {
      id: String(r.id),
      content: String(r.content),
      metadata: (r.metadata ?? {}) as Record<string, unknown>,
      created_at: new Date(r.created_at).toISOString(),
      updated_at: r.updated_at ? new Date(r.updated_at).toISOString() : null,
    };
  }

  async listThoughts(f: ListFilters): Promise<ThoughtListItem[]> {
    // PostgREST's .contains() is jsonb containment, `@>`. Reproduced exactly.
    // Undefined filters are passed as NULL and short-circuited in SQL, which keeps
    // this a single prepared statement instead of a concatenated query.
    const since = f.days ? new Date(Date.now() - f.days * 86_400_000).toISOString() : null;

    const rows = await this.sql`
      SELECT content, metadata, created_at
      FROM thoughts
      WHERE (${f.type ?? null}::text  IS NULL OR metadata @> jsonb_build_object('type', ${f.type ?? null}::text))
        AND (${f.topic ?? null}::text IS NULL OR metadata @> jsonb_build_object('topics', jsonb_build_array(${f.topic ?? null}::text)))
        AND (${f.person ?? null}::text IS NULL OR metadata @> jsonb_build_object('people', jsonb_build_array(${f.person ?? null}::text)))
        AND (${since}::timestamptz IS NULL OR created_at >= ${since}::timestamptz)
      ORDER BY created_at DESC
      LIMIT ${f.limit}::int`;

    return rows.map((r: Record<string, unknown>) => ({
      content: String(r.content),
      metadata: (r.metadata ?? {}) as Record<string, unknown>,
      created_at: new Date(r.created_at as string).toISOString(),
    }));
  }

  async countThoughts(): Promise<number> {
    const rows = await this.sql`SELECT count(*)::int AS c FROM thoughts`;
    return Number(rows[0].c);
  }

  async pageThoughtMeta(offset: number, limit: number): Promise<ThoughtMeta[]> {
    // Note what is NOT here: the 1000-row cap. That was a PostgREST default, not a
    // Postgres one. The paging loop upstream of this call is still correct and
    // still worth keeping — it bounds memory and lets the tool report truncation —
    // but the silent ceiling it was written to work around does not exist in SQL.
    const rows = await this.sql`
      SELECT metadata, created_at
      FROM thoughts
      ORDER BY created_at DESC
      LIMIT ${limit}::int OFFSET ${offset}::int`;
    return rows.map((r: Record<string, unknown>) => ({
      metadata: (r.metadata ?? {}) as Record<string, unknown>,
      created_at: new Date(r.created_at as string).toISOString(),
    }));
  }

  async captureThought(opts: {
    content: string;
    payload: { metadata: Record<string, unknown> };
    embedding: number[];
    chunks?: { content: string; embedding: number[]; context?: string }[];
    actor?: Actor;
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
    const envelope = opts.actor ? { ...opts.payload, actor: actorPayload(opts.actor) } : opts.payload;

    const rows = chunks.length
      ? await this.sql`
          SELECT upsert_thought(
            ${opts.content}::text,
            ${envelope}::jsonb,
            ${toVector(opts.embedding)}::vector,
            ${chunks.map((c) => ({ content: c.content, embedding: toVector(c.embedding), context: c.context ?? null }))}::jsonb
          ) AS r`
      : await this.sql`
          SELECT upsert_thought(
            ${opts.content}::text,
            ${envelope}::jsonb,
            ${toVector(opts.embedding)}::vector
          ) AS r`;

    const id = (rows[0]?.r as { id?: string } | undefined)?.id;
    if (!id) throw new Error("upsert_thought returned no id.");
    return { id };
  }

  async updateThought(opts: {
    id: string;
    content?: string;
    metadataPatch?: Record<string, unknown>;
    embedding?: number[];
    chunks?: { content: string; embedding: number[]; context?: string }[];
    ifUnchangedSince?: string;
    actor?: Actor;
  }): Promise<UpdateResult> {
    const chunks = (opts.chunks ?? []).map((c) => ({
      content: c.content,
      embedding: toVector(c.embedding),
      context: c.context ?? null,
    }));
    const rows = await this.sql`
      SELECT update_thought(
        ${opts.id}::uuid,
        ${opts.content ?? null}::text,
        ${opts.metadataPatch ?? null}::jsonb,
        ${opts.embedding ? toVector(opts.embedding) : null}::vector,
        ${chunks.length ? chunks : null}::jsonb,
        ${opts.ifUnchangedSince ?? null}::timestamptz,
        ${actorPayload(opts.actor)}::jsonb
      ) AS r`;
    return normaliseMutation(rows[0]?.r as Record<string, unknown>);
  }

  async deleteThought(opts: {
    id: string;
    actor?: Actor;
  }): Promise<MutationResult> {
    const rows = await this.sql`
      SELECT delete_thought(${opts.id}::uuid, ${actorPayload(opts.actor)}::jsonb) AS r`;
    return normaliseMutation(rows[0]?.r as Record<string, unknown>);
  }

  async resolveAgent(opts: { keyHash: string; label: string; scope?: string }): Promise<AgentResolution> {
    const rows = await this.sql`
      SELECT resolve_agent(${opts.keyHash}::text, ${opts.label}::text, ${opts.scope ?? null}::text) AS r`;
    return normaliseAgentResolution(rows[0]?.r);
  }

  async close(): Promise<void> {
    await this.sql.close();
  }
}
