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
import { actorPayload, normaliseAgentResolution, normaliseMutation } from "./store.ts";
import type {
  Actor,
  AgentResolution,
  CaptureResult,
  ListFilters,
  MutationError,
  MutationResult,
  ThoughtListItem,
  ThoughtMatch,
  ThoughtMeta,
  ThoughtRecord,
  ThoughtStore,
  UpdateResult,
} from "./store.ts";

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
  }): Promise<ThoughtMatch[]> {
    const { data, error } = await this.client.rpc("match_thoughts", {
      query_embedding: opts.embedding,
      match_threshold: opts.threshold,
      match_count: opts.limit,
      filter: opts.filter,
    });
    if (error) throw new Error(error.message);
    return (data ?? []) as ThoughtMatch[];
  }

  async getThought(id: string): Promise<ThoughtRecord | null> {
    const { data, error } = await this.client
      .from("thoughts")
      .select("id, content, metadata, created_at, updated_at")
      .eq("id", id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return (data as ThoughtRecord | null) ?? null;
  }

  async listThoughts(f: ListFilters): Promise<ThoughtListItem[]> {
    let q = this.client
      .from("thoughts")
      .select("content, metadata, created_at")
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
    return (data ?? []) as ThoughtListItem[];
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
    return (data ?? []) as ThoughtMeta[];
  }

  async captureThought(opts: {
    content: string;
    payload: { metadata: Record<string, unknown> };
    embedding: number[];
    chunks?: { content: string; embedding: number[] }[];
    actor?: Actor;
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
    const envelope = opts.actor ? { ...opts.payload, actor: actorPayload(opts.actor) } : opts.payload;

    const { data: atomic, error: atomicError } = await this.client.rpc("upsert_thought", {
      p_content: opts.content,
      p_payload: envelope,
      p_embedding: opts.embedding,
      ...(chunks.length
        ? { p_chunks: chunks.map((c) => ({ content: c.content, embedding: `[${c.embedding.join(",")}]` })) }
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

    const { error: embError } = await this.client
      .from("thoughts")
      .update({ embedding: opts.embedding })
      .eq("id", id);

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
    chunks?: { content: string; embedding: number[] }[];
    ifUnchangedSince?: string;
    actor?: Actor;
  }): Promise<UpdateResult> {
    const chunks = (opts.chunks ?? []).map((c) => ({
      content: c.content,
      embedding: `[${c.embedding.join(",")}]`,
    }));
    const { data, error } = await this.client.rpc("update_thought", {
      p_id: opts.id,
      p_content: opts.content ?? null,
      p_metadata_patch: opts.metadataPatch ?? null,
      p_embedding: opts.embedding ?? null,
      p_chunks: chunks.length ? chunks : null,
      p_if_unchanged_since: opts.ifUnchangedSince ?? null,
      p_actor: actorPayload(opts.actor),
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

  async close(): Promise<void> {
    // supabase-js holds no pooled connection; nothing to release.
  }
}
