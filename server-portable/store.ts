/**
 * store.ts — the seam between the MCP tools and whatever holds the thoughts.
 *
 * Phase 2 of the Supabase migration. `supabase-js` is not a Postgres driver; it is
 * an HTTP client for PostgREST, and it is the deepest coupling in the project —
 * moving the database alone does nothing for it. This interface is the boundary
 * that lets the PostgREST client be swapped for direct SQL without the tool
 * definitions knowing.
 *
 * Both implementations are kept, deliberately:
 *
 *   - The plan's cutover step runs both stacks against the same data and diffs the
 *     results. That is impossible if the old path is deleted in the same change.
 *   - Cloudflare Workers cannot hold a Postgres connection pool, so PostgREST
 *     stays the sensible pairing there. Selecting at runtime keeps the runtime
 *     decision and the data-layer decision independent.
 *
 * Select with OB1_STORE=postgrest (default) or OB1_STORE=sql.
 */

export type ThoughtMatch = {
  id: string;
  content: string;
  metadata: Record<string, unknown>;
  similarity: number;
  created_at: string;
};

export type ThoughtRecord = {
  id: string;
  content: string;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at?: string | null;
};

export type ThoughtListItem = {
  content: string;
  metadata: Record<string, unknown>;
  created_at: string;
};

export type ThoughtMeta = {
  metadata: Record<string, unknown>;
  created_at: string;
};

export type ListFilters = {
  limit: number;
  type?: string;
  topic?: string;
  person?: string;
  days?: number;
};

export type CaptureResult = {
  id: string;
  /** Set when the row was written but its embedding could not be attached. */
  embeddingFailed?: string;
};

/**
 * Every database operation the MCP tools perform. Errors are thrown, not returned
 * — each implementation normalises its own error shape so callers do not have to
 * know whether they are talking to PostgREST or to Postgres.
 */
/**
 * A refused mutation is a result, not an exception: "your read was stale" and
 * "that id does not exist" are things the caller should act on, and throwing
 * would make them indistinguishable from a fault at the tool boundary.
 */
export type MutationError = "NOT_FOUND" | "STALE_READ" | "DUPLICATE_CONTENT";
export type MutationResult =
  | { ok: true; id: string }
  | { ok: false; error: MutationError; currentUpdatedAt?: string };
export type UpdateResult = MutationResult & { updatedAt?: string };

/**
 * Both SQL functions return the same {ok, id|error} envelope; this turns it into
 * the store's discriminated union. Shared so the two stores cannot disagree
 * about what a refusal looks like — the class of bug the audit work hit twice.
 */
export function normaliseMutation(r: Record<string, unknown> | undefined): UpdateResult {
  if (!r) return { ok: false, error: "NOT_FOUND" };
  if (r.ok === true) {
    return { ok: true, id: String(r.id), updatedAt: r.updated_at ? String(r.updated_at) : undefined };
  }
  return {
    ok: false,
    error: (r.error as MutationError) ?? "NOT_FOUND",
    currentUpdatedAt: r.current_updated_at ? String(r.current_updated_at) : undefined,
  };
}

export interface ThoughtStore {
  readonly kind: "postgrest" | "sql";

  matchThoughts(opts: {
    embedding: number[];
    threshold: number;
    limit: number;
    filter: Record<string, unknown>;
  }): Promise<ThoughtMatch[]>;

  getThought(id: string): Promise<ThoughtRecord | null>;

  listThoughts(filters: ListFilters): Promise<ThoughtListItem[]>;

  /** Exact row count of the whole corpus. */
  countThoughts(): Promise<number>;

  /** One page of metadata for aggregation, newest first. */
  pageThoughtMeta(offset: number, limit: number): Promise<ThoughtMeta[]>;

  /**
   * Store content, metadata and embedding. Implementations must make this as
   * close to atomic as their transport allows: a row committed without its
   * embedding is invisible to every semantic search.
   */
  captureThought(opts: {
    content: string;
    /**
     * Who is writing, for the audit trail (migration 008). Optional because the
     * PostgREST path cannot carry it and a mutation from a script legitimately
     * has no principal — the audit row then records a NULL actor, which is more
     * honest than a placeholder.
     */
    actor?: { name: string; source?: string; session?: string };
    payload: { metadata: Record<string, unknown> };
    embedding: number[];
    /**
     * Per-window embeddings for a capture too long to embed in one provider call.
     * Empty or absent for ordinary short thoughts, which stay exactly as they
     * were: one row, one vector, no chunk rows. See chunk.ts and migration 007.
     */
    chunks?: { content: string; embedding: number[] }[];
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
    chunks?: { content: string; embedding: number[] }[];
    ifUnchangedSince?: string;
    actor?: { name: string; source?: string; session?: string };
  }): Promise<UpdateResult>;

  /** Hard delete. Chunks cascade; migration 008 preserves the prior content. */
  deleteThought(opts: {
    id: string;
    actor?: { name: string; source?: string; session?: string };
  }): Promise<MutationResult>;

  close(): Promise<void>;
}

export type StoreEnv = {
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  DATABASE_URL?: string;
  OB1_STORE?: string;
};

/**
 * Build the configured store.
 *
 * The SQL implementation is imported dynamically on purpose: it pulls in Bun's
 * Postgres client, which does not exist on Cloudflare Workers. A static import
 * would break the Workers build for every deployment, including the ones that
 * only ever use PostgREST.
 */
export async function createStore(env: StoreEnv): Promise<ThoughtStore> {
  const kind = (env.OB1_STORE ?? "postgrest").toLowerCase();

  if (kind === "sql") {
    if (!env.DATABASE_URL) {
      throw new Error("OB1_STORE=sql requires DATABASE_URL");
    }
    const { SqlStore } = await import("./store-sql.ts");
    return new SqlStore(env.DATABASE_URL);
  }

  if (kind === "postgrest") {
    if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
      throw new Error("OB1_STORE=postgrest requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
    }
    const { PostgrestStore } = await import("./store-postgrest.ts");
    return new PostgrestStore(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
  }

  throw new Error(`Unknown OB1_STORE "${kind}" — expected "postgrest" or "sql"`);
}
