/**
 * writable-projection.ts — the pure rules of the SMD-1999 spike: can
 * `thoughts` stay writable to its existing callers while every write lands as
 * an event first and a projector writes the row? The runner
 * (eval-writable-projection.ts) applies the prototypes and probes a database;
 * everything here is arithmetic over what it observed, probed by
 * `--self-check` with no database.
 *
 *   OPTIONS     — the schemas measured: 053 as it stands (the baseline),
 *                 option 2 (table stays, functions append then project), option
 *                 1 with the functions unchanged, option 1 with option 2's
 *                 bodies pointed at the base table.
 *   CRITERIA    — the pre-registered C1–C14 (the ticket's comment of
 *                 2026-09-24), each gating (contract or behaviour) or
 *                 informative.
 *   judge       — probes → an observation per criterion per option.
 *   verdict     — the pre-registered rule: GO when every contract criterion
 *                 PASSes and every behaviour criterion holds; NO-GO on any
 *                 contract FAIL.
 *   recommend   — the GO option with the shorter contributor delta; fewer moved
 *                 objects on a tie; none when none is GO.
 *   comparable* — the differential's normalisation: what an event and a row
 *                 look like when the prototype's additions (content on a
 *                 capture, the key's move on an update) are set aside, so the
 *                 baseline's log and rows can be compared to an option's.
 *   compareRows — the replay rule: which columns of a rebuilt row differ from
 *                 the copy taken before the wipe, with the one tolerated
 *                 difference named (a key the raw writer left NULL and 003's
 *                 rule filled).
 *   EXPECTED    — the matrix the run recorded, held by `--check` in CI so a
 *                 Postgres or prototype change that moves a cell is named.
 */

export type OptionId = "baseline" | "option2" | "option1-unchanged" | "option1";

export type OptionInfo = { id: OptionId; label: string; movedObjects: number; description: string };

/** movedObjects: relations, triggers and functions the option redefines or renames — the tie-break in `recommend`. */
export const OPTIONS: readonly OptionInfo[] = [
  { id: "baseline", label: "053 as it stands", movedObjects: 0, description: "the schema at migration 053; the audit trigger derives the event from the row after the write" },
  { id: "option2", label: "option 2 — table stays, functions append then project", movedObjects: 9,
    description: "upsert_thought (2), update_thought, delete_thought append the event and call one projector; the audit trigger checks a projected write and appends a raw one; 001's updated_at trigger yields to the projector; the snapshot table and its trigger" },
  { id: "option1-unchanged", label: "option 1 — a view named thoughts, 053's functions unchanged", movedObjects: 6,
    description: "the table renamed to thought_rows, a view named thoughts over it, INSTEAD OF INSERT/UPDATE/DELETE triggers that append and project; the write functions as 053 defines them" },
  { id: "option1", label: "option 1 — the view, with option 2's functions", movedObjects: 15,
    description: "option 1's view and triggers with option 2's function bodies, their projector writing the base table" },
];

export type CriterionId = "C1" | "C2" | "C3" | "C4" | "C5" | "C6" | "C7" | "C8" | "C9" | "C10" | "C11" | "C12" | "C13" | "C14";
export type Gating = "contract" | "behaviour" | "informative";

export type Criterion = { id: CriterionId; title: string; gating: Gating };

export const CRITERIA: readonly Criterion[] = [
  { id: "C1", title: "the vendored capture unchanged: 3-argument upsert_thought, the readwise payload, one capture event carrying the content", gating: "contract" },
  { id: "C2", title: "the 2- and 4-argument forms unchanged", gating: "contract" },
  { id: "C3", title: "update_thought unchanged: content, metadata, provenance, DUPLICATE_CONTENT, STALE_READ, the re-embed shape", gating: "contract" },
  { id: "C4", title: "delete_thought unchanged: a delete event with the previous content; a cited delete refused and eventless", gating: "contract" },
  { id: "C5", title: "raw writers: INSERT INTO thoughts audited once; ingest-records' ON CONFLICT (id) … RETURNING xmax = 0", gating: "contract" },
  { id: "C6", title: "the community DDL verbatim: ADD COLUMN, CREATE INDEX, REFERENCES, a row trigger, a sidecar UPDATE", gating: "contract" },
  { id: "C7", title: "SMD-1043: two captures of one text serialise on the fingerprint lock — one row, one id", gating: "behaviour" },
  { id: "C8", title: "SMD-1323: an edit naming supersedes is not blocked by update_thought's row lock on its target", gating: "behaviour" },
  { id: "C9", title: "SMD-1462: update_thought naming supersedes and delete_thought of the target serialise, no deadlock", gating: "behaviour" },
  { id: "C10", title: "trigger interaction: one audit row and one extraction claim per logical write, the actor stamp, updated_at", gating: "contract" },
  { id: "C11", title: "read-your-writes in the same session, and the drop-the-projector control", gating: "contract" },
  { id: "C12", title: "the log rebuilds the rows through the same projector; the content-less capture is refused", gating: "contract" },
  { id: "C13", title: "cost: median wall-clock of a capture and of an edit against the baseline", gating: "informative" },
  { id: "C14", title: "the contributor delta: every statement that failed or had to change", gating: "informative" },
];

