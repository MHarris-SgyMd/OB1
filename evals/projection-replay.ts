/**
 * projection-replay.ts — the rules of the incremental-replay spike, pure
 * (Linear SMD-1998, Spike 1 of the event-sourcing ADR SMD-1997).
 *
 * Under CQRS-lite the thoughts row, the chunk rows, the entity graph, the
 * proposals and the capture-time metadata are PROJECTIONS folded from the
 * event log, and a rebuild of a projection must not recompute what has not
 * changed — the embedding index above all, since re-embedding the corpus is
 * the one operation the whole re-embed machinery (015/018/021/034) exists to
 * make survivable. The question this file answers with arithmetic, and
 * eval-projection-replay.ts with a live brain: is the snapshot key the schema
 * already records enough to make a rebuild cost O(changed rows)?
 *
 * The contract, pre-registered on the ticket before the first run, is
 * PROJECTIONS below: per projection, the key a replay derives from the event
 * payload and what the row records of it. The replay rule is decideEmbedding:
 * a key on the row at all, the payload's fingerprint against the row's, a
 * vector present or not, the row's model label against the target — reuse on
 * a hit, recompute on a miss, every miss with a reason the key can state. The scenarios are the ticket's:
 * a no-op rebuild, N edits, a model bump, a comprehension-only change, a
 * window-recipe change. Nothing here reads a database or calls a provider
 * (lib.ts, imported for `median`, reads a .env file on import — nothing more);
 * eval-projection-replay.ts --self-check probes every rule with hand-known
 * rows, and its --fixture-check seeds a throwaway brain with one row per
 * branch so the SQL that derives these rows' fields is held too.
 */

import { median } from "./lib.ts";

// ── The contract ─────────────────────────────────────────────────────────────

export type ProjectionName = "embedding" | "chunks" | "graph" | "proposals" | "metadata" | "sources";
export type KeyVerdict = "recorded" | "recipe not recorded" | "half recorded" | "unkeyed";

export type Projection = {
  name: ProjectionName;
  table: string;
  /** The key a replay derives from the event's payload and the configuration. */
  derived: string;
  /** What the row records of that key. */
  recorded: string;
  verdict: KeyVerdict;
};

/** The snapshot key per projection, as the schema records it on 2026-09-24 (migrations to 053). */
export const PROJECTIONS: readonly Projection[] = [
  {
    name: "embedding", table: "thoughts.embedding",
    derived: "(content_fingerprint_of(content), embedding_model); the prompt template and the requested width ride on the model name by convention (embed.ts, EMBEDDING_PROMPTS) — code, not data, so a template change under one name invalidates every vector with the key unmoved, and the cosine bar below is the check for that",
    recorded: "content_fingerprint (003/023), embedding_model (021)", verdict: "recorded",
  },
  { name: "chunks", table: "thought_chunks", derived: "the parent's key + the window recipe (chunk tokens, overlap, chunk_context, the blurb model)", recorded: "the parent's label vouches for the rows (022); no recipe", verdict: "recipe not recorded" },
  { name: "graph", table: "thought_entities / ob1_entity_edges", derived: "(content_fingerprint, extraction_key)", recorded: "extraction_key, extracted_at; no fingerprint — staleness after an edit is read from the audit and the claim pool", verdict: "half recorded" },
  { name: "proposals", table: "supersession_proposals", derived: "(older_fingerprint, newer_fingerprint, judge_key)", recorded: "all three when the caller passed them (nullable, 029); consolidate.ts does", verdict: "recorded" },
  { name: "metadata", table: "thoughts.metadata (type, topics, people)", derived: "(content_fingerprint, metadata model, prompt version)", recorded: "nothing", verdict: "unkeyed" },
  { name: "sources", table: "thought_sources (053)", derived: "(canonical_hash of the source-faithful canonical, the adapter)", recorded: "canonical and canonical_hash side by side; the structured pass's rows carry a `source:` extraction key, no model", verdict: "recorded" },
];

export const KEY_VERDICTS: readonly KeyVerdict[] = ["recorded", "recipe not recorded", "half recorded", "unkeyed"];

// ── The rows ─────────────────────────────────────────────────────────────────

export type ClaimStatus = "pending" | "claimed" | "succeeded" | "failed";
const CLAIM_STATUSES: readonly ClaimStatus[] = ["pending", "claimed", "succeeded", "failed"];

/**
 * Where a thought stands in the extraction pool. `recorded` is its claim row
 * under the extraction key ob1_config records — the one pass whose rows will
 * refresh the graph — or `none`; `elsewhere` says a pending or claimed row
 * exists under another `extract:` key, which refreshes nothing under the
 * recorded key (the key moves as passes run: a 27B pass records its own).
 * `finished` places a succeeded row's finished_at against the thought's last
 * key-moving edit: `before` means the pass finished and the text then moved
 * without re-enqueueing under this key (016's trigger requeues under the key
 * of the moment, so the recorded key changed in between); `after` means the
 * pass ran after the move and left the graph rows where they were — a louder
 * condition; NULL when either stamp is missing.
 */
export type PoolState = { recorded: ClaimStatus | "none"; elsewhere: boolean; finished: "before" | "after" | null };

