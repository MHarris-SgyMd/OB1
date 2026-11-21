/**
 * claim-validity.ts — the rules of SMD-3887 PR 2c's measurement: does the validity read (`thought_validity`, migration
 * 149) agree with the truth a person reads in the texts, on a sample of the canary's thoughts drawn before it is read?
 *
 * eval-claim-validity.ts runs these; this file holds what the verdict is decided by. The part from "The registration"
 * to "End of the registered section" is hashed (registrationHash), so a bar, a convention, the draw or the score moved
 * after the labels were read shows as a new registration in the diff.
 *
 * The maintainer's choices (2026-11-21, on SMD-3887, before any draw):
 *   - the criterion is the truth on all three axes, not the records: a rater reads the texts and judges whether the
 *     thought still holds, whether a question about it is still open, and whether its derived views still describe it;
 *   - two blind agent raters on different models label every item, the maintainer labels 20 of them blind, and a
 *     10-item pilot checks κ before the registration is pinned;
 *   - the gold is the agents' label where they agree; where they split, the maintainer's; and if the maintainer's 20
 *     agree with the agents' gold on under 0.8 of items on any axis, the maintainer labels every item and that is gold;
 *   - 120 thoughts, 40 from each stratum (in a supersedes pointer, in a proposal, in neither), weighted back;
 *   - the bar: every miss explained. A miss is a label error, a read bug (fixed before 2c merges), a record gap (the
 *     read reported its records right, the records are wrong or missing: explained, filed), or a rule divergence (the
 *     read follows an accepted row of docs/claim-validity.md and the truth differs: explained, reported per row).
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// ── The registration ──────────────────────────────────────────────────────────

/** The three axes, in the order every label, reply and fixture row lists them. */
export const AXES = ["validity", "review", "freshness"] as const;
export type Axis = (typeof AXES)[number];

/**
 * The truth a rater writes per axis. `unclear` is the rater's "the texts shown do not let me decide": an item whose gold
 * is unclear on an axis is not scored on it, and is counted.
 */
export const TRUTH = {
  validity: ["holds", "superseded", "contested", "unclear"],
  review: ["open", "decided", "none", "unclear"],
  freshness: ["current", "stale", "none", "unclear"],
} as const satisfies Record<Axis, readonly string[]>;

/** The read's states per axis, as migration 149 writes them (docs/claim-validity.md rows 2, 5 and 6). */
export const READ_STATES = {
  validity: ["unchallenged", "supported", "superseded", "contested", "unresolved", "unknown"],
  review: ["none", "pending", "decided", "checked", "unchecked", "unknown"],
  freshness: ["none", "current", "legacy", "requested", "stale", "unknown"],
} as const satisfies Record<Axis, readonly string[]>;

/**
 * Which truths each read state agrees with. A state that agrees with more than one makes no single claim (unresolved:
 * a challenge that cannot be read as standing; legacy: made before lineage was kept); it is counted apart.
 * Unknown agrees with none: an axis the read could not read is a miss against any truth a rater could read.
 */
export const AGREES: { readonly [A in Axis]: Readonly<Record<string, readonly string[]>> } = {
  validity: { unchallenged: ["holds"], supported: ["holds"], superseded: ["superseded"], contested: ["contested"], unresolved: ["holds", "superseded", "contested"], unknown: [] },
  review: { none: ["none"], pending: ["open"], decided: ["decided"], checked: ["decided"], unchecked: ["open"], unknown: [] },
  freshness: { none: ["none"], current: ["current"], legacy: ["current", "stale"], requested: ["stale"], stale: ["stale"], unknown: [] },
};

/**
 * The derived views a person can judge by reading: freshness's truth and the read it is scored against are both over
 * these kinds alone. A vector, a chunk set, a judged relation and a proposal cannot be read against a text by eye; their
 * freshness is the fingerprint's, and the report counts them apart.
 */
export const READABLE_KINDS = ["entities", "metadata", "subject"] as const;

/** The read's freshness over the readable kinds: the worst of their states (stale, requested, legacy, current), none with none. */
export function readableFreshness(kinds: readonly { kind: string; state: string }[]): string {
  const rank: Record<string, number> = { current: 1, legacy: 2, requested: 3, stale: 4 };
  let worst = 0;
  for (const k of kinds) if ((READABLE_KINDS as readonly string[]).includes(k.kind)) worst = Math.max(worst, rank[k.state] ?? 5);
  return ["none", "current", "legacy", "requested", "stale", "unknown"][worst];
}

