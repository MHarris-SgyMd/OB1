/**
 * store.ts — the seam between the MCP tools and whatever holds the thoughts.
 *
 * Phase 2 of the Supabase migration. `supabase-js` is not a Postgres driver; it is
 * an HTTP client for PostgREST, and it is the deepest coupling in the project —
 * moving the database alone does nothing for it. This interface is the boundary
 * that lets the PostgREST client be swapped for direct SQL without the tool
 * definitions knowing.
 *
 * Two implementations, one default:
 *
 *   - `sql` (store-sql.ts) — Postgres directly, through Bun's client. THE
 *     DEFAULT since change 97 (SMD-1797): it is the store SETUP.md's container
 *     runs, the one every CI job against real Postgres exercises, and the one
 *     that needs no Supabase project. Unset OB1_STORE selects it.
 *   - `postgrest` (store-postgrest.ts) — PostgREST over HTTP, via supabase-js.
 *     Kept for Cloudflare Workers, which cannot hold a Postgres connection, so
 *     the Bun client that store-sql.ts imports does not run there. Selected
 *     explicitly with OB1_STORE=postgrest; on a runtime that has Bun the
 *     selection is reported as retired (postgrestOnBunNotice), since the SQL
 *     store is available there and is what every other path runs.
 *
 * The cutover rationale the first version of this file gave — run both stacks
 * against the same data and diff — is done: test-store-postgrest.ts holds the
 * PostgREST store's argument shapes against real Postgres through the SQL shim,
 * and the two stores share every normaliser below so they cannot present two
 * shapes to the tools (SMD-1040, SMD-1328).
 */

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
  /** The fused score; monotone in the rank the function returned. Not for display. */
  score: number;
};

/**
 * A timestamptz as either backend hands it back, into the one string form the
 * store's types promise. The two clients disagree: Bun.sql (the SQL store)
 * returns a Date, or the number ±Infinity for an infinite timestamp; PostgREST
 * returns a JSON string in Postgres's own spelling —
 * `2026-09-14T16:27:09.123456+00:00`, or `infinity`; and `compat/supabase-sql`
 * under the PostgREST store's tests, which hands back a finite Date as its
 * `toISOString` string since FORK.md change 73 (SMD-1544), gives the string
 * form in JS's spelling. Nothing else may format a timestamp: a `String()` on the Date
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
 * column or argument, not a not-found; both stores' read methods treat it as
 * no-match so a bad id from an MCP client gets a clean answer, not a Postgres
 * error string — the same answer whichever store is configured.
 */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The one contract for a batch of query-log action rows, applied by BOTH
 * writers before anything reaches a database: an absent agent — null,
 * undefined or the empty string — is SQL NULL (034's anonymous bucket); a
 * target must be present; and any id that is not a uuid is refused here,
 * loudly and naming the column, rather than reaching array_in or PostgREST as
 * a malformed value the best-effort caller would swallow with the whole batch.
 * An eighth review pass found the SQL writer holding this rule and the
 * PostgREST writer sending `""` through as an agent id (22P02, batch dropped);
 * one function, one contract.
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
  /** Set when the row was written but its embedding could not be attached. */
  embeddingFailed?: string;
  /**
   * Migration 035 (SMD-1453): true when the text was already captured — the
   * metadata merged, the vector and windows moved by 021/022's rules, and any
   * `derivedFrom` / `supersedes` named on this call NOT written, since a
   * re-capture leaves an existing thought's provenance as it is (setting it is
   * update_thought's). Absent when the database is from before 035, or on the
   * PostgREST two-step fallback, whose 2-argument form does not say.
   */
  existed?: boolean;
  /**
   * Beside `existed` (migration 035): the row's `supersedes` pointer after the
   * write — the fresh row's, or the one the existing row keeps — so a caller
   * told the text existed can say what stands rather than guess. `null` is a
   * row with no pointer; absent whenever `existed` is.
   */
  supersedes?: string | null;
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
  /** Each thought as it is now; `edited` when its text has changed since the pair was judged (the verdict was about the earlier text). `created_at` is `string | null` for the same reason the read path is (SMD-1803). */
  older: { id: string; content: string; created_at: string | null; edited: boolean };
  newer: { id: string; content: string; created_at: string | null; edited: boolean };
};