/** `work_type=status,work_type=status` as the SQL aggregates a thought's claim rows; anything else is refused. */
export function parsePool(text: string | null): { key: string; status: ClaimStatus }[] {
  if (!text) return [];
  return text.split(",").map((pair) => {
    const i = pair.lastIndexOf("=");
    const key = pair.slice(0, i);
    const status = pair.slice(i + 1) as ClaimStatus;
    if (i < 1 || !CLAIM_STATUSES.includes(status)) throw new Error(`a claim pair that is not key=status: "${pair}"`);
    return { key, status };
  });
}

export function poolState(pairs: readonly { key: string; status: ClaimStatus }[], recordedKey: string | undefined, finishedBeforeMove: boolean | null = null): PoolState {
  const own = recordedKey ? pairs.find((p) => p.key === recordedKey) : undefined;
  return {
    recorded: own?.status ?? "none",
    elsewhere: pairs.some((p) => p.key !== recordedKey && p.key.startsWith("extract:") && (p.status === "pending" || p.status === "claimed")),
    finished: own?.status === "succeeded" && finishedBeforeMove !== null ? (finishedBeforeMove ? "before" : "after") : null,
  };
}

/** One live thought as the replay sees it: the payload's key beside the row's. */
export type ThoughtRow = {
  id: string;
  chars: number;
  /** thoughts.content_fingerprint — the snapshot's key; NULL is a row with no key (pre-003, a bulk load, 018's held-key case). */
  storedFingerprint: string | null;
  /** content_fingerprint_of(content) — the key the payload derives, by the SQL rule's owner (016). */
  payloadFingerprint: string;
  /** thoughts.embedding_model; NULL is a vector of unknown model (021). */
  model: string | null;
  hasVector: boolean;
  chunkRows: number;
  /** Mention rows a MODEL pass wrote; 053's structured pass (`source:` keys, no model call) is not the graph projection this measures. */
  mentions: number;
  /**
   * An update event that moved the FINGERPRINT landed after the latest
   * extraction: the graph rows describe text whose key is gone. Decided in
   * SQL at full precision. Both stamps are transaction-start `now()`, so a
   * long edit transaction that began before an extraction and committed after
   * it sorts before it — a false fresh, said in the README's caveats.
   */
  contentMovedAfterExtraction: boolean;
  pool: PoolState;
};

export type Miss = "no-fingerprint" | "content" | "no-vector" | "unlabelled" | "model";
export const MISSES: readonly Miss[] = ["no-fingerprint", "content", "no-vector", "unlabelled", "model"];
export type Decision = "reuse" | `recompute:${Miss}`;

/**
 * The replay rule for one thought's vector. A row with no key is judged
 * first — nothing says what its vector is of, so a replay recomputes it,
 * and the census keeps "there is no key" apart from "the key moved". Then the
 * payload's fingerprint against the row's: a snapshot keyed by another text
 * is no snapshot of this one, whether the text was edited or the key went
 * stale around the writers. Then the vector's presence, then its label — NULL
 * is unknown and unknown is not the target (021's rule, reembed.ts's pool).
 */
export function decideEmbedding(row: Pick<ThoughtRow, "storedFingerprint" | "payloadFingerprint" | "model" | "hasVector">, target: string, payloadFingerprint = row.payloadFingerprint): Decision {
  if (row.storedFingerprint === null) return "recompute:no-fingerprint";
  if (row.storedFingerprint !== payloadFingerprint) return "recompute:content";
  if (!row.hasVector) return "recompute:no-vector";
  if (row.model === null) return "recompute:unlabelled";
  if (row.model !== target) return "recompute:model";
  return "reuse";
}

export type Tally = {
  total: number;
  reuse: number;
  recompute: Record<Miss, number>;
  /** The ids recomputed, in row order, so a report can name them. */
  recomputed: string[];
};

export const recomputed = (t: Tally): number => MISSES.reduce((n, m) => n + t.recompute[m], 0);
const emptyTally = (): Tally => ({ total: 0, reuse: 0, recompute: { "no-fingerprint": 0, content: 0, "no-vector": 0, unlabelled: 0, model: 0 }, recomputed: [] });

export function tally(rows: readonly ThoughtRow[], target: string, payloadOf: (r: ThoughtRow) => string = (r) => r.payloadFingerprint): Tally {
  const t = emptyTally();
  for (const r of rows) {
    t.total++;
    const d = decideEmbedding(r, target, payloadOf(r));
    if (d === "reuse") t.reuse++;
    else {
      t.recompute[d.slice("recompute:".length) as Miss]++;
      t.recomputed.push(r.id);
    }
  }
  return t;
}

// ── The scenarios ────────────────────────────────────────────────────────────

/** A. Nothing changed: every row's payload is its own text. */
export const noOpRebuild = (rows: readonly ThoughtRow[], target: string): Tally => tally(rows, target);

/**
 * B. N thoughts edited: their payloads derive a fingerprint no snapshot holds.
 * The brain is untouched; the edit is in the arithmetic. A real edit could
 * also land on ANOTHER row's text (a duplicate, which update_thought refuses
 * — 009/018), so the count here is the replay's, not the writer's.
 */
export function editedRebuild(rows: readonly ThoughtRow[], target: string, edited: ReadonlySet<string>): Tally {
  return tally(rows, target, (r) => (edited.has(r.id) ? `edited:${r.id}` : r.payloadFingerprint));
}

/** C. The embedding model changes: the target is another name, every label is the old one. */
export const modelBumpRebuild = (rows: readonly ThoughtRow[], other: string): Tally => tally(rows, other);