/** The strata, by the records that touch a thought: a supersedes pointer (either side) first, then a proposal (either side), else neither. */
export const STRATA = ["pointer", "proposal", "neither"] as const;
export type Stratum = (typeof STRATA)[number];

/**
 * The draw. The first pilot's PILOT items come first, by their own fixed salt, from the whole population; the second
 * pilot's PILOT2 of each stratum next, from the rest, by theirs (the maintainer, 2026-11-21: the first held 7 of 10
 * from neither). The main draw takes PER_STRATUM of each stratum from what is left, by the salt the draw is announced
 * with (the id of the SMD-3887 comment that announces it, posted after this registration is pinned). SUBSET of the
 * main draw go to the maintainer, by a second key.
 */
export const DRAW = { perStratum: 40, subset: 20, pilot: 10, pilotSalt: "smd-3887-pr2c-pilot", pilot2: 3, pilot2Salt: "smd-3887-pr2c-pilot-2" } as const;

/** Which draw a step runs: one of the two pilots (drawn before the pin), or the main draw by its announced salt. */
export type Mode = { pilot: 1 | 2 } | { salt: string };

/** The maintainer's check on the agents: below this share on any axis, the agents' labels are not the gold. */
export const MAINTAINER_AGREEMENT_MIN = 0.8;

/** What a sheet shows of each text, and how many others it shows: a cap keeps a sheet readable, and is disclosed on it. */
export const SHOW = { itemChars: 6_000, otherChars: 1_200, linkedMax: 8, near: 5 } as const;

/**
 * The population, its strata and the draw, in one read-only snapshot, with every drawn item's material and the read's
 * answer for it, one JSON line each (`kind`: population, item, read), for the mode's draw. The keys are the ones
 * drawKey computes, so the runner re-draws from the population lines and checks it.
 */