/** list_supersession_proposals's row → SupersessionProposal; both stores map through here so neither drifts. */
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
    older: { id: String(r.older_id), content: String(r.older_content), created_at: isoTimestampOrNull(r.older_created_at), edited: r.older_edited === true },
    newer: { id: String(r.newer_id), content: String(r.newer_content), created_at: isoTimestampOrNull(r.newer_created_at), edited: r.newer_edited === true },
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
/**
 * Both functions' envelopes as one normaliser reads them — the superset that
 * UpdateResult and DeleteResult each narrow. Shared so the two stores cannot
 * disagree about what a refusal looks like.
 */
export type MutationEnvelope =
  | { ok: true; id: string; updatedAt?: string; duplicateOf?: string; fingerprintHeldBy?: string; detached?: number; inactive?: number }
  | { ok: false; error: MutationError; currentUpdatedAt?: string; citedBy?: number; citations?: Citation[] };
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
};

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
     * FIRST capture only (migration 035): a re-capture of text that exists
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
   * One writer for every action row, so there is one INSERT shape per store
   * to keep right; an empty list writes nothing.
   */
  logActions(rows: QueryActionLog[]): Promise<void>;

  close(): Promise<void>;
}

export type StoreEnv = {
  /**
   * The PostgREST store's base URL — or, holding a postgres:// URL, the SQL
   * store's connection string (see databaseUrl): compat/supabase-sql reads a
   * Postgres URL from this name for every vendored server migrated onto it, so
   * a box running one of those beside this server sets one variable, not two.
   */
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  /** The SQL store's connection string. Read before SUPABASE_URL. */
  DATABASE_URL?: string;
  /** "sql" (the default when unset) or "postgrest" (Cloudflare Workers). */
  OB1_STORE?: string;
};

/** What an unset OB1_STORE selects. */
export const DEFAULT_STORE = "sql";

/** The store OB1_STORE names, lower-cased; DEFAULT_STORE when it is unset. */
export function storeKind(env: StoreEnv): string {
  return (env.OB1_STORE ?? DEFAULT_STORE).toLowerCase();
}

/** A libpq-style connection string — what the SQL store dials and PostgREST never is. */
export function isPostgresUrl(value: string | undefined): boolean {
  return typeof value === "string" && /^postgres(ql)?:\/\//i.test(value.trim());
}

/**
 * The SQL store's connection string and which variable supplied it:
 * DATABASE_URL first; else SUPABASE_URL when it holds a postgres:// URL — the
 * spelling compat/supabase-sql takes, so a deployment of a shim-migrated
 * vendored server beside this one sets that name once and both read it. An
 * https:// SUPABASE_URL is PostgREST's and is never dialled as Postgres: the
 * caller reports it as the PostgREST store's configuration under an SQL
 * selection (missingDatabaseUrl names both fixes).
 */
export function databaseUrl(env: StoreEnv): { url: string; from: "DATABASE_URL" | "SUPABASE_URL" } | null {
  if (env.DATABASE_URL) return { url: env.DATABASE_URL, from: "DATABASE_URL" };
  if (isPostgresUrl(env.SUPABASE_URL)) return { url: env.SUPABASE_URL!.trim(), from: "SUPABASE_URL" };
  return null;
}

/**
 * Why an SQL selection with no connection string is refused — one message for
 * createStore's throw and preflight's DATABASE_URL check, so the two cannot
 * disagree about what to set. Names the PostgREST route when SUPABASE_URL holds
 * an https:// URL: that is the deployment the old default served, and it keeps
 * working under an explicit OB1_STORE=postgrest.
 */
