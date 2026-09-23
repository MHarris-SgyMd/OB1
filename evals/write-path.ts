/**
 * write-path.ts — the write-path eval's rules, pure (Linear SMD-1713).
 *
 * Everything here is a function of its arguments and nothing else, so
 * `eval-write-path.ts --self-check` can probe every rule with a hand-known
 * answer and no database, no server and no model: the scripted provider's
 * three answers (a vector for a text, an entity list, a judge's verdict), the
 * reader that turns search hits into a deliverable's lines, the parsers that
 * read the server's replies, the scorer, the pairing and the comparison
 * against `baselines.json`. `_write-path-arm.ts` runs the corpus through the
 * real server and hands back an Observation; the scorer never sees the server.
 *
 * The number. Of the facts planted across the sessions, how many reached a
 * later deliverable as a plain statement (SURVIVAL); of the errors planted,
 * how many the deliverable did not state as fact (CATCH), and which memory
 * mechanism the catch rests on — the one whose removal lets the error through;
 * and of the deliverable's lines, how many carry their source in the row's
 * `derived_from` as the database accepted it (COVERAGE). Paired per
 * mechanism: the items an arm gets right that the default arm does not, and
 * the reverse — helped and hurt, with McNemar's exact p — never a mean of
 * means (SMD-1420's rule, eval-longmemeval's test).
 *
 * Partitions, decided up front (SMD-1719's lesson: define the number before
 * the review finds its denominator). An item is RETRIEVED when a search for
 * its subject returned it within READER_K. A retrieved item is PRESENTED as
 * `plain` (a line stating it as fact), `contested` (a line marking it under a
 * pending conflict proposal) or `dropped` (the reader left it out — labelled
 * superseded, or an agent's word on a subject the operator spoke on); an item
 * never retrieved is `unseen`. Survival counts `plain` over every salient
 * item; catch counts not-`plain` over every RETRIEVED error, and the errors
 * never retrieved are counted beside it, not inside it — an error the
 * deliverable never saw is luck, not a mechanism.
 */

import { DEFAULT_CANDIDATES } from "../server-portable/consolidate.ts";
import { DELIVERABLES, ITEMS, READER_K, SESSIONS, SUBJECTS, type DeliverableSpec, type Item, type Session, type SubjectKey } from "./write-path-corpus.ts";

// ── The scripted provider's rules ──────────────────────────────────────────

export const SUBJECT_KEYS = Object.keys(SUBJECTS) as SubjectKey[];
/** Axes past the subjects', one per text by hash, so two texts of one subject never tie. */
export const NOISE_AXES = 16;
/** The vector width the stub embeds at: one axis per subject, then the noise axes. */
export const STUB_DIM = SUBJECT_KEYS.length + NOISE_AXES;

/** The subjects a text names, by phrase, case-insensitive, in SUBJECTS' order. */
export function subjectsIn(text: string): SubjectKey[] {
  const lower = text.toLowerCase();
  return SUBJECT_KEYS.filter((k) => lower.includes(SUBJECTS[k].toLowerCase()));
}

/** FNV-1a over UTF-16 code units; a stable 32-bit hash for the noise axis and its weight. */
export function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** The tie-break's quantum: a text's noise weight is one of this many steps. */
export const NOISE_BUCKETS = 1000;
/** Which step a text's noise weight takes — two texts of one subject in the same bucket tie for the query. */
export function noiseBucket(text: string): number {
  return (fnv1a(text.trim().toLowerCase()) >>> 8) % NOISE_BUCKETS;
}

/**
 * Two texts of one subject must sit at least this far apart in cosine to the
 * subject's query, or the k cut is decided by the row's random id (027's
 * ORDER BY) and moves run to run. Measured: equal weights moved the cut
 * (one run in three picked other items); one bucket apart did not — the
 * exact rerank stage (039 / SMD-1707) orders at full precision. So this is
 * a MARGIN, sixteen times float32's spacing near 1 and about a bucket's
 * worth at the smallest weight, not a measured tie; `corpusProblems` holds
 * it over the real vectors.
 */
export const MIN_COSINE_GAP = 1e-6;

/**
 * The stub embedding: 1 on each named subject's axis, and a small weight on
 * one noise axis chosen by the text's hash — so a query sits near every text
 * of its subject and orthogonal to the rest, and the texts of one subject
 * rank in a fixed order decided by nothing the corpus author chose. The
 * QUERY — a subject's phrase alone — is the bare axis with no noise, so its
 * cosine to a text is exactly 1/√(1+w²) and the weight alone orders the
 * texts; with noise on the query too, a text sharing the query's noise axis
 * gained w·w_q and jumped the order (review pass 2, demonstrated). A text
 * naming no subject is noise alone.
 */