/** The name scenario C bumps to: any name that is not the brain's own label — checked, since a brain could be recorded at the first choice. */
export const BUMPED_MODEL = "another-model@1024";
export function bumpedName(target: string): string {
  return target === BUMPED_MODEL ? `${BUMPED_MODEL}-again` : BUMPED_MODEL;
}

/**
 * D. A comprehension-only change — a new extraction prompt version or model,
 * a new judge — touches the graph and the proposals, never the vector. This
 * is DERIVED from the contract, not observed: the vector's key carries no
 * extraction or judge key, so its tally is the no-op's by construction, and
 * the verdict's check on it holds the code to its own definition. The
 * graph's work is every thought re-read under the new key (016's convergence:
 * record_thought_entities replaces a thought's rows wholesale), counted in
 * thoughts and in the mention rows replaced.
 */
export function comprehensionOnlyRebuild(rows: readonly ThoughtRow[], target: string): { embedding: Tally; graph: { thoughts: number; mentionsReplaced: number } } {
  return { embedding: noOpRebuild(rows, target), graph: { thoughts: rows.length, mentionsReplaced: rows.reduce((n, r) => n + r.mentions, 0) } };
}

export type RecipeTally = {
  /** Every parent vector: a whole-content vector is not a function of the window (embed.ts). */
  parentsReused: number;
  /** Thoughts that hold chunk rows now — the rows any recipe change replaces, since no row records the recipe it was cut by (022). */
  chunkedNow: number;
  chunkRowsNow: number;
  /** Thoughts the CURRENT recipe windows — what a rebuild under it writes; the recipe a change would move to is not modelled. */
  wouldChunk: number;
  /**
   * A long thought whose whole-content call was refused holds its HEAD WINDOW
   * as its vector (change 27), and the server records nothing on the row to say
   * so (034 records it on a re-embed claim row). Such a parent IS a function of
   * the window and would need recomputing; how many there are cannot be read
   * from the schema, and this says so rather than guessing zero.
   */
  fallbackParentsUnknowable: true;
};

/** E. The window recipe changes (OB1_CHUNK_TOKENS, overlap, chunk_context): every chunk row goes, every parent stays. */
export function recipeChangeRebuild<T extends ThoughtRow>(rows: readonly T[], wouldChunk: (row: T) => boolean): RecipeTally {
  const chunked = rows.filter((r) => r.chunkRows > 0);
  return {
    parentsReused: rows.length,
    chunkedNow: chunked.length,
    chunkRowsNow: chunked.reduce((n, r) => n + r.chunkRows, 0),
    wouldChunk: rows.filter(wouldChunk).length,
    fallbackParentsUnknowable: true,
  };
}

export type StaleGraph = {
  thoughts: number;
  mentions: number;
  /** Under the recorded key: a pending or claimed row — the edit re-enqueued it (016) and the pass will refresh it. */
  queued: number;
  /** Under the recorded key: failed — the re-read after the edit gave up; the rows stay stale until --retry-failed. */
  failed: number;
  /** Under the recorded key: succeeded BEFORE the text moved — the move re-enqueued under another key, so this pass will not return to it. */
  succeededBefore: number;
  /** Under the recorded key: succeeded AFTER the text moved and the graph rows still predate it — the pass says done and the rows say otherwise. */
  succeededAfter: number;
  /** Under the recorded key: succeeded, and the row carries no finished_at to place it by. */
  succeededUnplaced: number;
  /** No row under the recorded key. */
  none: number;
  /** Of those not queued under the recorded key, how many are pending under another `extract:` key — which refreshes nothing under this one. */
  elsewhere: number;
};

/**
 * The graph projection's staleness today: rows extracted from text whose
 * fingerprint an edit has since moved, and whether the pool knows. The graph
 * row itself cannot say (no fingerprint on it — the "half recorded" verdict);
 * the audit says when the key moved, the claim table under the RECORDED key
 * whether a re-read is queued, gave up, finished before or after the move, or
 * was never asked.
 */
export function staleGraph(rows: readonly ThoughtRow[]): StaleGraph {
  const stale = rows.filter((r) => r.contentMovedAfterExtraction && r.mentions > 0);
  const queued = stale.filter((r) => r.pool.recorded === "pending" || r.pool.recorded === "claimed");
  return {
    thoughts: stale.length,
    mentions: stale.reduce((n, r) => n + r.mentions, 0),
    queued: queued.length,
    failed: stale.filter((r) => r.pool.recorded === "failed").length,
    succeededBefore: stale.filter((r) => r.pool.recorded === "succeeded" && r.pool.finished === "before").length,
    succeededAfter: stale.filter((r) => r.pool.recorded === "succeeded" && r.pool.finished === "after").length,
    succeededUnplaced: stale.filter((r) => r.pool.recorded === "succeeded" && r.pool.finished === null).length,
    none: stale.filter((r) => r.pool.recorded === "none").length,
    elsewhere: stale.filter((r) => !queued.includes(r) && r.pool.elsewhere).length,
  };
}

