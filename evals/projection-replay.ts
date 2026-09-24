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
 * the payload's fingerprint against the row's, the row's model label against
 * the target, a vector present or not — reuse on a hit, recompute on a miss,
 * every miss with a reason the key can state. The scenarios are the ticket's:
 * a no-op rebuild, N edits, a model bump, a comprehension-only change, a
 * window-recipe change. Nothing here reads a database or calls a provider;
 * eval-projection-replay.ts --self-check probes every rule with hand-known
 * rows.
 */

// ── The contract ─────────────────────────────────────────────────────────────

export type ProjectionName = "embedding" | "chunks" | "graph" | "proposals" | "metadata";
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

/** The snapshot key per projection, as the schema records it on 2026-09-24 (migrations to 052). */
export const PROJECTIONS: readonly Projection[] = [
  { name: "embedding", table: "thoughts.embedding", derived: "(content_fingerprint_of(content), embedding_model) — the template is the model's (embed.ts), the width the column's", recorded: "content_fingerprint (003/023), embedding_model (021)", verdict: "recorded" },
  { name: "chunks", table: "thought_chunks", derived: "the parent's key + the window recipe (chunk tokens, overlap, chunk_context, the blurb model)", recorded: "the parent's label vouches for the rows (022); no recipe", verdict: "recipe not recorded" },
  { name: "graph", table: "thought_entities / ob1_entity_edges", derived: "(content_fingerprint, extraction_key)", recorded: "extraction_key, extracted_at; no fingerprint — staleness after an edit is read from the audit", verdict: "half recorded" },
  { name: "proposals", table: "supersession_proposals", derived: "(older_fingerprint, newer_fingerprint, judge_key)", recorded: "all three (029)", verdict: "recorded" },
  { name: "metadata", table: "thoughts.metadata (type, topics, people)", derived: "(content_fingerprint, metadata model, prompt version)", recorded: "nothing", verdict: "unkeyed" },
];

export const KEY_VERDICTS: readonly KeyVerdict[] = ["recorded", "recipe not recorded", "half recorded", "unkeyed"];

// ── The rows ─────────────────────────────────────────────────────────────────

/** One live thought as the replay sees it: the payload's key beside the row's. */
export type ThoughtRow = {
  id: string;
  chars: number;
  /** thoughts.content_fingerprint — the snapshot's key. */
  storedFingerprint: string | null;
  /** content_fingerprint_of(content) — the key the payload derives, by the SQL rule's owner (016). */
  payloadFingerprint: string;
  /** thoughts.embedding_model; NULL is a vector of unknown model (021). */
  model: string | null;
  hasVector: boolean;
  chunkRows: number;
  mentions: number;
  extractionKeys: string[];
  /** An update event that moved the FINGERPRINT landed after the latest extraction: the graph rows describe text whose key is gone. */
  contentMovedAfterExtraction: boolean;
  /**
   * Where the thought stands in the extraction pool, under any `extract:` key:
   * `queued` (a pending or claimed row — the edit re-enqueued it, 016), `failed`
   * (every row terminal-failed: the retry after the edit gave up, and the rows
   * stay stale until --retry-failed), `none` (no row says anything).
   */
  extractionQueue: "queued" | "failed" | "none";
};

export type Miss = "content" | "no-vector" | "unlabelled" | "model";
export const MISSES: readonly Miss[] = ["content", "no-vector", "unlabelled", "model"];
export type Decision = "reuse" | `recompute:${Miss}`;

/**
 * The replay rule for one thought's vector. The payload's fingerprint is
 * compared first: a snapshot keyed by another text is no snapshot of this one,
 * whether the text was edited or the row's key went stale (018's
 * fingerprint_held_by case). Then the vector's presence, then its label — NULL
 * is unknown and unknown is not the target (021's rule, reembed.ts's pool).
 */