export function vectorFor(text: string, dim = STUB_DIM): number[] {
  if (dim < STUB_DIM) throw new Error(`vectorFor: dim ${dim} is below the stub's ${STUB_DIM}`);
  const v = new Array<number>(dim).fill(0);
  const named = subjectsIn(text);
  for (const k of named) v[SUBJECT_KEYS.indexOf(k)] = 1;
  if (named.length === 1 && text.trim().toLowerCase() === SUBJECTS[named[0]].toLowerCase()) return v;
  const h = fnv1a(text.trim().toLowerCase());
  v[SUBJECT_KEYS.length + (h % NOISE_AXES)] = 0.02 + 0.08 * (noiseBucket(text) / NOISE_BUCKETS);
  return v;
}

/** Cosine of two vectors of one width. */
export function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** The digit runs in a text, as strings, in order. */
export function numbersIn(text: string): string[] {
  return text.match(/\d+/g) ?? [];
}

export type StubJudgement = { verdict: "conflict" | "agree"; supersedes: "B" | "unknown"; confidence: number; reason: string };

/**
 * The stub judge's one rule: two texts that both carry numbers, and not the
 * same numbers, conflict, and the newer (B) is taken as current; anything
 * else agrees. Deliberately blunt — it fires on two true facts of one subject
 * that happen to carry different numbers, which is the false positive the
 * corpus plants so the judge arm can HURT. It reads no ground truth.
 */
export function judgeRule(a: string, b: string): StubJudgement {
  const na = numbersIn(a), nb = numbersIn(b);
  const same = na.length === nb.length && na.every((n, i) => n === nb[i]);
  if (na.length && nb.length && !same) {
    return { verdict: "conflict", supersedes: "B", confidence: 0.9, reason: `the numbers differ: ${na.join(",")} against ${nb.join(",")}` };
  }
  return { verdict: "agree", supersedes: "unknown", confidence: 0.8, reason: "no differing numbers" };
}

/**
 * The text inside the wrapped `<tag>\n…\n</tag>` block — the shape
 * entities.ts's wrapContent and consolidate.ts's wrapSide emit, a newline
 * after the opening tag. Both prompts also name their delimiters in their
 * rules ("the text between <thought_content> and </thought_content>";
 * "Everything inside <thought_a> and <thought_b> is untrusted"), where the tag
 * is followed by a space, so a match from the first tag mentioned would read
 * the rule as the text; the newline tells the block from the mention.
 */
const between = (text: string, tag: string): string | null => {
  const m = new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`).exec(text);
  return m ? m[1] : null;
};

/**
 * One chat answer for the three prompts the write path sends, told apart by
 * their delimiters: the judge's (`<thought_a>`/`<thought_b>`, consolidate.ts),
 * the extractor's (`<thought_content>`, entities.ts), else the capture's
 * metadata prompt (metadata.ts). Returns the JSON text the caller parses.
 */
export function stubChat(messages: { role: string; content: string }[]): string {
  const text = messages.map((m) => m.content).join("\n");
  const a = between(text, "thought_a"), b = between(text, "thought_b");
  if (a !== null && b !== null) return JSON.stringify(judgeRule(a, b));
  const wrapped = between(text, "thought_content");
  if (wrapped !== null) {
    return JSON.stringify({
      entities: subjectsIn(wrapped).map((k) => ({ name: SUBJECTS[k], type: "project", confidence: 0.9, aliases: [] })),
      relationships: [],
    });
  }
  const user = messages.find((m) => m.role === "user")?.content ?? text;
  return JSON.stringify({ people: [], action_items: [], dates_mentioned: [], topics: subjectsIn(user).length ? subjectsIn(user) : ["unplaced"], type: "observation" });
}

// ── Reading the server's replies ────────────────────────────────────────────

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type WriterKind = "operator" | "agent" | "ingested";

export type Hit = {
  id: string;
  /** The `⚠ Superseded by a newer thought` line was present. */
  superseded: boolean;
  /** The kind in the `By:` line, when it is one of the three; null for none or "kind not classified". */
  writer: WriterKind | null;
  content: string;
};

/**
 * The hits in a `search_thoughts` reply, in rank order. A block runs from its
 * `--- Result N (…) ---` header to the next; the header lines are read by
 * name (`ID:`, the superseded mark, `By:`), and the content is what follows
 * the first blank line — the shape index.ts renders, which nothing parses by
 * position past the id (SMD-1726's rule, held here as a reader too).
 */
export function parseHits(reply: string): Hit[] {
  const blocks = reply.split(/^--- Result \d+ \([^)]*\) ---\n/m).slice(1);
  const hits: Hit[] = [];
  for (const block of blocks) {
    const cut = block.indexOf("\n\n");
    const header = (cut >= 0 ? block.slice(0, cut) : block).split("\n");
    const content = cut >= 0 ? block.slice(cut + 2).replace(/\n+$/, "") : "";
    const idLine = header.find((l) => l.startsWith("ID: "));
    const id = idLine?.slice(4).trim() ?? "";
    if (!UUID_RE.test(id)) continue;
    const by = header.find((l) => l.startsWith("By: "));
    const kind = by ? /\((operator|agent|ingested)\)\s*$/.exec(by)?.[1] ?? null : null;
    hits.push({ id: id.toLowerCase(), superseded: header.some((l) => l.startsWith("⚠ Superseded by a newer thought")), writer: kind as WriterKind | null, content });
  }
  return hits;
}

/**
 * The thought ids named by the pending proposals in a
 * `list_supersession_proposals` reply — both sides of every pair. The reply
 * lists proposals of the status asked for, so a caller asking for `pending`
 * (the default) reads only those; each proposal prints its two `ID:` lines.
 */
export function parseProposalIds(reply: string): Set<string> {
  const ids = new Set<string>();
  if (/^No .*supersession proposals\./.test(reply)) return ids;
  for (const m of reply.matchAll(/^\s+ID: ([0-9a-f-]{36})\s*$/gim)) ids.add(m[1].toLowerCase());
  return ids;
}

/** The id in `capture_thought`'s confirmation, `Captured as <type> — id <uuid>`. */
export function parseCapturedId(reply: string): string {
  const m = /— id ([0-9a-f-]{36})/i.exec(reply);
  if (!m) throw new Error(`capture_thought's reply names no id: ${reply.slice(0, 200)}`);
  return m[1].toLowerCase();
}