export function missingDatabaseUrl(env: StoreEnv): { problem: string; fix: string } {
  const selected = env.OB1_STORE === undefined ? "OB1_STORE is unset, which selects the SQL store" : `OB1_STORE=${env.OB1_STORE} selects the SQL store`;
  const postgrestUrl = Boolean(env.SUPABASE_URL) && !isPostgresUrl(env.SUPABASE_URL);
  return {
    problem: `${selected}, and DATABASE_URL is not set${postgrestUrl ? " — SUPABASE_URL holds a non-postgres:// URL, the PostgREST store's base URL rather than a connection string" : ""}`,
    fix: postgrestUrl
      ? "Set DATABASE_URL to the brain's postgres:// connection string — or, to keep reaching this brain through PostgREST at SUPABASE_URL (kept for Cloudflare Workers), set OB1_STORE=postgrest."
      : "Set DATABASE_URL to the brain's postgres:// connection string.",
  };
}

/**
 * The other mismatch: the PostgREST store selected while SUPABASE_URL holds a
 * postgres:// connection string — the one-box operator who kept an old
 * OB1_STORE=postgrest beside a shim-migrated neighbour's variable. supabase-js
 * would take the string as a base URL and fail at the first call with
 * "protocol must be http:, https: or s3:", a message that names neither the
 * variable nor the fix; and the string carries a password, which no report
 * may print. One refusal for createStore and preflight; null when the
 * selection and the URL agree.
 */
export function postgrestOverPostgresUrl(env: StoreEnv): string | null {
  if (storeKind(env) !== "postgrest" || !isPostgresUrl(env.SUPABASE_URL)) return null;
  return "OB1_STORE=postgrest selects the PostgREST store, but SUPABASE_URL holds a postgres:// connection string, which PostgREST cannot dial (its base URL is http(s)://). " +
    "Unset OB1_STORE — the SQL store reads that URL as its connection string — or set SUPABASE_URL to the PostgREST base URL.";
}

/** preflight's wording for a direct-connection check that has no PostgREST form; exported so the suite can name it. */
export const DIRECT_CHECK_SKIP_OVER_POSTGREST = "not checked over PostgREST — a catalog read with no PostgREST form";

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
 * The line a PostgREST selection earns on a runtime where the SQL store runs.
 * Null on Workers (no Bun, no SQL store, PostgREST is the path) and for every
 * other selection. `hasBun` is a parameter so the test can ask both answers on
 * one runtime; production passes nothing and gets the runtime's own.
 */
export function postgrestOnBunNotice(kind: string, hasBun: boolean = typeof Bun !== "undefined"): string | null {
  if (kind !== "postgrest" || !hasBun) return null;
  return "OB1_STORE=postgrest selects the PostgREST store, which this fork keeps for Cloudflare Workers only: " +
    "this process runs on Bun, where the SQL store (OB1_STORE unset or sql, DATABASE_URL set to the brain's postgres:// URL) " +
    "reaches the same database directly, needs no Supabase project and is what every test and the container run. " +
    "FORK.md change 97 (SMD-1797).";
}

/**
 * Build the configured store.
 *
 * The SQL implementation is imported dynamically on purpose: it pulls in Bun's
 * Postgres client, which does not exist on Cloudflare Workers. A static import
 * would break the Workers build for every deployment, including the ones that
 * only ever use PostgREST. (wrangler.toml aliases the `bun` specifier to a stub
 * for the bundler's sake, and sets OB1_STORE=postgrest so the default here is
 * never what a Workers deployment gets.)
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
    return new SqlStore(conn.url);
  }

  if (kind === "postgrest") {
    if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
      throw new Error("OB1_STORE=postgrest requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
    }
    const mismatch = postgrestOverPostgresUrl(env);
    if (mismatch) throw new Error(mismatch);
    const { PostgrestStore } = await import("./store-postgrest.ts");
    return new PostgrestStore(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
  }

  throw new Error(`Unknown OB1_STORE "${kind}" — expected "sql" (the default) or "postgrest" (Cloudflare Workers)`);
}