/** Every scenario from one set of rows, so the tallies a verdict compares were built on the same corpus. */
export function buildScenarios<T extends ThoughtRow>(rows: readonly T[], target: string, edited: ReadonlySet<string>, other: string, wouldChunk: (row: T) => boolean): Scenarios {
  const noOp = noOpRebuild(rows, target);
  const present = rows.filter((r) => edited.has(r.id)).map((r) => r.id);
  return {
    target,
    noOp,
    edited: { n: present.length, ids: present, alreadyMissed: present.filter((id) => noOp.recomputed.includes(id)).length, tally: editedRebuild(rows, target, edited) },
    modelBump: { other, tally: modelBumpRebuild(rows, other) },
    comprehensionOnly: comprehensionOnlyRebuild(rows, target),
    recipe: recipeChangeRebuild(rows, wouldChunk),
  };
}

// ── The cost sample ──────────────────────────────────────────────────────────

/**
 * A deterministic sample spread over the length distribution: the rows sorted
 * by length then id, n of them taken at even ranks, the shortest and the
 * longest always among them. No random draw, so two runs sample the same rows
 * and the number is reproducible on an unchanged brain. It is a spread, not a
 * draw from the corpus's own histogram: the extremes weigh 1/n here and 1/rows
 * there, which is why the cost model also prices the sample without them.
 */