// ── The reader ──────────────────────────────────────────────────────────────

export type LineKind = "plain" | "contested";
export type Line = { id: string; kind: LineKind; content: string };
export type ReaderPolicy = "labels" | "blind";

/**
 * The reader's policy over one subject's hits — fixed, not a model, because
 * what is measured is what memory's presentation lets a reader do (SMD-1735's
 * thesis). Under `labels`: a hit the read marks superseded is left out; where
 * the operator's word stands on the subject, an agent's is left out; a hit in
 * a pending conflict proposal is written as contested (a proposal is a
 * question for a reviewer, never applied unreviewed — migration 029's rule);
 * every other hit is a plain line. Under `blind` every hit is a plain line —
 * the reader that ignores every label, which the gate uses to prove its floor
 * has teeth. The reader never sees the ground truth.
 */
export function decide(hits: Hit[], contested: ReadonlySet<string>, policy: ReaderPolicy): Line[] {
  if (policy === "blind") return hits.map((h) => ({ id: h.id, kind: "plain", content: h.content }));
  const standing = hits.filter((h) => !h.superseded);
  const operatorSpoke = standing.some((h) => h.writer === "operator");
  const kept = operatorSpoke ? standing.filter((h) => h.writer !== "agent") : standing;
  return kept.map((h) => ({ id: h.id, kind: contested.has(h.id) ? "contested" : "plain", content: h.content }));
}

/** The deliverable's text: a heading per subject, a line per hit kept, contested ones marked. */
export function renderDeliverable(spec: DeliverableSpec, lines: Partial<Record<SubjectKey, Line[]>>): string {
  const parts = [`Deliverable: ${spec.title}`];
  for (const k of spec.subjects) {
    parts.push(``, `## ${SUBJECTS[k]}`);
    const ls = lines[k] ?? [];
    if (!ls.length) parts.push(`- nothing on record`);
    for (const l of ls) parts.push(l.kind === "contested" ? `- (contested, pending review) ${l.content}` : `- ${l.content}`);
  }
  return parts.join("\n");
}

// ── What an arm hands back ──────────────────────────────────────────────────

export const ARMS = ["default", "-supersedes", "-judge", "-actor"] as const;
export type Arm = (typeof ARMS)[number];
export type Mechanism = "supersedes" | "judge" | "actor";
export const MECHANISMS: Mechanism[] = ["supersedes", "judge", "actor"];
export const armOff = (m: Mechanism): Arm => `-${m}` as Arm;

export type DeliverableObservation = {
  title: string;
  subjects: SubjectKey[];
  lines: (Line & { subject: SubjectKey })[];
  /** The deliverable's own thought id, and derived_from read back from its row. */
  thoughtId: string;
  derivedFrom: string[];
  /** Cost: characters the deliverable carries. */
  chars: number;
};

export type Observation = {
  arm: Arm;
  reader: ReaderPolicy;
  /** Item id → the thought id the server returned for it. */
  idOf: Record<string, string>;
  /** Per subject searched: the hit ids returned, in rank order. */
  hits: Partial<Record<SubjectKey, string[]>>;
  deliverables: DeliverableObservation[];
  /** How many pending proposals the reader saw, and how many thoughts the extractor reached. */
  pendingProposals: number;
  extracted: number;
  ms: number;
};

// ── Scoring ─────────────────────────────────────────────────────────────────

export type Presented = "plain" | "contested" | "dropped" | "unseen";
/**
 * `right`: a salient item presented plain; an error not presented plain.
 * `counted`: whether the item is in its rate's population — every salient
 * item is; an error only when retrieved, since an error the deliverable never
 * saw was neither caught nor stated, and the pairing must read the same
 * population as the rate or a k cut would be credited to a mechanism.
 */
export type Outcome = { retrieved: boolean; presented: Presented; right: boolean; counted: boolean };
export type ErrorClass = "stale" | "wrong_number" | "inference";
export const ERROR_CLASSES: ErrorClass[] = ["stale", "wrong_number", "inference"];

