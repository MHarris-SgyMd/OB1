/**
 * store-postgrest.ts — the existing behaviour, behind the store interface.
 *
 * This is `supabase-js` talking to PostgREST over HTTP. It is unchanged in
 * substance from the original inline calls; only the error handling moved, from
 * returning `{ data, error }` tuples to throwing, so both stores present one shape
 * to the tools.
 *
 * Works anywhere fetch works, including Cloudflare Workers — which is why it stays
 * the default and why it is still worth keeping after the SQL store exists.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { actorPayload, captureEnvelope, normaliseAgentResolution, normaliseDerivative, normaliseHybridRow, normaliseKeywordRow, normaliseListItem, normaliseMatchRow, normaliseMutation, normaliseProvenanceNode, normaliseThoughtMeta, normaliseThoughtRecord, RECENCY_DEFAULTS, UUID_RE } from "./store.ts";
import type {
  Actor,
  AgentResolution,
  CaptureResult,
  Derivative,
  ListFilters,
  MutationError,
  MutationResult,
  ProvenanceNode,
  ThoughtHybridMatch,
  ThoughtKeywordMatch,
  ThoughtListItem,
  ThoughtMatch,
  RecencyOpts,
  ThoughtMeta,
  ThoughtStats,
  ThoughtRecord,
  ThoughtStore,
  UpdateResult,
} from "./store.ts";

// thought_stats aggregation for the PostgREST path. PostgREST returns at most
// 1000 rows per select and cannot aggregate server-side, so stats must page
// explicitly and tally in memory or they silently describe only the newest
// page. STATS_MAX_ROWS bounds the work — the Workers/Edge runtime this store
// serves has a wall-clock budget a very large brain could exhaust — and hitting
// it is reported, never hidden. The SQL store has none of this: migration 024
// does the whole corpus in one statement (see store-sql.ts). Moved here from the
// tool in SMD-1249, so the cap lives with the only path that still needs it.
const STATS_PAGE_SIZE = 1000;
const STATS_MAX_ROWS = 100_000;

export class PostgrestStore implements ThoughtStore {
  readonly kind = "postgrest" as const;
  private client: SupabaseClient;

  /**
   * `client` is a seam for tests. Production passes a URL and key and gets a real
   * supabase-js client; the suite passes the compat/supabase-sql shim, which
   * speaks the same surface over a real Postgres. Without it this class could only
   * be exercised against a live PostgREST, which is why its RPC argument shapes
   * went unverified until chunking added a fourth one.
   */
  constructor(url: string, serviceKey: string, client?: SupabaseClient) {
    this.client = client ?? createClient(url, serviceKey);
  }

  async matchThoughts(opts: {
    embedding: number[];
    threshold: number;
    limit: number;
    filter: Record<string, unknown>;
  } & RecencyOpts): Promise<ThoughtMatch[]> {
    // All six named arguments, always — store.ts's RecencyOpts says why.
    const { data, error } = await this.client.rpc("match_thoughts", {
      query_embedding: opts.embedding,
      match_threshold: opts.threshold,
      match_count: opts.limit,
      filter: opts.filter,
      recency_weight: opts.recencyWeight ?? RECENCY_DEFAULTS.weight,
      half_life_days: opts.halfLifeDays ?? RECENCY_DEFAULTS.halfLifeDays,
    });
    if (error) throw new Error(error.message);
    // Every row this store returns goes through store.ts's normalisers, never a
    // cast: PostgREST hands back the function's own column names and its own
    // timestamp form (store.ts:isoTimestamp says which). SMD-1040.
    return ((data ?? []) as Record<string, unknown>[]).map(normaliseMatchRow);
  }

  async keywordThoughts(opts: {
    query: string;
    limit: number;
    offset: number;
    filter: Record<string, unknown>;
  }): Promise<ThoughtKeywordMatch[]> {
    const { data, error } = await this.client.rpc("search_thoughts_keyword", {
      p_query: opts.query,
      p_limit: opts.limit,
      p_offset: opts.offset,
      p_filter: opts.filter,
    });
    if (error) throw new Error(error.message);
    return ((data ?? []) as Record<string, unknown>[]).map(normaliseKeywordRow);
  }

  async hybridThoughts(opts: {
    query: string;
    embedding: number[];
    threshold: number;
    limit: number;
    filter: Record<string, unknown>;
  } & RecencyOpts): Promise<ThoughtHybridMatch[]> {
    const { data, error } = await this.client.rpc("search_thoughts_hybrid", {
      query_embedding: opts.embedding,
      query_text: opts.query,
      match_threshold: opts.threshold,
      match_count: opts.limit,
      filter: opts.filter,
      recency_weight: opts.recencyWeight ?? RECENCY_DEFAULTS.weight,
      half_life_days: opts.halfLifeDays ?? RECENCY_DEFAULTS.halfLifeDays,
    });
    if (error) throw new Error(error.message);
    return ((data ?? []) as Record<string, unknown>[]).map(normaliseHybridRow);
  }

  async getThought(id: string): Promise<ThoughtRecord | null> {
    // As the SQL store: a malformed id is "not found", not a uuid cast error
    // surfaced through `fetch` on one store and null on the other.
    if (!UUID_RE.test(id)) return null;
    const { data, error } = await this.client
      .from("thoughts")
      .select("id, content, metadata, created_at, updated_at")
      .eq("id", id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data == null ? null : normaliseThoughtRecord(data as Record<string, unknown>);
  }

  async listThoughts(f: ListFilters): Promise<ThoughtListItem[]> {
    let q = this.client
      .from("thoughts")
      .select("id, content, metadata, created_at")
      .order("created_at", { ascending: false })
      .limit(f.limit);

    if (f.type) q = q.contains("metadata", { type: f.type });
    if (f.topic) q = q.contains("metadata", { topics: [f.topic] });
    if (f.person) q = q.contains("metadata", { people: [f.person] });
    if (f.days) {
      const since = new Date();
      since.setDate(since.getDate() - f.days);
      q = q.gte("created_at", since.toISOString());
    }

    const { data, error } = await q;
    if (error) throw new Error(error.message);
    return ((data ?? []) as Record<string, unknown>[]).map(normaliseListItem);
  }

  async countThoughts(): Promise<number> {
    const { count, error } = await this.client
      .from("thoughts")
      .select("*", { count: "exact", head: true });
    if (error) throw new Error(error.message);
    return count ?? 0;
  }

  async pageThoughtMeta(offset: number, limit: number): Promise<ThoughtMeta[]> {
    const { data, error } = await this.client
      .from("thoughts")
      .select("metadata, created_at")
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);
    if (error) throw new Error(error.message);
    return ((data ?? []) as Record<string, unknown>[]).map(normaliseThoughtMeta);
  }

  async statsSummary(): Promise<ThoughtStats> {
    // `count` is the whole corpus; the walk below tallies the breakdowns. Page
    // explicitly and tally as we go so we never hold the corpus in memory, and
    // stop at STATS_MAX_ROWS so a very large brain cannot exhaust the runtime's
    // time budget. When the cap stops the walk short, `aggregated < total` and
    // the tool says the breakdowns are partial rather than under-reporting them
    // silently. `total` and this walk are separate reads (as the tool's were
    // before SMD-1249), so the note is best-effort under concurrent writes over
    // the walk's window, not transactional. (This is the pre-SMD-1249 tool logic,
    // moved into the store that still needs it, with one addition: a JSON null
    // inside a topics/people array is skipped, so for well-formed metadata this
    // store and migration 024's function — which drops it with WHERE ... IS NOT
    // NULL — render the same top-10 breakdowns. Without the guard the walk would
    // coerce null to a literal "null" key. Degenerate non-string metadata is not
    // guaranteed to match the SQL path; see store.ts:ThoughtStats.)
    const total = await this.countThoughts();
    const types: Record<string, number> = {};
    const topics: Record<string, number> = {};
    const people: Record<string, number> = {};

    let aggregated = 0;
    let newest: string | null = null;
    let oldest: string | null = null;

    for (let offset = 0; offset < STATS_MAX_ROWS; offset += STATS_PAGE_SIZE) {
      const page = await this.pageThoughtMeta(offset, STATS_PAGE_SIZE);
      if (page.length === 0) break;

      for (const r of page) {
        const m = (r.metadata || {}) as Record<string, unknown>;
        if (m.type) types[m.type as string] = (types[m.type as string] || 0) + 1;
        if (Array.isArray(m.topics))
          for (const t of m.topics) if (t != null) topics[t as string] = (topics[t as string] || 0) + 1;
        if (Array.isArray(m.people))
          for (const p of m.people) if (p != null) people[p as string] = (people[p as string] || 0) + 1;
        // Ordered newest-first, so the first dated row of the first page is the
        // newest overall and the last dated row of the final page is the
        // oldest. A NULL created_at sorts first under DESC and is skipped, as
        // 024's min/max skip it on the SQL store (see store.ts:ThoughtMeta).
        if (r.created_at !== null) {
          if (newest === null) newest = r.created_at;
          oldest = r.created_at;
        }
      }
      aggregated += page.length;

      if (page.length < STATS_PAGE_SIZE) break; // short page — corpus exhausted
    }

    return { total, oldest, newest, types, topics, people, aggregated };
  }

  async captureThought(opts: {
    content: string;
    payload: { metadata: Record<string, unknown> };
    embedding: number[];
    chunks?: { content: string; embedding: number[]; context?: string }[];
    actor?: Actor;
    embeddingModel?: string;
    derivedFrom?: string[];
    supersedes?: string;
  }): Promise<CaptureResult> {
    // Preferred: content, metadata and embedding in one statement, so a failure
    // cannot leave a committed row with a NULL embedding — stored but invisible
    // to every semantic search. Requires db/migrations/004.
    // With chunks, the 4-arg overload from migration 007; without, the 3-arg form
    // exactly as before. Passing p_chunks unconditionally would make every
    // deployment that has not applied 007 fall through to the two-step path.
    const chunks = opts.chunks ?? [];
    // The actor rides in the payload envelope — migration 008's upsert_thought
    // reads it into the ob1.actor setting so the audit trigger can attribute
    // this write. Without it, every audit row on this store would have recorded
    // a NULL actor: present, plausible, and wrong.
    // The model rides the same way (021); an envelope without the key leaves
    // the row's label unknown.
    // 025: derived_from / supersedes ride it too, validated by upsert_thought.
    const envelope = captureEnvelope(opts.payload, opts.actor, opts.embeddingModel,
      { derivedFrom: opts.derivedFrom, supersedes: opts.supersedes });

    const { data: atomic, error: atomicError } = await this.client.rpc("upsert_thought", {
      p_content: opts.content,
      p_payload: envelope,
      p_embedding: opts.embedding,
      ...(chunks.length
        ? { p_chunks: chunks.map((c) => ({ content: c.content, embedding: `[${c.embedding.join(",")}]`, context: c.context ?? null })) }
        : {}),
    });

    // PGRST202 = no function with that name and argument list.
    const missing =
      atomicError &&
      (atomicError.code === "PGRST202" ||
        /Could not find the function/i.test(atomicError.message ?? ""));

    if (atomicError && !missing) throw new Error(atomicError.message);

    if (!missing) {
      const id = (atomic as { id?: string } | null)?.id;
      if (!id) throw new Error("upsert_thought returned no id.");
      return { id };
    }

    console.warn(
      "capture_thought: 3-arg upsert_thought not found — falling back to the " +
        "non-atomic two-step write. Apply db/migrations/004_upsert_thought_with_embedding.sql."
    );

    const { data: upserted, error: upsertError } = await this.client.rpc("upsert_thought", {
      p_content: opts.content,
      p_payload: envelope,
    });
    if (upsertError) throw new Error(upsertError.message);

    const id = (upserted as { id?: string } | null)?.id;
    if (!id) throw new Error("upsert_thought returned no id, so the embedding could not be attached.");

    // The label travels with the vector here too (021): a re-capture of a
    // labelled row through this path would otherwise leave the old label
    // beside a vector from another model — the one state nothing can see. A
    // schema without the column (this path exists for one without 004) refuses
    // the unknown column; the vector is then attached alone, unlabelled, as
    // before 021 (third review pass).
    let { error: embError } = await this.client
      .from("thoughts")
      .update({ embedding: opts.embedding, embedding_model: opts.embeddingModel ?? null })
      .eq("id", id);
    if (embError && /embedding_model|PGRST204/i.test(`${embError.code} ${embError.message}`)) {
      ({ error: embError } = await this.client.from("thoughts").update({ embedding: opts.embedding }).eq("id", id));
    }

    // The row is committed but unsearchable. Report it as such rather than as a
    // total failure — the content is not lost, only the vector.
    if (embError) return { id, embeddingFailed: embError.message };

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
    embeddingModel?: string;
  }): Promise<UpdateResult> {
    const chunks = (opts.chunks ?? []).map((c) => ({
      content: c.content,
      embedding: `[${c.embedding.join(",")}]`,
      context: c.context ?? null,
    }));
    // Eight named arguments since migration 021: the model beside the vector.
    // Against a database whose update_thought predates 021 this is PGRST202,
    // which preflight's `edit signature` check reports before the server serves.
    const { data, error } = await this.client.rpc("update_thought", {
      p_id: opts.id,
      p_content: opts.content ?? null,
      p_metadata_patch: opts.metadataPatch ?? null,
      p_embedding: opts.embedding ?? null,
      p_chunks: chunks.length ? chunks : null,
      p_if_unchanged_since: opts.ifUnchangedSince ?? null,
      p_actor: actorPayload(opts.actor),
      p_embedding_model: opts.embeddingModel ?? null,
    });
    if (error) throw new Error(error.message);
    return normaliseMutation(data as Record<string, unknown>);
  }

  async deleteThought(opts: {
    id: string;
    actor?: Actor;
  }): Promise<MutationResult> {
    const { data, error } = await this.client.rpc("delete_thought", {
      p_id: opts.id,
      p_actor: actorPayload(opts.actor),
    });
    if (error) throw new Error(error.message);
    return normaliseMutation(data as Record<string, unknown>);
  }

  async resolveAgent(opts: { keyHash: string; label: string; scope?: string }): Promise<AgentResolution> {
    const { data, error } = await this.client.rpc("resolve_agent", {
      p_key_hash: opts.keyHash,
      p_label: opts.label,
      p_scope: opts.scope ?? null,
    });
    if (error) throw new Error(error.message);
    return normaliseAgentResolution(data);
  }

  async traceProvenance(opts: { id: string; maxDepth?: number; nodeCap?: number }): Promise<ProvenanceNode[]> {
    if (!UUID_RE.test(opts.id)) return [];
    // Migration 025's function is plain (no SECURITY DEFINER/service_role), so
    // PostgREST reaches it over rpc like every other. NULL args take its defaults.
    const { data, error } = await this.client.rpc("trace_provenance", {
      p_thought_id: opts.id,
      p_max_depth: opts.maxDepth ?? null,
      p_node_cap: opts.nodeCap ?? null,
    });
    if (error) throw new Error(error.message);
    return ((data ?? []) as Record<string, unknown>[]).map(normaliseProvenanceNode);
  }

  async findDerivatives(opts: { id: string; limit?: number }): Promise<Derivative[]> {
    if (!UUID_RE.test(opts.id)) return [];
    const { data, error } = await this.client.rpc("find_derivatives", {
      p_thought_id: opts.id,
      p_limit: opts.limit ?? null,
    });
    if (error) throw new Error(error.message);
    return ((data ?? []) as Record<string, unknown>[]).map(normaliseDerivative);
  }

  async supersededAmong(ids: string[]): Promise<Record<string, string>> {
    const valid = ids.filter((id) => UUID_RE.test(id));
    if (valid.length === 0) return {};
    // No DISTINCT ON over PostgREST; fetch the newer rows and reduce in JS,
    // keeping the newest per superseded id. Best-effort: a pre-025 schema has no
    // `supersedes` column and the select errors — the label is an enhancement,
    // so return {} and let preflight's `provenance` check name the fix rather
    // than break the search that called this.
    try {
      const { data, error } = await this.client
        .from("thoughts")
        .select("id, supersedes, created_at")
        .in("supersedes", valid)
        .order("created_at", { ascending: false })
        .order("id", { ascending: false });
      if (error) return {};
      const out: Record<string, string> = {};
      for (const r of (data ?? []) as { id: string; supersedes: string }[]) {
        // First per supersedes wins; the (created_at, id) DESC order makes that
        // the newest — with the id tiebreak so a created_at tie (two rows
        // superseding one id in one transaction share now()) is deterministic
        // and agrees with the SQL store's DISTINCT ON (review pass 1, SMD-1253).
        if (!(r.supersedes in out)) out[r.supersedes] = r.id;
      }
      return out;
    } catch {
      return {};
    }
  }

  async close(): Promise<void> {
    // supabase-js holds no pooled connection; nothing to release.
  }
}
