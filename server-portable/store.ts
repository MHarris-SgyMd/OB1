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
  /** The raw cosine similarity — what the threshold gates. Unchanged by a recency weight. */
  similarity: number;
  created_at: string;
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
/** What the store sends when the caller says nothing: the function's own DEFAULTs (migration 020), mirrored once for both stores. */
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
  created_at: string;
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
  created_at: string;
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
  /** The fused score; monotone in the rank the function returned. Not for display. */
  score: number;
};

/**
 * A timestamptz as either backend hands it back, into the one string form the
 * store's types promise. The two clients disagree: Bun.sql (the SQL store, and
 * `compat/supabase-sql` under the PostgREST store's tests) returns a Date, or
 * the number ±Infinity for an infinite timestamp; PostgREST returns a JSON
 * string in Postgres's own spelling — `2026-09-14T16:27:09.123456+00:00`, or
 * `infinity`. Nothing else may format a timestamp: a `String()` on the Date
 * gave a locale string once, and a bare cast gave each caller its client's
 * shape (SMD-1040; FORK.md §52 has the history).
 *
 * The rule. A finite timestamp is `toISOString`. One with no ISO form keeps
 * the text it arrived as rather than failing the caller's whole result — one
 * odd row stays one odd row. The column allows `infinity`, which migration
 * 020 ranks by design; both clients' spellings of it come out as Postgres's.
 * A BC date or a year past ±275760 is the case the two clients do NOT agree
 * on: PostgREST's text survives (`0044-03-15T00:00:00+00:00 BC`), but Bun's
 * driver has already turned it into `Date(NaN)` — or, on a parameterised
 * query, a Date whose `toISOString` is the extended-year form — before the
 * store sees it, so the SQL store hands back JS's "Invalid Date". Recovering
 * the text there means selecting `created_at::text` beside the column; that,
 * and whether NULL (the epoch, the Date(null) convention every mapper here
 * has always had) and the no-ISO-form rows should be `null` under a widened
 * type, and what the tools print for them (today "Invalid Date"), is
 * SMD-1328. `undefined` throws: the column is missing from the row, a bug in
 * the SELECT, not data.
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
 * `isoTimestamp` for a key an envelope may omit — `update_thought`'s jsonb
 * before 018 had no `updated_at`; `resolve_agent`'s has `revoked_at` only when
 * revoked. Absence is legitimate there, so `undefined` is `undefined`, not the
 * throw above. The one place `== null` is the right test.
 */
export function isoTimestampOpt(v: unknown): string | undefined {
  return v == null ? undefined : isoTimestamp(v);
}

/**
 * The row normalisers. One per row shape the store interface returns, shared
 * by both stores, so a field's format or a column's name cannot drift between
 * them: PostgREST returns the function's snake_case columns, and a cast
 * type-checks while delivering `undefined` (`total_count` once) or the
 * client's own value (`created_at`, above). Numeric columns go through
 * `Number` because a driver may hand a float8 or bigint back as a string.
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
 * A `search_thoughts_hybrid` row as either backend hands it back — snake_case
 * column names, `similarity` possibly NULL, text[] as arrays — into the store's
 * shape. Shared so the two stores cannot drift on the nullable field:
 * `Number(null)` is 0, which would turn "this row has no vector" into "this row
 * is orthogonal to the query" on whichever store forgot.
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
    // gives {"0":1}. The PostgREST store's conformance test caught it.
    needleCounts: r.needle_counts != null && typeof r.needle_counts === "object" && "length" in (r.needle_counts as object)
      ? Array.from(r.needle_counts as ArrayLike<unknown>, Number)
      : [],
    commonNeedles: strings(r.common_needles),
    literalOnly: r.literal_only === true,
    score: Number(r.score),
  };
}

export type ThoughtRecord = {
  id: string;
  content: string;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at?: string | null;
};

export type ThoughtListItem = {
  id: string;
  content: string;
  metadata: Record<string, unknown>;
  created_at: string;
};

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
    created_at: isoTimestamp(r.created_at),
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
 * column or argument, not a not-found; both stores' read methods treat it as
 * no-match so a bad id from an MCP client gets a clean answer, not a Postgres
 * error string — the same answer whichever store is configured.
 */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * What thought_stats renders: the corpus total, its date range, and the counts
 * by type, topic and person. The tool sorts each map and renders its own top 10,
 * so a store need only return at least that many, in any order — the maps are not
 * a contract for the full distribution. They differ by backend and deliberately:
 * the SQL store returns every `type` but only the top 10 `topics`/`people`
 * (migration 024 caps them in SQL); the PostgREST walk returns every key of all
 * three. For the metadata the capture path produces — a string `type`, `topics`
 * and `people` as arrays of strings — the two backends render the same top-10
 * breakdowns, which the tests assert. The guarantee stops at well-formed data:
 * a non-string scalar `type` (`0`, `false`) or a non-string array element is
 * degenerate metadata the capture path never writes, and the SQL text-coercion
 * (`->>`, `jsonb_array_elements_text`) and the JS walk's truthiness/`String()`
 * may key or drop it differently; likewise, when equal counts tie for the 10th
 * slot, which of the tied keys shows is unspecified on both paths. Both remain
 * a correct top-10 — this is not a byte-identical-output contract.
 *
 * `aggregated` is how many rows the breakdowns actually cover. On the SQL store
 * it equals `total`: one aggregate over the whole table (migration 024), never
 * capped. On the PostgREST store it is the reach of the capped page walk and can
 * be < total on a very large brain; the tool prints a truncation note only when
 * the two differ. `total` and the walk are separate reads there (as the tool's
 * were before SMD-1249), so under concurrent writes across the ~100-page window
 * the note is best-effort, not transactional. See `statsSummary`.
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