export type Rate = { n: number; of: number };
export type ArmScore = {
  arm: Arm;
  reader: ReaderPolicy;
  /** Salient items presented plain, over every salient item; the other presentations counted beside. */
  survival: Rate & { contested: number; dropped: number; unseen: number };
  /** Retrieved errors not presented plain, over every retrieved error; the errors never retrieved beside. */
  catch: Rate & { unseen: number; byClass: Record<ErrorClass, Rate> };
  /** Lines whose id sits in the deliverable's derived_from, over every line. */
  coverage: Rate;
  /** Cost: ids returned across every search, characters across every deliverable. */
  returned: number;
  chars: number;
  outcome: Record<string, Outcome>;
};

export const isError = (item: Item): boolean => item.planted.kind !== "salient";
export const errorClassOf = (item: Item): ErrorClass | null => (isError(item) ? (item.planted.kind as ErrorClass) : null);
export const ratio = (r: Rate): number | null => (r.of > 0 ? r.n / r.of : null);

/** The scored items: every planted item is scored; nothing in the corpus is filler today. */
export function scoredItems(items: readonly Item[] = ITEMS): Item[] {
  return [...items];
}

/**
 * One arm's numbers from what it observed. A salient item is right when a
 * deliverable states it plain; an error is right when no deliverable states it
 * plain (contested, dropped or never seen). The map from item to thought id
 * is the runner's; an item the runner never mapped is a run fault, not a
 * score, and throws.
 */
export function scoreArm(obs: Observation, items: readonly Item[] = ITEMS, specs: readonly DeliverableSpec[] = DELIVERABLES): ArmScore {
  const outcome: Record<string, Outcome> = {};
  const presentedBy = new Map<string, LineKind>();
  for (const d of obs.deliverables) for (const l of d.lines) {
    const prev = presentedBy.get(l.id);
    // A thought stated plain anywhere is stated plain: the worse presentation stands.
    if (prev !== "plain") presentedBy.set(l.id, l.kind);
  }
  const covered = new Set(specs.flatMap((s) => s.subjects));
  const survival = { n: 0, of: 0, contested: 0, dropped: 0, unseen: 0 };
  const byClass = Object.fromEntries(ERROR_CLASSES.map((c) => [c, { n: 0, of: 0 }])) as Record<ErrorClass, Rate>;
  const catchAll = { n: 0, of: 0, unseen: 0 };
  for (const item of scoredItems(items)) {
    if (!covered.has(item.subject)) continue;
    const tid = obs.idOf[item.id]?.toLowerCase();
    if (!tid) throw new Error(`scoreArm: item ${item.id} has no thought id in the ${obs.arm} arm's observation`);
    // Retrieved: the search for ITS subject returned it (the header's word).
    const retrieved = (obs.hits[item.subject] ?? []).some((id) => id.toLowerCase() === tid);
    const presented: Presented = !retrieved ? "unseen" : (presentedBy.get(tid) ?? "dropped");
    const cls = errorClassOf(item);
    if (cls === null) {
      survival.of++;
      if (presented === "plain") survival.n++;
      else if (presented === "contested") survival.contested++;
      else if (presented === "dropped") survival.dropped++;
      else survival.unseen++;
      outcome[item.id] = { retrieved, presented, right: presented === "plain", counted: true };
    } else {
      if (!retrieved) catchAll.unseen++;
      else {
        catchAll.of++; byClass[cls].of++;
        if (presented !== "plain") { catchAll.n++; byClass[cls].n++; }
      }
      outcome[item.id] = { retrieved, presented, right: retrieved && presented !== "plain", counted: retrieved };
    }
  }
  let lines = 0, cited = 0, chars = 0;
  for (const d of obs.deliverables) {
    const derived = new Set(d.derivedFrom.map((x) => x.toLowerCase()));
    for (const l of d.lines) { lines++; if (derived.has(l.id.toLowerCase())) cited++; }
    chars += d.chars;
  }
  const returned = Object.values(obs.hits).reduce((s, ids) => s + (ids?.length ?? 0), 0);
  return { arm: obs.arm, reader: obs.reader, survival, catch: { ...catchAll, byClass }, coverage: { n: cited, of: lines }, returned, chars, outcome };
}

// ── Pairing ─────────────────────────────────────────────────────────────────

/**
 * McNemar's exact test, two-sided, over the discordant pairs under a fair
 * coin — eval-longmemeval's, with its bound: the binomial sum is exact in
 * doubles while 2^n is finite, and refused past 1,000 rather than printing 0.
 */
export function mcnemarExact(helped: number, hurt: number): number {
  const n = helped + hurt;
  if (n === 0) return 1;
  if (n > 1000) throw new Error(`mcnemarExact: ${n} discordant pairs is past the exact sum's range; use a normal approximation.`);
  const lo = Math.min(helped, hurt);
  let c = 1, tail = 0;
  for (let i = 0; i <= lo; i++) { tail += c; c = (c * (n - i)) / (i + 1); }
  return Math.min(1, (2 * tail) / 2 ** n);
}