export const CRITERION_IDS: readonly CriterionId[] = CRITERIA.map((c) => c.id);

export type Outcome = "PASS" | "FAIL" | "N/A";

/** One atomic probe the runner ran: a statement, a comparison, a count. */
export type Probe = { name: string; ok: boolean; error?: string };

export type Observation = { criterion: CriterionId; option: OptionId; outcome: Outcome; failed: Probe[]; probes: number };

/** PASS when every probe passed; FAIL naming the failed ones; N/A when nothing ran. */
export function judge(criterion: CriterionId, option: OptionId, probes: readonly Probe[]): Observation {
  const failed = probes.filter((p) => !p.ok);
  return {
    criterion, option,
    outcome: probes.length === 0 ? "N/A" : failed.length === 0 ? "PASS" : "FAIL",
    failed, probes: probes.length,
  };
}

export type Verdict = { option: OptionId; go: boolean; reasons: string[] };

/**
 * The pre-registered rule. GO when C1–C6 and C10–C12 all PASS and C7–C9 each
 * hold; NO-GO when any contract criterion FAILs or a behaviour criterion does
 * not hold. An N/A contract criterion is not a PASS: it is named, and the
 * option is not GO — a verdict rests on what was measured.
 */
export function verdict(option: OptionId, observations: readonly Observation[]): Verdict {
  const reasons: string[] = [];
  for (const c of CRITERIA) {
    if (c.gating === "informative") continue;
    const o = observations.find((x) => x.option === option && x.criterion === c.id);
    const outcome = o?.outcome ?? "N/A";
    if (outcome === "FAIL") {
      reasons.push(`${c.id} FAIL: ${o!.failed.map((p) => p.name + (p.error ? ` — ${p.error}` : "")).join("; ")}`);
    } else if (outcome === "N/A") {
      reasons.push(`${c.id} not measured`);
    }
  }
  return { option, go: reasons.length === 0, reasons };
}

export type Recommendation = { option: OptionId | null; why: string };

/** The GO option with the shorter contributor delta; fewer moved objects on a tie; none when none is GO. */
export function recommend(verdicts: readonly Verdict[], deltas: Readonly<Record<OptionId, readonly string[]>>): Recommendation {
  const go = verdicts.filter((v) => v.go && v.option !== "baseline");
  if (go.length === 0) {
    return { option: null, why: "no option is GO: the extension contract does not survive the move as prototyped, and SMD-1997's \"zero contributor-visible break\" is false" };
  }
  const info = (id: OptionId) => OPTIONS.find((o) => o.id === id)!;
  go.sort((a, b) => (deltas[a.option].length - deltas[b.option].length) || (info(a.option).movedObjects - info(b.option).movedObjects));
  const best = go[0];
  const tie = go.length > 1 && deltas[go[1].option].length === deltas[best.option].length;
  return {
    option: best.option,
    why: `${info(best.option).label}: ${deltas[best.option].length === 0 ? "an empty contributor delta" : `${deltas[best.option].length} contributor-visible change(s)`}` +
      (tie ? `; fewer moved objects (${info(best.option).movedObjects}) than ${info(go[1].option).label} (${info(go[1].option).movedObjects}) on a tied delta` : "") +
      (go.length === 1 && verdicts.some((v) => !v.go && v.option !== "baseline") ? "; the only GO option" : ""),
  };
}

// ---------------------------------------------------------------------------
// The differential: the baseline's log and rows against an option's.
// ---------------------------------------------------------------------------

export type EventImage = {
  action: string;
  source: string | null;
  actor_name: string | null;
  actor_kind: string | null;
  trust: string | null;
  origin: string | null;
  stance: string | null;
  diff: Record<string, unknown> | null;
};

/**
 * The prototype adds two things to 046's event and nothing else: the content
 * on a capture, and the fingerprint's move on an update. Set aside, an
 * option's event must equal the baseline's for the same write.
 */
export function comparableEvent(e: EventImage): EventImage {
  const diff = e.diff ? { ...e.diff } : null;
  if (diff) {
    if (e.action === "capture") delete diff.content;
    if (e.action === "update") delete diff.content_fingerprint;
  }
  return { ...e, diff };
}