export function stratifiedSample<T extends { id: string; chars: number }>(rows: readonly T[], n: number): T[] {
  const sorted = [...rows].sort((a, b) => a.chars - b.chars || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (n <= 0 || sorted.length === 0) return [];
  if (n >= sorted.length) return sorted;
  if (n === 1) return [sorted[0]];
  const out: T[] = [];
  const seen = new Set<number>();
  for (let k = 0; k < n; k++) {
    const rank = Math.round((k * (sorted.length - 1)) / (n - 1));
    if (!seen.has(rank)) { seen.add(rank); out.push(sorted[rank]); }
  }
  return out;
}

export type Sample = {
  id: string;
  chars: number;
  /** What the replay would do with this row; the reproducibility bar is taken over the reused ones only. */
  decision: Decision;
  /** Windows the real embedder cut (0 for a thought embedded in one call). */
  windows: number;
  /** Provider calls the embedder made: one, or one plus a window each. */
  calls: number;
  ms: number;
  /** The fresh parent vector against the stored one. NULL when the row had no vector to compare, or the widths differ. */
  cosineToStored: number | null;
  /** The fresh vector's width is not the stored one's — the provider answered at another width than the column's; nothing to compare, and a defect. */
  widthMismatch: boolean;
  /** The fresh window vectors against the stored chunk rows by index, the least of them; NULL when there were none to compare. */
  windowCosineMin: number | null;
  windowsCompared: number;
  /** The fresh cut has a different number of windows than the stored chunk rows — the recipe moved (022 records none), and index-by-index comparison says nothing. */
  windowCountMismatch: boolean;
  fellBack: boolean;
};

/** Fewer sampled rows than this and the two extreme ranks are most of the sample: nothing is trimmed, and the report says so. */
export const MIN_TRIM_ROWS = 5;

export type CostModel = {
  sampled: number;
  sampledChars: number;
  sampledWindowed: number;
  /** The corpus's own share of windowed thoughts, beside the sample's — the sample over-represents long rows by design. */
  corpusWindowedShare: number;
  medianMsPerRow: number;
  meanMsPerRow: number;
  /** The mean without the two extreme ranks (the sample gives each 1/n of the weight the corpus gives 1/rows); the plain mean under MIN_TRIM_ROWS. */
  meanMsPerRowTrimmed: number;
  /** Rows the trimmed mean is over. */
  trimmedRows: number;
  /** The longest sampled row's share of the sample's wall-clock — the leverage the trimmed mean removes. */
  longestShare: number;
  /** Total ms over total thousand characters — the rate a whole corpus is priced at. */
  msPerKChar: number;
  /** Scenario C priced three ways, seconds: rows × the mean row, rows × the trimmed mean, and chars × the rate. */
  modelBumpSecondsByRows: number;
  modelBumpSecondsTrimmed: number;
  modelBumpSecondsByChars: number;
  /** Scenario B: the edits counted × the mean row. */
  editSeconds: number;
  /** Fresh against stored over the REUSED rows that had a vector of the same width. */
  reusedCompared: number;
  minCosine: number | null;
  medianCosine: number | null;
  /** 1 − minCosine, the gap the four-decimal print cannot show. */
  maxGap: number | null;
  /** Reused rows whose fresh vector came back at another width than the stored one. */
  widthMismatches: number;
  /** The window vectors' least cosine over the reused rows that had chunk rows, how many windows that covered, and the gap the print cannot show. */
  windowsCompared: number;
  windowMinCosine: number | null;
  windowMaxGap: number | null;
  /** Reused rows whose fresh cut had a different number of windows than the stored chunk rows. */
  windowCountMismatches: number;
  fellBack: number;
};

/**
 * The cost of a rebuild per scenario from a measured sample and the corpus's
 * size. Three extrapolations for the model bump, because the sample is spread
 * by length on purpose: by rows it weights every row the same, trimmed it
 * drops the two ranks the spread over-weights, by characters it follows the
 * text; the corpus's own length distribution decides which is closest. All
 * are printed; none is hidden behind another. The reproducibility figures are
 * over the rows the replay would REUSE — a recomputed row's stored vector is
 * of other text or another model and says nothing about the key.
 */
export function costModel(samples: readonly Sample[], corpus: { rows: number; chars: number; windowed: number }, edits: number): CostModel {
  const ms = samples.map((s) => s.ms);
  const chars = samples.reduce((n, s) => n + s.chars, 0);
  const sum = ms.reduce((a, b) => a + b, 0);
  const mean = ms.length ? sum / ms.length : NaN;
  const sortedByChars = [...samples].sort((a, b) => a.chars - b.chars);
  const trimmedSamples = sortedByChars.length >= MIN_TRIM_ROWS ? sortedByChars.slice(1, -1) : sortedByChars;
  const trimmed = trimmedSamples.length ? trimmedSamples.reduce((a, s) => a + s.ms, 0) / trimmedSamples.length : NaN;
  const longest = sortedByChars.at(-1);
  const perK = chars > 0 ? sum / (chars / 1000) : NaN;
  const reused = samples.filter((s) => s.decision === "reuse");
  const compared = reused.filter((s) => s.cosineToStored !== null);
  const cos = compared.map((s) => s.cosineToStored as number);
  const windowed = reused.filter((s) => s.windowCosineMin !== null);
  return {
    sampled: samples.length,
    sampledChars: chars,
    sampledWindowed: samples.filter((s) => s.windows > 0).length,
    corpusWindowedShare: corpus.rows ? corpus.windowed / corpus.rows : 0,
    medianMsPerRow: median(ms),
    meanMsPerRow: mean,
    meanMsPerRowTrimmed: trimmed,
    trimmedRows: trimmedSamples.length,
    longestShare: longest && sum > 0 ? longest.ms / sum : NaN,
    msPerKChar: perK,
    modelBumpSecondsByRows: (mean * corpus.rows) / 1000,
    modelBumpSecondsTrimmed: (trimmed * corpus.rows) / 1000,
    modelBumpSecondsByChars: (perK * (corpus.chars / 1000)) / 1000,
    editSeconds: (mean * edits) / 1000,
    reusedCompared: cos.length,
    minCosine: cos.length ? Math.min(...cos) : null,
    medianCosine: cos.length ? median(cos) : null,
    maxGap: cos.length ? 1 - Math.min(...cos) : null,
    widthMismatches: reused.filter((s) => s.widthMismatch).length,
    windowsCompared: windowed.reduce((n, s) => n + s.windowsCompared, 0),
    windowMinCosine: windowed.length ? Math.min(...windowed.map((s) => s.windowCosineMin as number)) : null,
    windowMaxGap: windowed.length ? 1 - Math.min(...windowed.map((s) => s.windowCosineMin as number)) : null,
    windowCountMismatches: reused.filter((s) => s.windowCountMismatch).length,
    fellBack: samples.filter((s) => s.fellBack).length,
  };
}

/** One pass key's seconds per row as the claim log measured it (finished_at − claimed_at over succeeded rows, under the pass's own worker count). */
export type ClaimStat = { key: string; n: number; medianS: number; meanS: number };

/** What a comprehension-only rebuild costs per key, one row after another, from the log's own per-row figure. */
export function graphCost(stats: readonly ClaimStat[], thoughts: number): { key: string; n: number; medianS: number; rebuildHoursSequential: number }[] {
  return stats.map((s) => ({ key: s.key, n: s.n, medianS: s.medianS, rebuildHoursSequential: (s.medianS * thoughts) / 3600 }));
}

/** The graph's own passes are the `extract:` keys; the judge's and a re-embed's rows are other projections' and are shown apart. */
export const isGraphPass = (key: string): boolean => key.startsWith("extract:");

// ── The verdict ──────────────────────────────────────────────────────────────

/** A. reuse at or above this share of the rows, or the key is not doing its job. Pre-registered. */
export const MIN_REUSE = 0.99;
/**
 * A reused row whose fresh vector sits below this cosine to its stored one is a
 * vector that is NOT a function of its key — the recipe moved without the key
 * moving, or the provider does not reproduce itself — and that is the one
 * defect the key cannot express. Added to the contract after the ticket
 * comment and before the first run, and said so in the fragment. Held over
 * the parent vectors and over the window vectors alike.
 */
export const REPRO_COSINE = 0.99;

export type Scenarios = {
  target: string;
  noOp: Tally;
  /** The edited ids present in the corpus, how many of them the no-op already recomputed, and the tally. */
  edited: { n: number; ids: string[]; alreadyMissed: number; tally: Tally };
  modelBump: { other: string; tally: Tally };
  comprehensionOnly: ReturnType<typeof comprehensionOnlyRebuild>;
  recipe: RecipeTally;
};

export type Verdict = { go: boolean; provisional: boolean; reasons: string[] };

export function verdict(s: Scenarios, cost: CostModel | null): Verdict {
  const reasons: string[] = [];
  const a = s.noOp;
  const share = a.total ? a.reuse / a.total : 0;
  if (a.total === 0) reasons.push("NO-GO: no live thought to replay");
  else if (share < MIN_REUSE) reasons.push(`NO-GO: the no-op rebuild reuses ${a.reuse}/${a.total} (${(share * 100).toFixed(1)}%), under the ${MIN_REUSE * 100}% bar — misses: ${describeMisses(a)}`);
  else reasons.push(`A: the no-op rebuild reuses ${a.reuse}/${a.total}${recomputed(a) ? ` — misses the key states: ${describeMisses(a)}` : ""} (each row against its own text; the log as the payload is out of scope, see the log line)`);

  // An edited row is a content miss in B whatever it was in A, so one that A
  // already recomputed is counted once, not twice: the rows beyond the no-op
  // are the edits A reused. Every edited id must be among the recomputed, and
  // nothing else may move. The edit is simulated, so this holds the rule to
  // itself as D does — the rows moved are the arithmetic's, not a writer's.
  const b = s.edited.tally;
  const expected = recomputed(a) + s.edited.n - s.edited.alreadyMissed;
  const everyEdited = s.edited.ids.every((id) => b.recomputed.includes(id));
  if (recomputed(b) !== expected || !everyEdited) reasons.push(`NO-GO: ${s.edited.n} edits (${s.edited.alreadyMissed} already a miss) recompute ${recomputed(b)}, not exactly ${expected} — ${everyEdited ? "a row the edits did not touch moved" : "an edited row was not recomputed"}`);
  else reasons.push(`B (simulated): ${s.edited.n} edits${s.edited.alreadyMissed ? ` (${s.edited.alreadyMissed} already a miss in A)` : ""} recompute exactly ${s.edited.n - s.edited.alreadyMissed} beyond the no-op's ${recomputed(a)}; ${b.reuse} reused`);

  const c = s.modelBump.tally;
  if (c.reuse !== 0) reasons.push(`NO-GO: a model bump reuses ${c.reuse} vectors labelled another model`);
  else reasons.push(`C: a model bump recomputes ${recomputed(c)}/${c.total}${cost ? `, ${fmtSeconds(cost.modelBumpSecondsByRows)} by rows (${fmtSeconds(cost.modelBumpSecondsTrimmed)} ${trimNote(cost)}) / ${fmtSeconds(cost.modelBumpSecondsByChars)} by characters at the measured rate` : " — cost not measured this run"}`);

  const d = s.comprehensionOnly;
  if (recomputed(d.embedding) !== recomputed(a)) reasons.push(`NO-GO: a comprehension-only change recomputes ${recomputed(d.embedding)} embeddings where the no-op recomputes ${recomputed(a)}`);
  else reasons.push(`D (derived, not observed): the vector's key carries no extraction or judge key, so a comprehension-only change recomputes no vector beyond the no-op's ${recomputed(a)}; the graph re-reads ${d.graph.thoughts} thoughts (${d.graph.mentionsReplaced} mention rows replaced)`);

  reasons.push(`E: a window-recipe change replaces ${s.recipe.chunkRowsNow} chunk rows under ${s.recipe.chunkedNow} thoughts (${s.recipe.wouldChunk} the current recipe windows) and reuses ${s.recipe.parentsReused} parents — less any head-window fallback, which the row does not record`);

  let provisional = false;
  if (cost) {
    if (cost.widthMismatches > 0) reasons.push(`NO-GO: ${cost.widthMismatches} reused row(s) came back at another width than the stored vector's — the provider answers at a width the column does not hold, and nothing was compared`);
    if (cost.minCosine === null) { if (cost.widthMismatches === 0) { provisional = true; reasons.push("provisional: no reused row with a stored vector was in the sample, so the reproducibility bar was not applied"); } }
    else if (!Number.isFinite(cost.minCosine)) reasons.push("NO-GO: a reused row's fresh vector has no cosine to its stored one (a zero or mismatched vector)");
    else if (cost.minCosine < REPRO_COSINE) reasons.push(`NO-GO: a reused row's fresh vector sits at cosine ${cost.minCosine.toFixed(4)} to its stored one (bar ${REPRO_COSINE}) — the vector is not a function of its key`);
    else reasons.push(`the cached value reproduces: fresh against stored over ${cost.reusedCompared} reused rows, min cosine ${cost.minCosine.toFixed(4)} (1−cos ${fmtGap(cost.maxGap)}), median ${cost.medianCosine!.toFixed(4)}`);
    if (cost.windowCountMismatches > 0) reasons.push(`NO-GO: ${cost.windowCountMismatches} reused row(s) cut to a different number of windows than their stored chunk rows — the window recipe moved without the key moving (022 records none), and index-by-index says nothing`);
    if (cost.windowMinCosine === null) reasons.push(`window vectors: none compared${cost.windowsCompared || cost.sampledWindowed ? "" : " (no windowed thought in the sample)"} — the bar over the chunk rows was not applied`);
    else if (!Number.isFinite(cost.windowMinCosine)) reasons.push("NO-GO: a reused row's fresh window vector has no cosine to its stored chunk row (a zero or mismatched vector)");
    else if (cost.windowMinCosine < REPRO_COSINE) reasons.push(`NO-GO: a reused row's fresh window vector sits at cosine ${cost.windowMinCosine.toFixed(4)} to its stored chunk row (bar ${REPRO_COSINE}) — the window recipe moved without the key moving`);
    else reasons.push(`window vectors: ${cost.windowsCompared} compared against the stored chunk rows, min cosine ${cost.windowMinCosine.toFixed(4)} (1−cos ${fmtGap(cost.windowMaxGap)})`);
  } else {
    provisional = true;
    reasons.push("provisional: no provider ran, so the cost and the reproducibility of the cached value are not measured");
  }
  const go = !reasons.some((r) => r.startsWith("NO-GO"));
  return { go, provisional, reasons };
}

export function trimNote(cost: CostModel): string {
  return cost.trimmedRows < cost.sampled ? `over the ${cost.trimmedRows} rows between the extremes` : `untrimmed: under ${MIN_TRIM_ROWS} rows`;
}

export function describeMisses(t: Tally): string {
  return MISSES.filter((m) => t.recompute[m] > 0).map((m) => `${m} ${t.recompute[m]}`).join(", ") || "none";
}

export function fmtSeconds(s: number): string {
  if (!Number.isFinite(s)) return "?";
  if (s < 90) return `${s.toFixed(1)} s`;
  if (s < 5400) return `${(s / 60).toFixed(1)} min`;
  return `${(s / 3600).toFixed(2)} h`;
}

/** 1 − cos in exponential form; `0` when the two are equal to the last bit, or the cosine sits a rounding above 1. */
export function fmtGap(gap: number | null): string {
  if (gap === null || !Number.isFinite(gap)) return "?";
  return gap <= 0 ? "0" : gap.toExponential(1);
}

/** Characters at the unit that reads: a small brain is not "0.00 M". */
export function fmtChars(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)} M chars`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)} k chars`;
  return `${n} chars`;
}