export type Paired = {
  mechanism: Mechanism;
  /** Items right with the mechanism (the default arm) and wrong without it. */
  helped: string[];
  /** Items wrong with the mechanism and right without it. */
  hurt: string[];
  /** McNemar over every discordant item — a MIXED population (facts stated, errors not stated); two effects in opposite directions cancel here. Read the two below. */
  p: number;
  /** The same counts by what was planted — facts (survival's population) and errors (catch's) — each with its own McNemar p. */
  facts: { helped: number; hurt: number; p: number };
  errors: { helped: number; hurt: number; p: number };
  /** Items in one arm's population and not the other's (an error retrieved in one arm only): compared in neither direction. */
  unpaired: string[];
};

/**
 * The default arm against the arm with one mechanism off: what that mechanism
 * helped and hurt, by item, over the items BOTH arms counted — an error one
 * arm never retrieved is nobody's doing and is listed, not paired.
 */
export function pair(withAll: ArmScore, without: ArmScore, mechanism: Mechanism, items: readonly Item[] = ITEMS): Paired {
  const byItem = new Map(items.map((i) => [i.id, i]));
  const helped: string[] = [], hurt: string[] = [], unpaired: string[] = [];
  const facts = { helped: 0, hurt: 0, p: 1 }, errors = { helped: 0, hurt: 0, p: 1 };
  for (const [id, o] of Object.entries(withAll.outcome)) {
    const w = without.outcome[id];
    if (!w) throw new Error(`pair: ${id} scored in the default arm and not in ${without.arm}`);
    if (!o.counted || !w.counted) { unpaired.push(id); continue; }
    const bucket = byItem.get(id) && isError(byItem.get(id)!) ? errors : facts;
    if (o.right && !w.right) { helped.push(id); bucket.helped++; }
    if (!o.right && w.right) { hurt.push(id); bucket.hurt++; }
  }
  facts.p = mcnemarExact(facts.helped, facts.hurt);
  errors.p = mcnemarExact(errors.helped, errors.hurt);
  return { mechanism, helped, hurt, p: mcnemarExact(helped.length, hurt.length), facts, errors, unpaired };
}

/**
 * For each error the default arm caught: the mechanisms it rests on — those
 * whose removal lets the error through. An error caught with none named is
 * caught twice over (two mechanisms each suffice), or never retrieved.
 */
export function caughtBy(withAll: ArmScore, withouts: Partial<Record<Mechanism, ArmScore>>, items: readonly Item[] = ITEMS): Record<string, Mechanism[]> {
  const out: Record<string, Mechanism[]> = {};
  for (const item of items) {
    if (!isError(item)) continue;
    const o = withAll.outcome[item.id];
    if (!o || !o.counted || !o.right) continue;
    out[item.id] = MECHANISMS.filter((m) => {
      const arm = withouts[m];
      if (!arm) return false;
      const w = arm.outcome[item.id];
      if (!w) throw new Error(`caughtBy: ${item.id} scored in the default arm and not in ${arm.arm}`);
      return w.counted && !w.right;
    });
  }
  return out;
}

// ── The record and the comparison ───────────────────────────────────────────

/**
 * What the gate holds: the default arm's three rates as counts — the
 * denominator binds the population, so a corpus that grew or shrank fails by
 * name rather than passing on a rate over other items — and a ceiling on the
 * errors never retrieved, since those sit outside the catch rate and a
 * retrieval change that hid an error would otherwise leave it at 1.
 */
export type Floor = {
  survival: Rate; catch: Rate; coverage: Rate; unseenErrors: number;
  /** The items the default arm got right, sorted — a fact lost for a fact gained keeps every count and fails here by name. */
  right: string[];
};
export type WritePathBaseline = {
  via: string;
  /** corpusLabel() at the record — the gate refuses a corpus that reads differently. */
  corpus: string;
  reader_k: number;
  floor: Floor;
  arms: Record<string, { survival: number | null; catch: number | null; coverage: number | null; contested: number; unseen_errors: number; returned: number; chars: number }>;
  /** Per mechanism: facts and errors each with their own McNemar p, and the mixed p over both (where opposite effects cancel). */
  paired: Record<string, { facts: { helped: number; hurt: number; p: number }; errors: { helped: number; hurt: number; p: number }; mixed_p: number }>;
};

export const round3 = (x: number | null): number | null => (x === null ? null : Math.round(x * 1000) / 1000);

/** One sentence naming the corpus the numbers were measured on; the record carries it and the gate compares it. */
export function corpusLabel(): string {
  return `${SESSIONS.length} sessions, ${ITEMS.length} items over ${SUBJECT_KEYS.length} subjects, ${DELIVERABLES.length} deliverables, reader k=${READER_K} (write-path-corpus.ts)`;
}