export type ListFilters = {
  limit: number;
  type?: string;
  topic?: string;
  person?: string;
  days?: number;
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
  created_at: string;
  cycle: boolean;
};

/** One thought derived directly from a given one (migration 025's find_derivatives, the walk DOWN). */
export type Derivative = {
  id: string;
  content: string;
  type: string | null;
  sourceType: string | null;
  derivationMethod: string | null;
  created_at: string;
};

/** The five columns 025's two functions share; spread FIRST, so an explicit field can never be overwritten by it. */
function derivationFields(r: Record<string, unknown>) {
  return {
    content: String(r.content),
    type: r.type == null ? null : String(r.type),
    sourceType: r.source_type == null ? null : String(r.source_type),
    derivationMethod: r.derivation_method == null ? null : String(r.derivation_method),
    created_at: isoTimestamp(r.created_at),
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
  /** Set when the row was written but its embedding could not be attached. */
  embeddingFailed?: string;
  /**
   * Migration 034 (SMD-1453): true when the text was already captured — the
   * metadata merged, the vector and windows moved by 021/022's rules, and any
   * `derivedFrom` / `supersedes` named on this call NOT written, since a
   * re-capture leaves an existing thought's provenance as it is (setting it is
   * update_thought's). Absent when the database is from before 034, or on the
   * PostgREST two-step fallback, whose 2-argument form does not say.
   */
  existed?: boolean;
};

/**
 * One row of migration 029's review queue, with both thoughts (SMD-1294): a
 * pair the consolidation pass judged to conflict, the judge's verdict on which
 * is current, and where the review stands. `list_supersession_proposals`'s
 * shape, in one place for both stores.
 */
export type SupersessionProposal = {
  id: string;
  status: "pending" | "accepted" | "rejected";
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
  /** Each thought as it is now; `edited` when its text has changed since the pair was judged (the verdict was about the earlier text). */
  older: { id: string; content: string; created_at: string; edited: boolean };
  newer: { id: string; content: string; created_at: string; edited: boolean };
};

/** list_supersession_proposals's row → SupersessionProposal; both stores map through here so neither drifts. */
export function normaliseProposal(r: Record<string, unknown>): SupersessionProposal {
  const iso = (v: unknown) => new Date(v as string).toISOString();
  return {
    id: String(r.id),
    status: String(r.status) as SupersessionProposal["status"],
    verdict: String(r.verdict) as SupersessionProposal["verdict"],
    confidence: Number(r.confidence),
    reason: r.reason == null ? null : String(r.reason),
    similarity: r.similarity == null ? null : Number(r.similarity),
    judgeKey: String(r.judge_key),
    judgedAt: iso(r.judged_at),
    reviewedAt: r.reviewed_at == null ? null : iso(r.reviewed_at),
    reviewNote: r.review_note == null ? null : String(r.review_note),
    supersedingId: r.superseding_id == null ? null : String(r.superseding_id),
    older: { id: String(r.older_id), content: String(r.older_content), created_at: iso(r.older_created_at), edited: r.older_edited === true },
    newer: { id: String(r.newer_id), content: String(r.newer_content), created_at: iso(r.newer_created_at), edited: r.newer_edited === true },
  };
}

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
/**
 * What update_thought / delete_thought refuse with. SUPERSEDES_NOT_FOUND and
 * WOULD_CYCLE (migration 032): the provenance envelope named a thought that
 * does not exist, or a pointer that would close a supersession loop.
 */
export type MutationError = "NOT_FOUND" | "STALE_READ" | "DUPLICATE_CONTENT" | "SUPERSEDES_NOT_FOUND" | "WOULD_CYCLE";
export type MutationResult =
  | { ok: true; id: string }
  | { ok: false; error: MutationError; currentUpdatedAt?: string };
/**
 * `duplicateOf` (migration 018): the edit's text normalises to what the row
 * already held AND another thought carries that fingerprint — a pair from
 * before migration 003's fingerprint. The edit was kept and this row's
 * fingerprint left NULL; the caller is told so the pair can be resolved.
 */
export type UpdateResult = MutationResult & { updatedAt?: string; duplicateOf?: string; fingerprintHeldBy?: string };

/**
 * Both SQL functions return the same {ok, id|error} envelope; this turns it into
 * the store's discriminated union. Shared so the two stores cannot disagree
 * about what a refusal looks like — the class of bug the audit work hit twice.
 */
export function normaliseMutation(r: Record<string, unknown> | undefined): UpdateResult {
  if (!r) return { ok: false, error: "NOT_FOUND" };
  if (r.ok === true) {
    return {
      ok: true,
      id: String(r.id),
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
    };
  }
  return {
    ok: false,
    error: (r.error as MutationError) ?? "NOT_FOUND",
    currentUpdatedAt: isoTimestampOpt(r.current_updated_at),
  };
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
  source?: string;
  session?: string;
  /**
   * Stable id from ob1_agents. Absent when the registry is unreachable or
   * migration 010 is not applied; the audit row then carries the name alone,
   * which is exactly the pre-010 behaviour rather than a new failure.
   */
  agentId?: string;
};

/**
 * The wire form of an Actor: exactly the keys the audit trigger reads.
 *
 * This function exists because the trigger reads `actor->>'agent_id'` and the
 * TypeScript field is `agentId`. Passing the object through unchanged type-checks
 * cleanly, runs without error, and writes NULL into canonical_agent_id on every
 * row — the failure is invisible until someone queries the column months later
 * and finds it empty. Both stores go through here so neither can drift.
 */
export function actorPayload(actor: Actor | undefined): Record<string, unknown> | null {
  if (!actor) return null;
  return {
    name: actor.name,
    ...(actor.source !== undefined ? { source: actor.source } : {}),
    ...(actor.session !== undefined ? { session: actor.session } : {}),
    ...(actor.agentId !== undefined ? { agent_id: actor.agentId } : {}),
  };
}

/**
 * The `p_payload` envelope `upsert_thought` has read since migration 004:
 * `metadata`, plus `actor` (008, the audit trail) and `embedding_model` (021,
 * the label beside the vector) when given. Built here for both stores, so a
 * key one of them forgot is a compile error rather than a NULL label.
 */
export function captureEnvelope(
  payload: { metadata: Record<string, unknown> },
  actor: Actor | undefined,
  embeddingModel: string | undefined,
  /**
   * Migration 025 (SMD-1253): what this thought was derived from, and which it
   * supersedes. Rides the envelope like the actor and the model, so both stores
   * send it identically and upsert_thought validates it in one place. Absent
   * keys mean "no provenance"; upsert_thought refuses a malformed derived_from.
   */
  provenance?: { derivedFrom?: string[]; supersedes?: string }
): Record<string, unknown> {
  return {
    ...payload,
    ...(actor ? { actor: actorPayload(actor) } : {}),
    ...(embeddingModel !== undefined ? { embedding_model: embeddingModel } : {}),
    ...(provenance?.derivedFrom !== undefined ? { derived_from: provenance.derivedFrom } : {}),
    ...(provenance?.supersedes !== undefined ? { supersedes: provenance.supersedes } : {}),
  };
}

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
 * Built here for both stores, as captureEnvelope is, so the SQL positional
 * call and the PostgREST named one cannot spell the envelope differently.
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

export interface ThoughtStore {
  readonly kind: "postgrest" | "sql";

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
   * the SQL function, not here, so both backends escape identically and neither
   * can be the one that forgets.
   */
  keywordThoughts(opts: {
    query: string;
    limit: number;
    offset: number;
    filter: Record<string, unknown>;
  }): Promise<ThoughtKeywordMatch[]>;

  /**
   * The two above fused (migration 017): rank on the vector arm, presence per
   * needle on the keyword arm. `query` is the text the needles are extracted
   * from, in SQL, so both backends extract identically; `embedding` is of that
   * same text. Fixed top-`limit`, no paging.
   */
  hybridThoughts(opts: {
    query: string;
    embedding: number[];
    threshold: number;
    limit: number;
    filter: Record<string, unknown>;
  } & RecencyOpts): Promise<ThoughtHybridMatch[]>;

  getThought(id: string): Promise<ThoughtRecord | null>;

  listThoughts(filters: ListFilters): Promise<ThoughtListItem[]>;

  /** Exact row count of the whole corpus. */
  countThoughts(): Promise<number>;

  /**
   * Everything thought_stats needs, aggregated by the store. The two backends
   * differ, and this is one of the places the interface says so:
   *   - SQL (store-sql.ts) runs migration 024's thought_stats_summary() — the
   *     whole corpus in one statement, `aggregated === total`, no cap.
   *   - PostgREST (store-postgrest.ts) has no server-side aggregation, so it
   *     walks pageThoughtMeta in pages up to a safety cap and tallies in memory;
   *     `aggregated` is that reach and may be < total, which the tool surfaces.
   */
  statsSummary(): Promise<ThoughtStats>;

  /**
   * One page of metadata for aggregation, newest first. The PostgREST
   * `statsSummary` walks this; the SQL store keeps it as a primitive
   * (test-store-sql covers it) even though its own `statsSummary` no longer
   * needs it.
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
     *
     * Both stores carry it. An earlier version of this comment claimed the
     * PostgREST path could not, which was wrong: the actor rides in the payload
     * envelope, and `upsert_thought` has read one since migration 004.
     */
    actor?: Actor;
    payload: { metadata: Record<string, unknown> };
    embedding: number[];
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
     * is. Rides in the payload envelope on both stores, as the actor does.
     */
    embeddingModel?: string;
    /**
     * Migration 025 (SMD-1253). `derivedFrom` is the source thoughts a derived
     * artifact (digest, synthesis, consolidation) was built from — an array of
     * existing thought ids, validated by upsert_thought or the write is refused.
     * `supersedes` is the one prior thought this one replaces. Both ride the
     * envelope; both absent is an ordinary first-hand capture. Written on a
     * FIRST capture only (migration 034): a re-capture of text that exists
     * leaves that thought's provenance as it is and reports `existed`.
     */
    derivedFrom?: string[];
    supersedes?: string;
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
  }): Promise<UpdateResult>;

  /** Hard delete. Chunks cascade; migration 008 preserves the prior content. */
  deleteThought(opts: {
    id: string;
    actor?: Actor;
  }): Promise<MutationResult>;

  /**
   * Resolve a key digest and its configured name to a stable agent id,
   * registering the pair on first sight. Migration 010.
   *
   * On the store rather than in a helper because the two backends reach
   * Postgres differently and this has to work on both — a Workers deployment
   * speaking PostgREST needs the same identity a Bun deployment gets.
   */
  resolveAgent(opts: { keyHash: string; label: string; scope?: string }): Promise<AgentResolution>;

  /**
   * Migration 025's read-back. traceProvenance walks UP the derived_from chain
   * (ancestors, depth 0 = the thought itself); findDerivatives looks DOWN it
   * (what was derived from this, one level). Both backends run the SQL functions
   * — plain, ungranted, so PostgREST can call them too — and both are
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
   * ranking change is gated on eval-supersession.ts. Empty when nothing given or
   * nothing superseded; best-effort, so a pre-025 database returns an empty map
   * rather than breaking search — preflight's `provenance` check names the fix.
   */
  supersededAmong(ids: string[]): Promise<Record<string, string>>;

  /**
   * Migration 029's review queue (SMD-1294): the pairs db/consolidate.ts
   * judged to conflict, in one status (null for every status), most confident
   * first, each with both thoughts. Read-only — accepting or rejecting is the
   * worker's --accept / --reject, through review_supersession_proposal, so the
   * write to thoughts.supersedes has one path. Throws on a schema before 029;
   * the tool names the migration.
   */
  listSupersessionProposals(opts: { status?: "pending" | "accepted" | "rejected" | null; limit?: number }): Promise<SupersessionProposal[]>;

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