export function drawSql(mode: Mode): string {
  const salt = "salt" in mode ? mode.salt : DRAW.pilotSalt;
  if (!/^[A-Za-z0-9-]{8,64}$/.test(salt)) throw new Error(`the salt "${salt}" is not 8 to 64 letters, digits or dashes`);
  const key = (s: string) => `('x' || substr(encode(sha256(convert_to('${s}:' || p.id::text, 'UTF8')), 'hex'), 1, 12))::bit(48)::bigint`;
  return `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
WITH pop AS (
  SELECT t.id, coalesce(t.metadata->>'source', 'unknown') AS writer,
         CASE WHEN t.supersedes IS NOT NULL OR EXISTS (SELECT 1 FROM thoughts o WHERE o.supersedes = t.id) THEN 'pointer'
              WHEN EXISTS (SELECT 1 FROM supersession_proposals q WHERE t.id IN (q.older_id, q.newer_id)) THEN 'proposal'
              ELSE 'neither' END AS stratum
    FROM thoughts t
), pilot AS (
  SELECT p.id FROM pop p ORDER BY ${key(DRAW.pilotSalt)}, p.id LIMIT ${DRAW.pilot}
), pilot2 AS (
  SELECT id, stratum FROM (
    SELECT p.id, p.stratum, row_number() OVER (PARTITION BY p.stratum ORDER BY ${key(DRAW.pilot2Salt)}, p.id) AS rn
      FROM pop p WHERE p.id NOT IN (SELECT id FROM pilot)) s
   WHERE rn <= ${DRAW.pilot2}
), main AS (
  SELECT id, stratum FROM (
    SELECT p.id, p.stratum, row_number() OVER (PARTITION BY p.stratum ORDER BY ${key(salt)}, p.id) AS rn
      FROM pop p WHERE p.id NOT IN (SELECT id FROM pilot) AND p.id NOT IN (SELECT id FROM pilot2)) s
   WHERE rn <= ${DRAW.perStratum}
), drawn AS (
  ${"salt" in mode ? "SELECT id, stratum FROM main" : mode.pilot === 1 ? "SELECT p.id, p.stratum FROM pop p WHERE p.id IN (SELECT id FROM pilot)" : "SELECT id, stratum FROM pilot2"}
), linked AS (
  SELECT d.id, l.other, min(l.rank) AS rank
    FROM drawn d
    CROSS JOIN LATERAL (
      SELECT t.supersedes AS other, 1 AS rank FROM thoughts t WHERE t.id = d.id AND t.supersedes IS NOT NULL
      UNION ALL SELECT o.id, 1 FROM thoughts o WHERE o.supersedes = d.id
      UNION ALL SELECT CASE WHEN q.older_id = d.id THEN q.newer_id ELSE q.older_id END, 2 FROM supersession_proposals q WHERE d.id IN (q.older_id, q.newer_id)
      UNION ALL SELECT (f.payload->>'target')::uuid, CASE WHEN f.payload->>'relation' = 'distinct' THEN 4 ELSE 3 END
        FROM thought_facets f
       WHERE f.thought_id = d.id AND f.kind = 'relation' AND f.superseded_by IS NULL AND f.valid_until IS NULL
         AND f.payload->>'target' ~ '^[0-9a-f-]{36}$'
    ) l
   WHERE l.other <> d.id AND EXISTS (SELECT 1 FROM thoughts x WHERE x.id = l.other)
   GROUP BY d.id, l.other
), shown AS (
  SELECT id, other FROM (SELECT l.*, row_number() OVER (PARTITION BY l.id ORDER BY l.rank, l.other) AS rn FROM linked l) s WHERE rn <= ${SHOW.linkedMax}
  UNION
  SELECT d.id, n.id FROM drawn d JOIN thoughts t ON t.id = d.id
   CROSS JOIN LATERAL (
     SELECT o.id FROM thoughts o
      WHERE o.created_at > t.created_at AND o.id <> d.id AND o.embedding IS NOT NULL AND t.embedding IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM linked l WHERE l.id = d.id AND l.other = o.id)
      ORDER BY o.embedding <=> t.embedding LIMIT ${SHOW.near}) n
)
SELECT json_build_object('kind', 'population', 'id', p.id, 'stratum', p.stratum, 'writer', p.writer)::text FROM pop p
UNION ALL
SELECT json_build_object(
  'kind', 'item', 'id', d.id, 'stratum', d.stratum, 'at', t.created_at, 'updated', t.updated_at,
  'writer', coalesce(t.metadata->>'source', 'unknown'), 'chars', length(t.content), 'text', left(t.content, ${SHOW.itemChars}),
  'views', json_build_object(
    'entities', (SELECT coalesce(json_agg(e.name ORDER BY e.name), '[]') FROM thought_entities te JOIN ob1_entities e ON e.id = te.entity_id WHERE te.thought_id = d.id),
    'metadata', json_build_object('type', t.metadata->'type', 'topics', t.metadata->'topics', 'people', t.metadata->'people', 'action_items', t.metadata->'action_items'),
    'subject', (SELECT coalesce(json_agg(f.payload->>'key' ORDER BY f.payload->>'key'), '[]') FROM thought_facets f
                 WHERE f.thought_id = d.id AND f.kind = 'subject' AND f.superseded_by IS NULL AND f.valid_until IS NULL)),
  'others', (SELECT coalesce(json_agg(json_build_object('id', o.id, 'at', o.created_at, 'updated', o.updated_at, 'writer', coalesce(o.metadata->>'source', 'unknown'),
                                                        'chars', length(o.content), 'text', left(o.content, ${SHOW.otherChars})) ORDER BY o.id), '[]')
               FROM shown s JOIN thoughts o ON o.id = s.other WHERE s.id = d.id),
  'questions', (SELECT coalesce(json_agg(json_build_object('other', CASE WHEN q.older_id = d.id THEN q.newer_id ELSE q.older_id END,
                                                           'this_is', CASE WHEN q.older_id = d.id THEN 'older' ELSE 'newer' END,
                                                           'verdict', q.verdict, 'reason', q.reason, 'judged_at', q.judged_at,
                                                           'status', q.status, 'reviewed_at', q.reviewed_at, 'reviewed_by_kind', q.reviewed_by_kind)
                                         ORDER BY q.judged_at, q.id), '[]')
                  FROM supersession_proposals q WHERE d.id IN (q.older_id, q.newer_id))
)::text
  FROM drawn d JOIN thoughts t ON t.id = d.id
UNION ALL
SELECT json_build_object('kind', 'read', 'id', d.id, 'answer', thought_validity(ARRAY[d.id])->'thoughts'->0)::text FROM drawn d;
ROLLBACK;`;
}