/** The floor an arm's score would record. */
export function floorOf(s: ArmScore): Floor {
  const rate = (r: Rate): Rate => ({ n: r.n, of: r.of });
  const right = Object.entries(s.outcome).filter(([, o]) => o.counted && o.right).map(([id]) => id).sort();
  return { survival: rate(s.survival), catch: rate(s.catch), coverage: rate(s.coverage), unseenErrors: s.catch.unseen, right };
}

/** The three rates of an arm, rounded as the record keeps them. */
export function ratesOf(s: ArmScore): { survival: number | null; catch: number | null; coverage: number | null } {
  return { survival: round3(ratio(s.survival)), catch: round3(ratio(s.catch)), coverage: round3(ratio(s.coverage)) };
}

/**
 * The gate's comparison. Failures: a rate below the recorded ratio (compared
 * whether or not the population moved — a lost citation must not hide
 * behind a changed line count); a population other than the recorded one
 * (the denominators differ; coverage's is the line count, so any change to
 * what the reader keeps moves it, and the message says so); more errors
 * unseen than recorded; and any item the record had right that this run has
 * wrong, by id — the counts alone pass a fact lost for a fact gained. Notes:
 * an item now right that the record had wrong, since a floor is a floor and
 * an improvement passes, but the record should say so. The run is
 * deterministic — a stub provider, a fixed corpus, hashed tie-breaks — so
 * the floor is the value recorded, not a tolerance below it; a legitimate
 * change re-records the section, as `bench.ts --rebaseline` asks for the
 * retrieval ones. A rate with an empty denominator never passes silently.
 */
export function compareToFloor(s: ArmScore, floor: Floor): { failures: string[]; notes: string[] } {
  const failures: string[] = [], notes: string[] = [];
  const check = (name: "survival" | "catch" | "coverage", r: Rate) => {
    const f = floor[name];
    if (r.of !== f.of) failures.push(`${name}: measured over ${r.of} item(s), recorded over ${f.of} — not the recorded population${name === "coverage" ? " (the line count: the reader kept a different set of hits)" : ""}; re-record if the change is meant`);
    const v = ratio(r), fv = ratio(f);
    if (v === null || fv === null) { failures.push(`${name}: nothing to measure (${r.n}/${r.of})`); return; }
    if (v + 1e-9 < fv) failures.push(`${name}: ${v.toFixed(3)} (${r.n}/${r.of}) is below the recorded ${fv.toFixed(3)} (${f.n}/${f.of})`);
    else if (v > fv + 1e-9) notes.push(`${name}: ${v.toFixed(3)} (${r.n}/${r.of}) is above the recorded ${fv.toFixed(3)} (${f.n}/${f.of}); re-record to hold it`);
  };
  check("survival", s.survival);
  check("catch", s.catch);
  check("coverage", s.coverage);
  if (s.catch.unseen > floor.unseenErrors) failures.push(`unseen errors: ${s.catch.unseen} planted error(s) never retrieved, recorded ${floor.unseenErrors} — a retrieval change hid an error the catch rate cannot see`);
  const rightNow = new Set(Object.entries(s.outcome).filter(([, o]) => o.counted && o.right).map(([id]) => id));
  const rightThen = new Set(floor.right);
  const lost = [...rightThen].filter((id) => !rightNow.has(id)).sort();
  const gained = [...rightNow].filter((id) => !rightThen.has(id)).sort();
  if (lost.length) failures.push(`items the record had right and this run has wrong: ${lost.join(", ")}`);
  if (gained.length) notes.push(`items this run has right and the record had wrong: ${gained.join(", ")}; re-record to hold them`);
  return { failures, notes };
}

// ── Rendering ───────────────────────────────────────────────────────────────

const pct = (r: Rate): string => (r.of ? `${((100 * r.n) / r.of).toFixed(1).padStart(5)}% (${r.n}/${r.of})` : "   n/a");