export type RowImage = {
  content: string;
  content_fingerprint: string | null;
  /** jsonb_typeof(metadata): a JSON null and an SQL NULL both read as null in JS, and 046 stores the former (first review pass). */
  metadata_type: string | null;
  metadata: Record<string, unknown> | null;
  supersedes: string | null;
  derived_from: unknown;
  has_vector: boolean;
  embedding_model: string | null;
};

/**
 * The row as a caller sees it: the eight columns of RowImage, which carry no
 * id (random per run) and no stamp (the run's clock) — so the differential
 * compares exactly these, and the two named updated_at deltas are outside it
 * by construction (first review pass: the doc said "set aside" of fields the
 * image never held).
 */
export function comparableRow(r: RowImage): RowImage {
  return { ...r };
}

export type Mismatch = { at: string; baseline: string; option: string };

const show = (v: unknown): string => JSON.stringify(v ?? null);

/** Every position where two lists of images differ, by index; a length difference is one mismatch. */
export function compareImages<T>(baseline: readonly T[], option: readonly T[], label: string, normalise: (t: T) => T): Mismatch[] {
  const out: Mismatch[] = [];
  if (baseline.length !== option.length) {
    out.push({ at: `${label} count`, baseline: String(baseline.length), option: String(option.length) });
  }
  const n = Math.min(baseline.length, option.length);
  for (let i = 0; i < n; i++) {
    const b = show(normalise(baseline[i]));
    const o = show(normalise(option[i]));
    if (b !== o) out.push({ at: `${label}[${i}]`, baseline: b, option: o });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The replay rule.
// ---------------------------------------------------------------------------

export type ReplayRow = {
  id: string;
  content: string;
  content_fingerprint: string | null;
  metadata: unknown;
  supersedes: string | null;
  derived_from: unknown;
  created_at: string;
  updated_at: string | null;
  embedding: string | null;
  embedding_model: string | null;
};

export type ReplayDiff = { id: string; column: string; before: string; after: string; tolerated: boolean };

/**
 * Column by column. One difference is tolerated and named: a key the raw
 * writer left NULL (003's rule lives in the functions) that the projector
 * filled from the content — the replay applies the rule the writer skipped.
 * A row present on one side only is a difference on `presence`.
 */
export function compareRows(before: readonly ReplayRow[], after: readonly ReplayRow[]): ReplayDiff[] {
  const out: ReplayDiff[] = [];
  const byId = new Map(after.map((r) => [r.id, r]));
  const seen = new Set<string>();
  for (const b of before) {
    const a = byId.get(b.id);
    seen.add(b.id);
    if (!a) { out.push({ id: b.id, column: "presence", before: "present", after: "absent", tolerated: false }); continue; }
    for (const col of ["content", "content_fingerprint", "metadata", "supersedes", "derived_from", "created_at", "updated_at", "embedding", "embedding_model"] as const) {
      const bv = show(b[col]);
      const av = show(a[col]);
      if (bv !== av) {
        const tolerated = col === "content_fingerprint" && b.content_fingerprint === null && a.content_fingerprint !== null;
        out.push({ id: b.id, column: col, before: bv.length > 60 ? bv.slice(0, 57) + "…" : bv, after: av.length > 60 ? av.slice(0, 57) + "…" : av, tolerated });
      }
    }
  }
  for (const a of after) if (!seen.has(a.id)) out.push({ id: a.id, column: "presence", before: "absent", after: "present", tolerated: false });
  return out;
}

// ---------------------------------------------------------------------------
// The cost line.
// ---------------------------------------------------------------------------

export type Timing = { label: string; baselineUs: number; optionUs: number };

export function fmtUs(us: number): string {
  if (!Number.isFinite(us)) return "n/a";
  return us >= 1000 ? `${(us / 1000).toFixed(2)} ms` : `${us.toFixed(0)} µs`;
}

export function costLine(t: Timing): string {
  const ratio = t.baselineUs > 0 ? t.optionUs / t.baselineUs : NaN;
  return `${t.label}: baseline ${fmtUs(t.baselineUs)}, option 2 ${fmtUs(t.optionUs)}` + (Number.isFinite(ratio) ? ` (×${ratio.toFixed(2)})` : "");
}

// ---------------------------------------------------------------------------
// The recorded matrix, held by --check.
// ---------------------------------------------------------------------------

/**
 * What the run of 2026-09-24 observed on Postgres 16 (pgvector 0.8.6), per
 * option per criterion. `--check` compares a fresh run to this and fails on
 * any moved cell — the record is the spike's finding, and a change to it is a
 * change to the finding. Informative criteria (C13, C14) carry no cell.
 */
export const EXPECTED: Readonly<Record<OptionId, Readonly<Partial<Record<CriterionId, Outcome>>>>> = {
  baseline: { C1: "FAIL", C2: "PASS", C3: "PASS", C4: "PASS", C5: "PASS", C6: "PASS", C7: "PASS", C8: "PASS", C9: "PASS", C10: "PASS", C11: "PASS", C12: "N/A" },
  option2: { C1: "PASS", C2: "PASS", C3: "PASS", C4: "PASS", C5: "PASS", C6: "PASS", C7: "PASS", C8: "PASS", C9: "PASS", C10: "PASS", C11: "PASS", C12: "PASS" },
  "option1-unchanged": { C1: "FAIL", C2: "FAIL", C3: "PASS", C4: "PASS", C5: "FAIL", C6: "FAIL", C7: "N/A", C8: "N/A", C9: "N/A", C10: "N/A", C11: "N/A", C12: "N/A" },
  option1: { C1: "PASS", C2: "PASS", C3: "PASS", C4: "PASS", C5: "FAIL", C6: "FAIL", C7: "PASS", C8: "PASS", C9: "PASS", C10: "PASS", C11: "PASS", C12: "PASS" },
};

/** Every cell of a run that differs from the record, as "option/criterion: recorded X, observed Y". */
export function driftFrom(expected: typeof EXPECTED, observations: readonly Observation[]): string[] {
  const out: string[] = [];
  for (const option of Object.keys(expected) as OptionId[]) {
    for (const [criterion, recorded] of Object.entries(expected[option]) as [CriterionId, Outcome][]) {
      const o = observations.find((x) => x.option === option && x.criterion === criterion);
      const observed = o?.outcome ?? "N/A";
      if (observed !== recorded) out.push(`${option}/${criterion}: recorded ${recorded}, observed ${observed}`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The report.
// ---------------------------------------------------------------------------

export type Report = {
  postgres: string;
  observations: readonly Observation[];
  verdicts: readonly Verdict[];
  deltas: Readonly<Record<OptionId, readonly string[]>>;
  timings: readonly Timing[];
  differential: readonly Mismatch[];
  replay: Readonly<Partial<Record<OptionId, readonly ReplayDiff[]>>>;
  notes: readonly string[];
  recommendation: Recommendation;
};

const pad = (s: string, n: number) => (s.length >= n ? s : s + " ".repeat(n - s.length));

export function renderReport(r: Report): string {
  const lines: string[] = [];
  lines.push(`Writable projection — SMD-1999 (Spike 2 of SMD-1997), ${r.postgres}`);
  lines.push("");
  const cols = OPTIONS.map((o) => o.id);
  lines.push(pad("criterion", 6) + cols.map((c) => pad(c, 19)).join(""));
  for (const c of CRITERIA) {
    if (c.gating === "informative") continue;
    const cells = cols.map((opt) => {
      const o = r.observations.find((x) => x.option === opt && x.criterion === c.id);
      const outcome = o?.outcome ?? "N/A";
      return pad(outcome === "N/A" ? "N/A" : `${outcome} (${o!.probes - o!.failed.length}/${o!.probes})`, 19);
    });
    lines.push(pad(c.id, 6) + cells.join("") + `  ${c.title}`);
  }
  lines.push("");
  for (const v of r.verdicts) {
    if (v.option === "baseline") continue;
    lines.push(`${v.option}: ${v.go ? "GO" : "NO-GO"}`);
    for (const reason of v.reasons) lines.push(`  - ${reason}`);
    const delta = r.deltas[v.option];
    lines.push(`  C14 contributor delta: ${delta.length === 0 ? "none" : ""}`);
    for (const d of delta) lines.push(`    - ${d}`);
  }
  lines.push("");
  lines.push("C13 cost (medians):");
  for (const t of r.timings) lines.push(`  ${costLine(t)}`);
  lines.push("");
  lines.push(`Differential, baseline against option 2 (events and rows for the same scripted writes, the prototype's two additions set aside): ${r.differential.length === 0 ? "identical" : `${r.differential.length} mismatch(es)`}`);
  for (const m of r.differential) lines.push(`  - ${m.at}: baseline ${m.baseline} / option ${m.option}`);
  lines.push("");
  for (const [opt, diffs] of Object.entries(r.replay) as [OptionId, readonly ReplayDiff[]][]) {
    const hard = diffs.filter((d) => !d.tolerated);
    lines.push(`C12 replay under ${opt}: ${diffs.length === 0 ? "every column of every row equal" : `${hard.length} difference(s) beyond the ${diffs.length - hard.length} tolerated`}`);
    for (const d of diffs) lines.push(`  - ${d.tolerated ? "(tolerated) " : ""}${d.id.slice(0, 8)} ${d.column}: ${d.before} → ${d.after}`);
  }
  lines.push("");
  lines.push("Notes:");
  for (const n of r.notes) lines.push(`  - ${n}`);
  lines.push("");
  lines.push(`Recommendation: ${r.recommendation.option ?? "none"} — ${r.recommendation.why}`);
  return lines.join("\n");
}