/** The draw's order key of an id under a salt: the first 12 hex digits of sha256(salt:id), as a number (drawSql's key). */
export const drawKey = (id: string, salt: string): number => parseInt(createHash("sha256").update(`${salt}:${id}`).digest("hex").slice(0, 12), 16);

const byKey = <T extends { id: string }>(xs: readonly T[], salt: string): T[] =>
  [...xs].sort((a, b) => drawKey(a.id, salt) - drawKey(b.id, salt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

/**
 * The draw over the population: the first pilot, the second (PILOT2 of each stratum outside the first, in its sheet's
 * order), the main draw (PER_STRATUM of each stratum outside both pilots; a stratum smaller is taken whole, and said),
 * the maintainer's subset of it, and the main sheet's order (by a third key, so a rater meets the strata mixed).
 */
export function drawSample(pop: readonly { id: string; stratum: Stratum }[], salt: string, draw: typeof DRAW = DRAW): {
  pilot: string[]; pilot2: string[]; main: { id: string; stratum: Stratum }[]; subset: string[]; short: string[];
} {
  const pilot = byKey(pop, draw.pilotSalt).slice(0, draw.pilot).map((p) => p.id);
  const inPilot = new Set(pilot), short: string[] = [];
  const pilot2: { id: string }[] = [];
  for (const s of STRATA) pilot2.push(...byKey(pop.filter((p) => p.stratum === s && !inPilot.has(p.id)), draw.pilot2Salt).slice(0, draw.pilot2));
  for (const p of pilot2) inPilot.add(p.id);
  const main: { id: string; stratum: Stratum }[] = [];
  for (const s of STRATA) {
    const of = byKey(pop.filter((p) => p.stratum === s && !inPilot.has(p.id)), salt);
    if (of.length < draw.perStratum) short.push(`${s}: ${of.length} of ${draw.perStratum}`);
    main.push(...of.slice(0, draw.perStratum).map((p) => ({ id: p.id, stratum: s })));
  }
  const subset = byKey(main, `${salt}:subset`).slice(0, draw.subset).map((p) => p.id);
  return { pilot, pilot2: byKey(pilot2, `${draw.pilot2Salt}:sheet`).map((p) => p.id), main: byKey(main, `${salt}:sheet`), subset, short };
}

/**
 * The conventions every rater labels by, the edge cases fixed before the first label (the lesson of SMD-3203 and
 * SMD-3670). Printed at the head of each sheet. Part A (validity and freshness) is labelled for every item before part
 * B (review) is opened: part B shows the questions a judge raised, which part A must not see.
 */
export const CONVENTIONS: readonly string[] = [
  "Judge from the texts shown alone, as of the newest text on the item's page. The outside world counts only as the texts state it.",
  "The other texts on a page are shown in a fixed order that says nothing about how, or whether, they relate to the item. A text is later than another by its last edit where one is shown (a ticket's text is edited in place, so its status line is as of its last edit), else by when it was written.",
  "The item's main claim is what it asserts in its own scope: a session's summary claims what that session did and found, not the state of every ticket it names.",
  "VALIDITY is superseded when a later text shown replaces the item's main claim: a later version of the same note, a summary that replaces a checkpoint, or a status, standing, count or next step that a later text gives anew. Replacing a minor part while the main claim stands is not superseded.",
  "VALIDITY is contested when a text shown disputes the item's main claim (states otherwise on the same question) and no later text settles it. Adding, narrowing or following up without contradicting is not a dispute.",
  "VALIDITY is holds when nothing shown replaces or disputes the item's main claim. A record of what was done or found at a time (a decision taken, a change merged, a measurement) holds unless a later text corrects it; a later change of course does not undo that it happened. A text whose main claim is a status or next step is not such a record: the rule above applies.",
  "FRESHNESS asks whether each view shown (entities, metadata, subjects) still describes the item's text: stale when an entry is contradicted by the text, or names a subject the text does not discuss at all; current when every entry is borne out; none when the page shows no view. Borne out includes a name in another spelling or casing (eslint, ESLint), and what the text plainly implies (its author, a tool it plainly uses). A view that leaves something out is not stale for that.",
  "On an item whose text is cut, an entry not found in the shown part does not count against its view; judge the entries the shown part can bear out or contradict.",
  "REVIEW (part B only) asks whether a question about whether the item still holds is open: open when a judge's question shown, or a dispute in the texts, has no answer yet; decided when it was answered (a review recorded, or a later text settles it); none when no question was raised. A later text that replaces the item with no question raised is none.",
  "unclear on any axis means the texts shown do not let you decide. Use it only then, and say why in the note column.",
  "If you find yourself applying a rule of your own to decide an item, write it in the note column, every time you apply it.",
];

/** One rater's labels of one item: a truth per axis, or null where a part is not yet labelled. */
export type Labels = { [A in Axis]: string | null };

/** The gold per axis from the agents' two labels and the maintainer's (where given): agreement, else the maintainer's, else a split left open. */
export function goldOf(a: Labels, b: Labels, m: Labels | null): { gold: Labels; splits: Axis[] } {
  const gold = { validity: null, review: null, freshness: null } as Labels, splits: Axis[] = [];
  for (const x of AXES) {
    if (a[x] !== null && a[x] === b[x]) gold[x] = a[x];
    else if (m && m[x] !== null) gold[x] = m[x];
    else splits.push(x);
  }
  return { gold, splits };
}

/**
 * The maintainer's check: on the subset, per axis, of the items where the agents agree, the share the maintainer's
 * blind label matches. An axis under MAINTAINER_AGREEMENT_MIN makes every item's gold the maintainer's.
 */
export function maintainerCheck(items: readonly { a: Labels; b: Labels; m: Labels | null }[]): { [A in Axis]: { n: number; hit: number; share: number | null } } & { agentsAreGold: boolean } {
  const out = {} as { [A in Axis]: { n: number; hit: number; share: number | null } };
  let agentsAreGold = true;
  for (const x of AXES) {
    const both = items.filter((i) => i.m !== null && i.a[x] !== null && i.a[x] === i.b[x]);
    const hit = both.filter((i) => i.m![x] === i.a[x]).length;
    out[x] = { n: both.length, hit, share: both.length ? hit / both.length : null };
    if (out[x].share !== null && out[x].share! < MAINTAINER_AGREEMENT_MIN) agentsAreGold = false;
  }
  return { ...out, agentsAreGold };
}

/** A miss's cause, as adjudicated: the four the bar names. */
export const CAUSES = ["label", "read", "record", "rule"] as const;
export type Cause = (typeof CAUSES)[number];
/** An adjudication: a cause; for a read bug whether its fix landed and the item re-reads in agreement; for a rule the record's row. */
export type Adjudication = { cause: Cause; fixed?: boolean; row?: number };

/** One scored item: its stratum, the read's three states (freshness over READABLE_KINDS), and the gold. */
export type Scored = { id: string; stratum: Stratum; read: { [A in Axis]: string }; gold: Labels };

/** Whether the read agrees with a truth on an axis. */
export const agrees = (axis: Axis, read: string, truth: string): boolean => (AGREES[axis][read] ?? []).includes(truth);
/** Whether a read state makes no single claim on the truth: it agrees with more than one (unresolved, legacy). */
export const noClaim = (axis: Axis, read: string): boolean => TRUTH[axis].filter((t) => agrees(axis, read, t)).length > 1;

/** Per axis: the items scored (gold given and not unclear), those agreeing, the misses by id, the unclear and no-claim counts, and the agreement weighted to the population. */
export type AxisScore = { scored: number; agree: number; misses: string[]; unclear: number; noClaim: number; weighted: number | null };

/** Score a labelled sample against the population's stratum sizes. */
export function score(items: readonly Scored[], population: Readonly<Record<Stratum, number>>): Record<Axis, AxisScore> {
  const out = {} as Record<Axis, AxisScore>;
  for (const x of AXES) {
    const scored = items.filter((i) => i.gold[x] !== null && i.gold[x] !== "unclear");
    const hit = (i: Scored) => agrees(x, i.read[x], i.gold[x]!);
    let num = 0, den = 0;
    for (const s of STRATA) {
      const of = scored.filter((i) => i.stratum === s);
      if (of.length === 0) continue;
      num += population[s] * (of.filter(hit).length / of.length);
      den += population[s];
    }
    out[x] = {
      scored: scored.length, agree: scored.filter(hit).length, misses: scored.filter((i) => !hit(i)).map((i) => i.id),
      unclear: items.filter((i) => i.gold[x] === "unclear").length, noClaim: items.filter((i) => noClaim(x, i.read[x])).length,
      weighted: den ? num / den : null,
    };
  }
  return out;
}

/**
 * The verdict: PASSES when the gold is complete (no split open; the maintainer's labels on every item where the
 * agents are not the gold) and every miss is explained: a label error, a record gap, a rule divergence naming a row of
 * the record (1 to 13), or a read bug whose fix landed. WAITING while the gold or an adjudication is missing. FAILS on a
 * read bug not fixed, or a rule divergence that names no row.
 */
export function verdict(s: Record<Axis, AxisScore>, adjudicated: ReadonlyMap<string, Partial<Record<Axis, Adjudication>>>, open: { splits: number; unlabelled: number }): { state: "passes" | "waiting" | "fails"; reasons: string[] } {
  const waiting: string[] = [], failing: string[] = [];
  if (open.splits) waiting.push(`${open.splits} split labels wait for the maintainer`);
  if (open.unlabelled) waiting.push(`${open.unlabelled} items wait for the maintainer's labels (the agents are not the gold)`);
  for (const x of AXES) for (const id of s[x].misses) {
    const a = adjudicated.get(id)?.[x], at = `${x} ${id.slice(0, 8)}`;
    if (!a) waiting.push(`${at}: a miss not yet adjudicated`);
    else if (a.cause === "read" && a.fixed !== true) failing.push(`${at}: a read bug not yet fixed`);
    else if (a.cause === "rule" && !(Number.isInteger(a.row) && a.row! >= 1 && a.row! <= 13)) failing.push(`${at}: a rule divergence naming no row of the record`);
  }
  if (failing.length) return { state: "fails", reasons: [...failing, ...waiting] };
  return waiting.length ? { state: "waiting", reasons: waiting } : { state: "passes", reasons: [] };
}

// ── End of the registered section ────────────────────────────────────────────

/** Cohen's κ between two raters' labels over the same items; null when chance agreement is total. */
export function kappa(a: readonly string[], b: readonly string[]): number | null {
  if (a.length !== b.length || a.length === 0) throw new Error("kappa: two ratings of the same, non-empty items");
  const n = a.length, cats = [...new Set([...a, ...b])];
  const po = a.filter((x, i) => x === b[i]).length / n;
  const pe = cats.reduce((s, c) => s + (a.filter((x) => x === c).length / n) * (b.filter((x) => x === c).length / n), 0);
  return pe === 1 ? null : (po - pe) / (1 - pe);
}

// ── The registration's hash ───────────────────────────────────────────────────

/** The registered section of a copy of this file's text, CRLF read as LF. */
export function registeredSection(text: string): string {
  const src = text.replace(/\r\n/g, "\n");
  // At a line's start, so the markers this function names inside its own quotes are not them.
  const from = src.indexOf("\n// ── The registration ─"), to = src.indexOf("\n// ── End of the registered section ─");
  if (from < 0 || to < from) throw new Error("claim-validity.ts: the registered section's markers are missing");
  return src.slice(from, to);
}

let sectionCache: string | null = null;
/** The registration's hash: the first 16 hex digits of sha256 over the registered section, verbatim. */
export function registrationHash(text?: string): string {
  const section = text === undefined ? (sectionCache ??= registeredSection(readFileSync(fileURLToPath(import.meta.url), "utf8"))) : registeredSection(text);
  return createHash("sha256").update(section).digest("hex").slice(0, 16);
}

/** The registration's hash as a fixture records it: its 16 hex digits as numbers (check 9 takes no other string). */
export const registrationDigits = (hash: string = registrationHash()): number[] => [...hash].map((c) => parseInt(c, 16));