/** The report: one row per arm, then the paired table per mechanism, then each caught error's mechanism. */
export function renderReport(scores: ArmScore[], paired: Paired[], caught: Record<string, Mechanism[]>, items: readonly Item[] = ITEMS): string {
  const def0 = scores.find((s) => s.arm === "default" && s.reader === "labels");
  const lines: string[] = [];
  lines.push(`arm            reader   survival            catch               coverage            contested  unseen-err  returned  chars`);
  lines.push(`─`.repeat(118));
  for (const s of scores) {
    lines.push(
      `${s.arm.padEnd(14)} ${s.reader.padEnd(8)} ${pct(s.survival).padEnd(19)} ${pct(s.catch).padEnd(19)} ${pct(s.coverage).padEnd(19)} ` +
      `${String(s.survival.contested).padStart(9)}  ${String(s.catch.unseen).padStart(10)}  ${String(s.returned).padStart(8)}  ${String(s.chars).padStart(5)}`,
    );
  }
  const def = scores.find((s) => s.arm === "default" && s.reader === "labels");
  if (def) {
    lines.push(``, `catch by error class (default arm): ` + ERROR_CLASSES.map((c) => `${c} ${pct(def.catch.byClass[c]).trim()}`).join(" · "));
  }
  if (!paired.length) {
    lines.push(``, `paired mechanisms and attribution: not measured in this run (no mechanism arm ran; the report and --record run them)`);
    return lines.join("\n");
  }
  lines.push(``, `paired against the default arm — items the mechanism got right that its absence did not (helped) and the reverse (hurt), over the items both arms counted; McNemar exact, two-sided: facts (stated) and errors (not stated) each with its own p, and the mixed p over both, where opposite effects cancel`);
  lines.push(`mechanism    facts +/−  p       errors +/−  p       mixed p   helped items              hurt items                    unpaired`);
  lines.push(`─`.repeat(118));
  for (const p of paired) {
    lines.push(
      `${p.mechanism.padEnd(12)} ${`${p.facts.helped}/${p.facts.hurt}`.padEnd(10)} ${p.facts.p.toFixed(3)}   ${`${p.errors.helped}/${p.errors.hurt}`.padEnd(11)} ${p.errors.p.toFixed(3)}   ${p.p.toFixed(3)}     ` +
      `${p.helped.join(",").padEnd(25)} ${p.hurt.join(",").padEnd(29)} ${p.unpaired.join(",")}`,
    );
  }
  const byItem = new Map(items.map((i) => [i.id, i]));
  lines.push(``, `errors the default arm caught, and the mechanism each rests on (none named = caught by more than one of the arms run, or never retrieved)`);
  for (const [id, ms] of Object.entries(caught)) {
    const it = byItem.get(id);
    lines.push(`  ${id.padEnd(5)} ${(it?.planted.kind ?? "?").padEnd(13)} ${ms.length ? ms.join(" + ") : (def0?.outcome[id]?.retrieved ? "more than one" : "never retrieved")}`);
  }
  return lines.join("\n");
}

// ── The corpus's own shape ──────────────────────────────────────────────────

/**
 * What the corpus must hold for the numbers to mean what the header says.
 * Returned as problems in words; the self-check asserts the list is empty and
 * probes the rules with a broken copy.
 */