export function decideEmbedding(row: Pick<ThoughtRow, "storedFingerprint" | "payloadFingerprint" | "model" | "hasVector">, target: string, payloadFingerprint = row.payloadFingerprint): Decision {
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
export const emptyTally = (): Tally => ({ total: 0, reuse: 0, recompute: { content: 0, "no-vector": 0, unlabelled: 0, model: 0 }, recomputed: [] });

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

/** B. N thoughts edited: their payloads derive a fingerprint no snapshot holds. The brain is untouched; the edit is in the arithmetic. */
export function editedRebuild(rows: readonly ThoughtRow[], target: string, edited: ReadonlySet<string>): Tally {
  return tally(rows, target, (r) => (edited.has(r.id) ? `edited:${r.id}` : r.payloadFingerprint));
}

/** C. The embedding model changes: the target is another name, every label is the old one. */
export const modelBumpRebuild = (rows: readonly ThoughtRow[], other: string): Tally => tally(rows, other);

/**
 * D. A comprehension-only change — a new extraction prompt version or model,
 * a new judge — touches the graph and the proposals, never the vector. The
 * embedding tally is the no-op's; the graph's work is every thought re-read
 * under the new key (016's convergence: record_thought_entities replaces a
 * thought's rows wholesale), counted in thoughts and in the mention rows
 * replaced.
 */
export function comprehensionOnlyRebuild(rows: readonly ThoughtRow[], target: string): { embedding: Tally; graph: { thoughts: number; mentionsReplaced: number } } {
  return { embedding: noOpRebuild(rows, target), graph: { thoughts: rows.length, mentionsReplaced: rows.reduce((n, r) => n + r.mentions, 0) } };
}

export type RecipeTally = {
  /** Every parent vector: a whole-content vector is not a function of the window (embed.ts). */
  parentsReused: number;
  /** Thoughts that hold chunk rows now — the rows a recipe change replaces. */
  chunkedNow: number;
  chunkRowsNow: number;
  /** Thoughts the given recipe would window — the rows it writes. */
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

/** E. The window recipe changes (OB1_CHUNK_TOKENS, overlap, chunk_context): chunk rows go, parents stay. */
export function recipeChangeRebuild(rows: readonly ThoughtRow[], wouldChunk: (row: ThoughtRow) => boolean): RecipeTally {
  const chunked = rows.filter((r) => r.chunkRows > 0);
  return {
    parentsReused: rows.length,
    chunkedNow: chunked.length,
    chunkRowsNow: chunked.reduce((n, r) => n + r.chunkRows, 0),
    wouldChunk: rows.filter(wouldChunk).length,
    fallbackParentsUnknowable: true,
  };
}

export type StaleGraph = { thoughts: number; mentions: number; queued: number; failed: number; unqueued: number };

/**
 * The graph projection's staleness today: rows extracted from text whose
 * fingerprint an edit has since moved, and whether the pool knows. The graph
 * row itself cannot say (no fingerprint on it — the "half recorded" verdict);
 * the audit says when the key moved, the claim table whether a re-read is
 * queued, gave up, or was never asked.
 */
export function staleGraph(rows: readonly ThoughtRow[]): StaleGraph {
  const stale = rows.filter((r) => r.contentMovedAfterExtraction && r.mentions > 0);
  return {
    thoughts: stale.length,
    mentions: stale.reduce((n, r) => n + r.mentions, 0),
    queued: stale.filter((r) => r.extractionQueue === "queued").length,
    failed: stale.filter((r) => r.extractionQueue === "failed").length,
    unqueued: stale.filter((r) => r.extractionQueue === "none").length,
  };
}

// ── The cost sample ──────────────────────────────────────────────────────────

/**
 * A deterministic sample spread over the length distribution: the rows sorted
 * by length then id, n of them taken at even ranks, the shortest and the
 * longest always among them. No random draw, so two runs sample the same rows
 * and the number is reproducible on an unchanged brain.
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
  /** Windows the real embedder cut (0 for a thought embedded in one call). */
  windows: number;
  /** Provider calls the embedder made: one, or one plus a window each. */
  calls: number;
  ms: number;
  /** The fresh vector against the stored one — how reproducible the cached value is. NULL when the row had no vector to compare. */
  cosineToStored: number | null;
  fellBack: boolean;
};

export const median = (xs: readonly number[]): number => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

export type CostModel = {
  sampled: number;
  sampledChars: number;
  medianMsPerRow: number;
  meanMsPerRow: number;
  /** Total ms over total thousand characters — the rate a whole corpus is priced at. */
  msPerKChar: number;
  /** Scenario C priced two ways, seconds: rows × the mean row, and chars × the rate. */
  modelBumpSecondsByRows: number;
  modelBumpSecondsByChars: number;
  /** Scenario B: N edits × the mean row. */
  editSeconds: number;
  /** Fresh against stored, over the rows that had a vector. */
  minCosine: number | null;
  medianCosine: number | null;
  fellBack: number;
};

/**
 * The cost of a rebuild per scenario from a measured sample and the corpus's
 * size. Two extrapolations for the model bump, because the sample is spread
 * by length on purpose: by rows it weights every row the same, by characters it
 * follows the text, and the corpus's own length distribution decides which is
 * closer. Both are printed; neither is hidden behind the other.
 */
export function costModel(samples: readonly Sample[], corpus: { rows: number; chars: number }, editN: number): CostModel {
  const ms = samples.map((s) => s.ms);
  const chars = samples.reduce((n, s) => n + s.chars, 0);
  const mean = ms.length ? ms.reduce((a, b) => a + b, 0) / ms.length : NaN;
  const perK = chars > 0 ? ms.reduce((a, b) => a + b, 0) / (chars / 1000) : NaN;
  const cos = samples.map((s) => s.cosineToStored).filter((c): c is number => c !== null);
  return {
    sampled: samples.length,
    sampledChars: chars,
    medianMsPerRow: median(ms),
    meanMsPerRow: mean,
    msPerKChar: perK,
    modelBumpSecondsByRows: (mean * corpus.rows) / 1000,
    modelBumpSecondsByChars: (perK * (corpus.chars / 1000)) / 1000,
    editSeconds: (mean * editN) / 1000,
    minCosine: cos.length ? Math.min(...cos) : null,
    medianCosine: cos.length ? median(cos) : null,
    fellBack: samples.filter((s) => s.fellBack).length,
  };
}

/** One pass key's seconds per row as the claim log measured it (finished_at − claimed_at over succeeded rows). */
export type ClaimStat = { key: string; n: number; medianS: number; meanS: number };

/** What a comprehension-only rebuild costs per key, sequentially, from the log's own per-row figure. */
export function graphCost(stats: readonly ClaimStat[], thoughts: number): { key: string; n: number; medianS: number; rebuildHoursSequential: number }[] {
  return stats.map((s) => ({ key: s.key, n: s.n, medianS: s.medianS, rebuildHoursSequential: (s.medianS * thoughts) / 3600 }));
}

// ── The verdict ──────────────────────────────────────────────────────────────

/** A. reuse at or above this share of the rows, or the key is not doing its job. Pre-registered. */
export const MIN_REUSE = 0.99;
/**
 * A reused row whose fresh vector sits below this cosine to its stored one is a
 * vector that is NOT a function of its key — the recipe moved without the key
 * moving, or the provider does not reproduce itself — and that is the one
 * defect the key cannot express. Added to the contract after the ticket
 * comment and before the first run, and said so in the fragment.
 */
export const REPRO_COSINE = 0.99;

export type Scenarios = {
  target: string;
  noOp: Tally;
  edited: { n: number; tally: Tally };
  modelBump: { other: string; tally: Tally };
  comprehensionOnly: ReturnType<typeof comprehensionOnlyRebuild>;
  recipe: RecipeTally;
};

/** Every scenario from one set of rows, so the tallies a verdict compares were built on the same corpus. */
export function buildScenarios(rows: readonly ThoughtRow[], target: string, edited: ReadonlySet<string>, other: string, wouldChunk: (row: ThoughtRow) => boolean): Scenarios {
  return {
    target,
    noOp: noOpRebuild(rows, target),
    edited: { n: rows.filter((r) => edited.has(r.id)).length, tally: editedRebuild(rows, target, edited) },
    modelBump: { other, tally: modelBumpRebuild(rows, other) },
    comprehensionOnly: comprehensionOnlyRebuild(rows, target),
    recipe: recipeChangeRebuild(rows, wouldChunk),
  };
}

export type Verdict = { go: boolean; provisional: boolean; reasons: string[] };

export function verdict(s: Scenarios, cost: CostModel | null): Verdict {
  const reasons: string[] = [];
  const a = s.noOp;
  const share = a.total ? a.reuse / a.total : 0;
  if (a.total === 0) reasons.push("NO-GO: no live thought to replay");
  else if (share < MIN_REUSE) reasons.push(`NO-GO: the no-op rebuild reuses ${a.reuse}/${a.total} (${(share * 100).toFixed(1)}%), under the ${MIN_REUSE * 100}% bar — misses: ${describeMisses(a)}`);
  else reasons.push(`A: the no-op rebuild reuses ${a.reuse}/${a.total}${recomputed(a) ? ` — misses the key states: ${describeMisses(a)}` : ""}`);

  const b = s.edited.tally;
  if (recomputed(b) !== s.edited.n + recomputed(a) || b.recompute.content !== s.edited.n + a.recompute.content) reasons.push(`NO-GO: ${s.edited.n} edits recompute ${recomputed(b)} (content ${b.recompute.content}), not exactly ${s.edited.n} beyond the no-op's ${recomputed(a)}`);
  else reasons.push(`B: ${s.edited.n} edits recompute exactly ${s.edited.n}; ${b.reuse} reused`);

  const c = s.modelBump.tally;
  if (c.reuse !== 0) reasons.push(`NO-GO: a model bump reuses ${c.reuse} vectors labelled another model`);
  else reasons.push(`C: a model bump recomputes ${recomputed(c)}/${c.total}${cost ? `, ${fmtSeconds(cost.modelBumpSecondsByRows)} by rows / ${fmtSeconds(cost.modelBumpSecondsByChars)} by characters at the measured rate` : " — cost not measured this run"}`);

  const d = s.comprehensionOnly;
  if (recomputed(d.embedding) !== recomputed(a)) reasons.push(`NO-GO: a comprehension-only change recomputes ${recomputed(d.embedding)} embeddings`);
  else reasons.push(`D: a comprehension-only change recomputes ${recomputed(d.embedding) - recomputed(a)} embeddings; the graph re-reads ${d.graph.thoughts} thoughts (${d.graph.mentionsReplaced} mention rows replaced)`);

  reasons.push(`E: a window-recipe change replaces ${s.recipe.chunkRowsNow} chunk rows under ${s.recipe.chunkedNow} thoughts (${s.recipe.wouldChunk} would window under the current recipe) and reuses ${s.recipe.parentsReused} parents — less any head-window fallback, which the row does not record`);

  let provisional = false;
  if (cost) {
    if (cost.minCosine !== null && cost.minCosine < REPRO_COSINE) reasons.push(`NO-GO: a reused row's fresh vector sits at cosine ${cost.minCosine.toFixed(4)} to its stored one (bar ${REPRO_COSINE}) — the vector is not a function of its key`);
    else if (cost.minCosine !== null) reasons.push(`the cached value reproduces: fresh against stored, min cosine ${cost.minCosine.toFixed(4)}, median ${cost.medianCosine!.toFixed(4)} over ${cost.sampled} rows`);
  } else {
    provisional = true;
    reasons.push("provisional: no provider ran, so the cost and the reproducibility of the cached value are not measured");
  }
  const go = !reasons.some((r) => r.startsWith("NO-GO"));
  return { go, provisional, reasons };
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

// ── The report ───────────────────────────────────────────────────────────────

export type Census = {
  thoughts: number;
  chars: number;
  withVector: number;
  byModel: { model: string | null; n: number }[];
  fingerprintAgrees: number;
  chunkedThoughts: number;
  chunkRows: number;
  mentions: number;
  edges: number;
  proposals: number;
  /** contentUpdates moved the text; keyUpdates moved content_fingerprint_of(text) — 003 collapses whitespace, so the two can differ. */
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
  L.push(`corpus: ${c.thoughts} thoughts, ${(c.chars / 1e6).toFixed(2)} M chars; ${c.withVector} with a vector (${c.byModel.map((m) => `${m.model ?? "<unlabelled>"} ${m.n}`).join(", ")}); content_fingerprint = content_fingerprint_of(content) on ${c.fingerprintAgrees}/${c.thoughts}; ${c.chunkedThoughts} windowed (${c.chunkRows} chunk rows); chunk_context ${c.config.chunk_context ?? "?"}; target ${o.scenarios.target}`);
  L.push(`log: ${c.audit.capture} capture / ${c.audit.update} update / ${c.audit.delete} delete rows (${(c.audit.bytes / 1e6).toFixed(1)} MB); ${c.audit.contentUpdates} updates moved content, ${c.audit.keyUpdates} of them the fingerprint; the log holds content for ${c.audit.liveWithContentEvent}/${c.thoughts} live thoughts (a capture row carries metadata, not content — 008)`);
  L.push(`graph: ${c.mentions} mentions, ${c.edges} edges; ${o.stale.thoughts} thought(s) with ${o.stale.mentions} mention rows extracted before their fingerprint last moved — ${o.stale.queued} queued for a re-read, ${o.stale.failed} whose re-read failed (terminal until --retry-failed), ${o.stale.unqueued} in no pool; ${c.proposals} proposals (recorded extraction key ${c.config.entity_extraction_key ?? "none"})`);
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
  row(`B ${s.edited.n} edits`, s.edited.tally);
  row(`C model bump → ${s.modelBump.other}`, s.modelBump.tally);
  row("D comprehension-only (embedding)", s.comprehensionOnly.embedding);
  L.push(`${"D comprehension-only (graph)".padEnd(32)} ${"—".padStart(5)} ${"".padStart(7)}  ${String(s.comprehensionOnly.graph.thoughts).padStart(9)}  thoughts re-read, ${s.comprehensionOnly.graph.mentionsReplaced} mention rows replaced`);
  L.push(`${"E window recipe".padEnd(32)} ${String(s.recipe.parentsReused).padStart(5)} ${"parents".padStart(7)}  ${String(s.recipe.chunkRowsNow).padStart(9)}  chunk rows under ${s.recipe.chunkedNow} thought(s); ${s.recipe.wouldChunk} would window now; head-window fallbacks unrecorded`);
  L.push("");
  if (o.cost && o.samples) {
    const k = o.cost;
    L.push(`cost — ${k.sampled} rows embedded through the real embedder (${o.provider}), ${k.sampledChars} chars, one at a time:`);
    L.push(`  per row: median ${(k.medianMsPerRow / 1000).toFixed(2)} s, mean ${(k.meanMsPerRow / 1000).toFixed(2)} s; ${(k.msPerKChar / 1000).toFixed(3)} s per 1k chars; ${k.fellBack} fell back to a head window`);
    L.push(`  steady state (A): 0 calls. typical (B, ${s.edited.n} edits): ${fmtSeconds(k.editSeconds)}. worst (C, ${c.thoughts} rows): ${fmtSeconds(k.modelBumpSecondsByRows)} by rows, ${fmtSeconds(k.modelBumpSecondsByChars)} by characters`);
    L.push(`  the cached value against a fresh one: min cosine ${k.minCosine === null ? "—" : k.minCosine.toFixed(4)}, median ${k.medianCosine === null ? "—" : k.medianCosine.toFixed(4)}`);
    L.push("  id                                    chars  windows  calls     s   cosine");
    for (const x of o.samples) L.push(`  ${x.id}  ${String(x.chars).padStart(5)}  ${String(x.windows).padStart(7)}  ${String(x.calls).padStart(5)}  ${(x.ms / 1000).toFixed(2).padStart(5)}  ${x.cosineToStored === null ? "     —" : x.cosineToStored.toFixed(4)}${x.fellBack ? "  head window" : ""}`);
  } else {
    L.push("cost — not measured this run (--no-provider): the scenarios above are counts; the seconds need the provider");
  }
  if (o.claims.length) {
    L.push("");
    L.push("the graph's own cost, from the claim log (finished_at − claimed_at over succeeded rows), and a full re-read at that rate:");
    for (const g of graphCost(o.claims, c.thoughts)) L.push(`  ${g.key.padEnd(28)} n ${String(g.n).padStart(4)}  median ${g.medianS.toFixed(1).padStart(6)} s/row  → ${c.thoughts} thoughts ≈ ${g.rebuildHoursSequential.toFixed(1)} h sequential`);
  }
  L.push("");
  L.push(`verdict: ${o.verdict.go ? "GO" : "NO-GO"}${o.verdict.provisional ? " (provisional)" : ""}`);
  for (const r of o.verdict.reasons) L.push(`  ${r}`);
  return L.join("\n");
}