// ── The report ───────────────────────────────────────────────────────────────

export type Census = {
  thoughts: number;
  chars: number;
  withVector: number;
  byModel: { model: string | null; n: number }[];
  fingerprintAgrees: number;
  fingerprintNull: number;
  chunkedThoughts: number;
  chunkRows: number;
  mentions: number;
  edges: number;
  proposals: number;
  /** contentUpdates moved the text; keyUpdates moved content_fingerprint_of(text) — 003 collapses whitespace, so the two can differ. bytes is the table with its TOAST, no indexes. */
  audit: { capture: number; update: number; delete: number; contentUpdates: number; keyUpdates: number; liveWithContentEvent: number; bytes: number };
  config: Record<string, string>;
};

export type Observation = {
  at: string;
  census: Census;
  scenarios: Scenarios;
  stale: StaleGraph;
  claims: ClaimStat[];
  samples: Sample[] | null;
  cost: CostModel | null;
  provider: string | null;
  verdict: Verdict;
};

const pct = (n: number, of: number): string => (of ? `${((100 * n) / of).toFixed(1)}%` : "—");

export function renderReport(o: Observation): string {
  const L: string[] = [];
  const c = o.census;
  L.push(`Projection replay — SMD-1998 — ${o.at}`);
  L.push("");
  L.push(`corpus: ${c.thoughts} thoughts, ${fmtChars(c.chars)}; ${c.withVector} with a vector (${c.byModel.map((m) => `${m.model ?? "<unlabelled>"} ${m.n}`).join(", ") || "none"}); content_fingerprint = content_fingerprint_of(content) on ${c.fingerprintAgrees}/${c.thoughts}, NULL on ${c.fingerprintNull}; ${c.chunkedThoughts} windowed (${c.chunkRows} chunk rows); chunk_context ${c.config.chunk_context ?? "?"}; target ${o.scenarios.target}@${c.config.embedding_dim ?? "?"}`);
  L.push(`log: ${c.audit.capture} capture / ${c.audit.update} update / ${c.audit.delete} delete rows (${(c.audit.bytes / 1e6).toFixed(1)} MB table and TOAST); ${c.audit.contentUpdates} updates moved content, ${c.audit.keyUpdates} of them the fingerprint; the log holds content for ${c.audit.liveWithContentEvent}/${c.thoughts} live thoughts (a capture row carries metadata, not content — 008)`);
  L.push(`graph: ${c.mentions} model mentions (a source: pass's rows apart), ${c.edges} edges; ${o.stale.thoughts} thought(s) with ${o.stale.mentions} mention rows extracted before their fingerprint last moved — under the recorded key ${c.config.entity_extraction_key || "(none)"}: ${o.stale.queued} queued for a re-read, ${o.stale.failed} failed (terminal until --retry-failed), ${o.stale.succeededBefore} succeeded before the move (re-enqueued under another key), ${o.stale.succeededAfter} succeeded after it with the rows still older, ${o.stale.succeededUnplaced} succeeded with no stamp to place, ${o.stale.none} never asked; ${o.stale.elsewhere} of the unqueued pending under another key, which refreshes nothing here; ${c.proposals} proposals`);
  L.push("");
  L.push("the snapshot key per projection (the contract):");
  const w = Math.max(...PROJECTIONS.map((p) => p.table.length));
  for (const p of PROJECTIONS) L.push(`  ${p.table.padEnd(w)}  ${p.verdict.padEnd(19)}  derived ${p.derived}; recorded: ${p.recorded}`);
  L.push("");
  L.push("scenario                         reuse      recompute  by reason");
  L.push("─".repeat(78));
  const s = o.scenarios;
  const row = (label: string, t: Tally) => L.push(`${label.padEnd(32)} ${String(t.reuse).padStart(5)} ${pct(t.reuse, t.total).padStart(7)}  ${String(recomputed(t)).padStart(9)}  ${describeMisses(t)}`);
  row("A no-op rebuild", s.noOp);
  row(`B ${s.edited.n} edits${s.edited.alreadyMissed ? ` (${s.edited.alreadyMissed} already a miss)` : ""}`, s.edited.tally);
  row(`C model bump → ${s.modelBump.other}`, s.modelBump.tally);
  row("D comprehension-only (embedding)", s.comprehensionOnly.embedding);
  L.push(`${"D comprehension-only (graph)".padEnd(32)} ${"—".padStart(5)} ${"".padStart(7)}  ${String(s.comprehensionOnly.graph.thoughts).padStart(9)}  thoughts re-read, ${s.comprehensionOnly.graph.mentionsReplaced} mention rows replaced`);
  L.push(`${"E window recipe".padEnd(32)} ${String(s.recipe.parentsReused).padStart(5)} ${"parents".padStart(7)}  ${String(s.recipe.chunkRowsNow).padStart(9)}  chunk rows under ${s.recipe.chunkedNow} thought(s); ${s.recipe.wouldChunk} the current recipe windows; head-window fallbacks unrecorded`);
  L.push("");
  if (o.cost && o.samples) {
    const k = o.cost;
    L.push(`cost — ${k.sampled} rows embedded through the real embedder (${o.provider}), ${fmtChars(k.sampledChars)}, one at a time, nothing else running; ${k.sampledWindowed} of them windowed (the corpus: ${pct(Math.round(k.corpusWindowedShare * c.thoughts), c.thoughts)}):`);
    L.push(`  per row: median ${(k.medianMsPerRow / 1000).toFixed(2)} s, mean ${(k.meanMsPerRow / 1000).toFixed(2)} s, mean ${trimNote(k)} ${(k.meanMsPerRowTrimmed / 1000).toFixed(2)} s (the longest row is ${pct(k.longestShare, 1)} of the sample's wall-clock); ${(k.msPerKChar / 1000).toFixed(3)} s per 1k chars; ${k.fellBack} fell back to a head window`);
    L.push(`  steady state (A): 0 calls. typical (B, ${s.edited.n} edits): ${fmtSeconds(k.editSeconds)}. worst (C, ${c.thoughts} rows): ${fmtSeconds(k.modelBumpSecondsByRows)} by rows, ${fmtSeconds(k.modelBumpSecondsTrimmed)} trimmed, ${fmtSeconds(k.modelBumpSecondsByChars)} by characters`);
    L.push(`  the cached value against a fresh one, over the ${k.reusedCompared} reused rows: min cosine ${k.minCosine === null ? "—" : k.minCosine.toFixed(4)} (1−cos ${fmtGap(k.maxGap)}), median ${k.medianCosine === null ? "—" : k.medianCosine.toFixed(4)}; ${k.widthMismatches} at another width; window vectors: ${k.windowsCompared} compared${k.windowMinCosine === null ? "" : `, min cosine ${k.windowMinCosine.toFixed(4)} (1−cos ${fmtGap(k.windowMaxGap)})`}, ${k.windowCountMismatches} row(s) cut to another count`);
    L.push("  id                                    decision  chars  windows  calls     s   cosine   1−cos    windows-min");
    for (const x of o.samples) L.push(`  ${x.id}  ${x.decision.replace("recompute:", "").padEnd(8)}  ${String(x.chars).padStart(5)}  ${String(x.windows).padStart(7)}  ${String(x.calls).padStart(5)}  ${(x.ms / 1000).toFixed(2).padStart(5)}  ${x.cosineToStored === null ? (x.widthMismatch ? " width" : "     —") : x.cosineToStored.toFixed(4)}   ${x.cosineToStored === null ? "—".padEnd(7) : fmtGap(1 - x.cosineToStored).padEnd(7)}  ${x.windowCosineMin === null ? (x.windowCountMismatch ? "count differs" : "—") : `${x.windowCosineMin.toFixed(4)} over ${x.windowsCompared}${x.windowCountMismatch ? ", count differs" : ""}`}${x.fellBack ? "  head window" : ""}`);
  } else {
    L.push("cost — not measured this run (--no-provider): the scenarios above are counts; the seconds need the provider");
  }
  const graphClaims = o.claims.filter((k) => isGraphPass(k.key));
  const otherClaims = o.claims.filter((k) => !isGraphPass(k.key));
  if (graphClaims.length) {
    L.push("");
    L.push("the graph's own cost, from the claim log (finished_at − claimed_at over succeeded rows, as the pass ran them — --workers 2 by default, so under its own contention), and a full re-read one row after another at that rate:");
    for (const g of graphCost(graphClaims, c.thoughts)) L.push(`  ${g.key.padEnd(28)} n ${String(g.n).padStart(4)}  median ${g.medianS.toFixed(1).padStart(6)} s/row  → ${c.thoughts} thoughts ≈ ${g.rebuildHoursSequential.toFixed(1)} h`);
  }
  if (otherClaims.length) {
    L.push("");
    L.push("other passes' rows in the claim log, for scale (a thought judged by the consolidation pass; a row re-embedded), not the graph's:");
    for (const g of graphCost(otherClaims, c.thoughts)) L.push(`  ${g.key.padEnd(28)} n ${String(g.n).padStart(4)}  median ${g.medianS.toFixed(1).padStart(6)} s/row  → ${c.thoughts} thoughts ≈ ${g.rebuildHoursSequential.toFixed(1)} h`);
  }
  L.push("");
  L.push(`verdict: ${o.verdict.go ? "GO" : "NO-GO"}${o.verdict.provisional ? " (provisional)" : ""}`);
  for (const r of o.verdict.reasons) L.push(`  ${r}`);
  return L.join("\n");
}