export function corpusProblems(items: readonly Item[] = ITEMS, specs: readonly DeliverableSpec[] = DELIVERABLES, sessions: readonly Session[] = SESSIONS): string[] {
  const out: string[] = [];
  const ids = new Map<string, number>();
  const texts = new Map<string, string>();
  items.forEach((it, i) => {
    if (ids.has(it.id)) out.push(`item id ${it.id} appears twice`);
    ids.set(it.id, i);
    // The same text is one row after upsert_thought's fingerprint (003/035):
    // two items would be scored from one presentation, and the second's
    // capture writes no derived_from.
    // 003's rule, as content_fingerprint_of spells it: whitespace runs collapsed, trimmed, lower-cased.
    const key = it.text.replace(/\s+/g, " ").trim().toLowerCase();
    const t = texts.get(key);
    if (t) out.push(`${it.id} repeats ${t}'s text under 003's fingerprint; upsert_thought would make them one row`);
    else texts.set(key, it.id);
  });
  const phrases = SUBJECT_KEYS.map((k) => SUBJECTS[k].toLowerCase());
  for (const a of phrases) for (const b of phrases) if (a !== b && b.includes(a)) out.push(`subject phrase "${a}" is inside "${b}"`);
  for (const p of phrases) if (/\d/.test(p)) out.push(`subject phrase "${p}" carries a digit; the judge stub would read it`);
  items.forEach((it, i) => {
    const named = subjectsIn(it.text);
    if (named.length !== 1 || named[0] !== it.subject) out.push(`${it.id} names ${named.join(",") || "no subject"}; its subject is ${it.subject}`);
    const ref = it.planted.kind === "stale" ? it.planted.replacedBy : it.planted.kind === "wrong_number" ? it.planted.correct : it.planted.kind === "inference" ? it.planted.against : null;
    if (ref !== null) {
      const j = ids.get(ref);
      if (j === undefined) out.push(`${it.id} refers to ${ref}, which is not an item`);
      else if (items[j].subject !== it.subject) out.push(`${it.id} refers to ${ref} on another subject`);
      else if (it.planted.kind === "stale" && j <= i) out.push(`${it.id} is replaced by ${ref}, which is not captured later`);
      else if (it.planted.kind !== "stale" && j >= i) out.push(`${it.id} is planted against ${ref}, which is not captured earlier`);
    }
    if (it.planted.kind === "stale") {
      const newer = items[ids.get(it.planted.replacedBy) ?? -1];
      if (newer && newer.supersedes !== it.id) out.push(`${newer.id} replaces ${it.id} but does not carry supersedes: ${it.id}`);
      if (numbersIn(it.text).length) out.push(`${it.id} is a decision and carries a digit; the judge stub would catch what supersedes should`);
    }
    if (it.supersedes !== undefined) {
      const older = items[ids.get(it.supersedes) ?? -1];
      if (!older) out.push(`${it.id} supersedes ${it.supersedes}, which is not an item`);
      else if (older.planted.kind !== "stale" || older.planted.replacedBy !== it.id) out.push(`${it.id} supersedes ${it.supersedes}, which is not the stale decision it replaces`);
    }
    if (it.planted.kind === "wrong_number") {
      const correct = items[ids.get(it.planted.correct) ?? -1];
      if (correct && judgeRule(correct.text, it.text).verdict !== "conflict") out.push(`${it.id} and ${correct.id} do not differ in their numbers; the judge stub would not read a conflict`);
      if (it.writer !== "op") out.push(`${it.id} is a wrong number by ${it.writer}; the plant is the operator's own slip`);
    }
    if (it.planted.kind === "inference") {
      if (it.writer !== "bot") out.push(`${it.id} is an inference by ${it.writer}; the plant is an agent's`);
      // The actor mark drops an agent's word only where the operator's stands
      // (decide); an inference on an agent-only subject no mechanism can catch.
      if (!items.some((o) => o.subject === it.subject && o.writer === "op")) out.push(`${it.id} is an inference on ${it.subject}, where the operator never spoke; nothing could catch it`);
    }
  });
  const sessionOf = (id: string): number => sessions.findIndex((s) => s.items.some((x) => x.id === id));
  // 029 judges a thought against its k nearest OLDER neighbours (a calendar
  // day earlier — a session here) sharing an entity, k = the shipped
  // DEFAULT_CANDIDATES the worker runs at. Every pair the judge stub would
  // read as a conflict — a slip and its twin, or two true facts with different
  // numbers — must have the newer side with no more earlier neighbours than
  // that, or the pair is never judged and the expectation and the run part.
  for (const b of items) {
    const sb = sessionOf(b.id);
    const earlier = items.filter((a) => a.subject === b.subject && sessionOf(a.id) < sb);
    if (earlier.length > DEFAULT_CANDIDATES && earlier.some((a) => judgeRule(a.text, b.text).verdict === "conflict")) {
      out.push(`${b.id} conflicts with an earlier item and has ${earlier.length} earlier neighbours on ${b.subject}, more than the shipped ${DEFAULT_CANDIDATES} candidates; the pair may not be judged`);
    }
  }
  // The -supersedes arm is not one mechanism by itself: 029 keeps a superseded
  // thought out of the judge's pool and its candidates, so writing no pointer
  // also gives the judge three more thoughts to pair. Inert only while nothing
  // on a subject that carries a decision has a digit for the judge to read —
  // a rule here, not an accident of the corpus.
  const decisionSubjects = new Set(items.filter((it) => it.planted.kind === "stale").map((it) => it.subject));
  for (const it of items) if (decisionSubjects.has(it.subject) && numbersIn(it.text).length) out.push(`${it.id} carries a digit on ${it.subject}, a subject with a decision pair; the -supersedes arm would move the judge's pairs too`);
  // The tie-break, over the real vectors: two texts of one subject closer
  // than MIN_COSINE_GAP to the subject's query tie for it, and the k cut
  // falls to the row's random id.
  const bySubject = new Map<SubjectKey, Item[]>();
  for (const it of items) bySubject.set(it.subject, [...(bySubject.get(it.subject) ?? []), it]);
  for (const [k, group] of bySubject) {
    const q = vectorFor(SUBJECTS[k]);
    const sorted = group.map((it) => ({ id: it.id, c: cosine(vectorFor(it.text), q) })).sort((x, y) => x.c - y.c);
    for (let i = 1; i < sorted.length; i++) if (sorted[i].c - sorted[i - 1].c < MIN_COSINE_GAP) out.push(`${sorted[i - 1].id} and ${sorted[i].id} (${k}) sit ${(sorted[i].c - sorted[i - 1].c).toExponential(2)} apart in cosine to the query, under ${MIN_COSINE_GAP}; the query would rank them by their row ids — re-word one`);
  }
  const covered = new Set(specs.flatMap((s) => s.subjects));
  for (const k of SUBJECT_KEYS) if (!covered.has(k)) out.push(`subject ${k} is in no deliverable`);
  const seen = new Set<string>();
  for (const s of specs) for (const k of s.subjects) { if (seen.has(k)) out.push(`subject ${k} is in two deliverables`); seen.add(k); }
  const perSubject = new Map<SubjectKey, number>();
  for (const it of items) perSubject.set(it.subject, (perSubject.get(it.subject) ?? 0) + 1);
  if (![...perSubject.values()].some((n) => n > READER_K)) out.push(`no subject has more than READER_K (${READER_K}) items, so retrieval never cuts and survival is trivially 1`);
  if (!items.some((it) => it.writer === "bot" && it.planted.kind === "salient" && items.some((o) => o.subject === it.subject && o.writer === "op"))) out.push(`no agent's true fact on a subject the operator spoke on (the actor arm's hurt case)`);
  if (!items.some((it) => it.writer === "bot" && it.planted.kind === "salient" && !items.some((o) => o.subject === it.subject && o.writer === "op"))) out.push(`no agent-only subject (the actor arm must not drop an agent nobody contradicts)`);
  return out;
}
