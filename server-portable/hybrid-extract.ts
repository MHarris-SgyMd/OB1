/**
 * hybrid-extract.ts (SMD-2321) — re-decide a generative extraction's entities
 * with the Jev decider. The verdict of the SMD-2017 spike: the 7B/27B is strong
 * at PROPOSING candidate names (recall) and weak at TYPING them; the decider-4b
 * is the reverse. So the hybrid keeps the generative model's proposals and
 * replaces its types with the decider's validity + type decision, storing the
 * decider's calibrated `p_true` as the entity confidence — the flat-1.00 gap
 * SMD-1925 named, and the signal SMD-2305's tri-state gate reads.
 *
 * An identifier-shaped name (SMD-2300's gate: a ticket id, a path, a host:port,
 * snake_case) is kept and typed by rule WITHOUT a decide call — the decider is a
 * coin-flip on those shapes, and a regex is not. Every other candidate gets a
 * validity binary + a type choice (the rich-description framing the spike
 * measured at ~76% type / ~82% valid). A refused name (a number, a
 * type-vocabulary word) is dropped before any call, as record_thought_entities
 * would refuse it anyway.
 *
 * Pure and reusable: the worker (db/extract-entities.ts) passes the thought text,
 * the 7B's entities, a resolved JevConfig and its EgressSubject; this returns the
 * re-decided entities for the unchanged write path. Relations are left as they
 * came (record_thought_entities drops any naming an unlisted entity).
 */
import { ENTITY_TYPES, type EntityType, type ExtractedEntity } from "./entities.ts";
import { entityTypeGate } from "./entity-gate.ts";
import { jevDecideMany, type JevConfig } from "./jev.ts";
import type { JevDecision, JevOption, JevResult } from "./jev-contract.ts";
import type { EgressSubject } from "./egress.ts";

/** The type choice's options, with the descriptions the spike measured best through the contract (bare names starve the semantic decider). */
const TYPE_DESC: Record<EntityType, string> = {
  tool: "a tool, software, library, file, table, function, or code artifact",
  topic: "a general topic, concept, or subject",
  project: "a named project, initiative, or unit of work",
  person: "a specific person",
  organization: "a company or organization",
  place: "a geographic place or location",
};
const TYPE_OPTIONS: JevOption[] = ENTITY_TYPES.map((t) => ({ id: t, description: TYPE_DESC[t] }));
const CTX = 180;

/**
 * The identifier carve-out (SMD-2300): a probe through entity_type_gate with a
 * neutral `topic` input. The gate returns NULL for a refused name (a number, a
 * vocabulary word), the shape's type for an any/notPerson identifier shape
 * (a ticket id → project, a path/host:port/snake_case → tool — these override
 * any input type), and the input `topic` unchanged for anything else. So a
 * result that is neither NULL nor `topic` marks an identifier to keep by rule.
 */
function identifierVerdict(name: string): { drop: boolean; type: EntityType | null } {
  const g = entityTypeGate(name, "topic");
  if (g === null) return { drop: true, type: null };
  if (g !== "topic") return { drop: false, type: g as EntityType };
  return { drop: false, type: null }; // not an identifier — send to the decider
}

export type HybridStats = { in: number; carved: number; decided: number; droppedRefused: number; droppedByDecider: number; noContext: number; deciderError: boolean; out: number; ms: number };

/** The decider call, injectable so a unit test can stub it without a network. */
export type DecideFn = (cfg: JevConfig, decisions: JevDecision[], subject: EgressSubject) => Promise<{ results: JevResult[]; ms: number }>;

/**
 * Re-decide the generative extraction's entities. Identifier shapes (SMD-2300)
 * are typed by rule without a decide call; the rest are validity-gated and typed
 * by the decider, their confidence set to the decider's p_true. Choices:
 *   - a candidate whose name is not found verbatim in the text keeps the model's
 *     type — the decider would otherwise judge it on the wrong window (the doc
 *     opening), since the extraction carries no offsets;
 *   - the binary gate drops a candidate the decider calls `false` OR abstains on
 *     (SMD-2305's tri-state will DEFER the abstain band instead of dropping it);
 *   - a decider outage falls back to the model's entities so the thought still
 *     extracts, flagged in the stats rather than failing the whole thought.
 * Returns the kept entities and a stats record. Relations are the caller's to
 * carry; record_thought_entities drops any naming an unlisted entity.
 */
export async function decideEntities(
  text: string,
  entities: readonly ExtractedEntity[],
  cfg: JevConfig,
  subject: EgressSubject,
  decide: DecideFn = jevDecideMany,
): Promise<{ entities: ExtractedEntity[]; stats: HybridStats }> {
  const kept: ExtractedEntity[] = [];
  const toDecide: { e: ExtractedEntity; ctx: string }[] = [];
  const lower = text.toLowerCase();
  let carved = 0, droppedRefused = 0, noContext = 0;
  for (const e of entities) {
    const v = identifierVerdict(e.name);
    if (v.drop) { droppedRefused++; continue; }
    if (v.type) { kept.push({ ...e, type: v.type, confidence: 1 }); carved++; continue; }
    const at = lower.indexOf(e.name.toLowerCase());
    if (at < 0) { kept.push({ ...e }); noContext++; continue; }
    const ctx = text.slice(Math.max(0, at - CTX), at + e.name.length + CTX).replace(/\s+/g, " ").trim();
    toDecide.push({ e, ctx });
  }

  let ms = 0, droppedByDecider = 0, deciderError = false;
  if (toDecide.length) {
    const decisions: JevDecision[] = [];
    toDecide.forEach(({ e, ctx }, j) => {
      decisions.push({ id: `v${j}`, kind: "binary", proposition: `"${e.name}" is a specific named entity (a tool, topic, project, person, organization, or place), not a generic word or phrase`, context: ctx });
      decisions.push({ id: `t${j}`, kind: "choice", question: `What type of entity is "${e.name}"?`, options: TYPE_OPTIONS, context: ctx });
    });
    try {
      const answer = await decide(cfg, decisions, subject);
      ms = answer.ms;
      const byId = new Map(answer.results.map((r) => [r.id, r] as const));
      toDecide.forEach(({ e }, j) => {
        const vr = byId.get(`v${j}`), tr = byId.get(`t${j}`);
        if (vr?.selected !== "true") { droppedByDecider++; return; }
        const type = tr && (ENTITY_TYPES as readonly string[]).includes(tr.selected) ? (tr.selected as EntityType) : e.type;
        kept.push({ ...e, type, confidence: typeof vr.p_true === "number" ? vr.p_true : e.confidence });
      });
    } catch {
      deciderError = true; // the decider is unreachable: keep the model's entities rather than fail the thought
      for (const { e } of toDecide) kept.push({ ...e });
    }
  }

  return { entities: kept, stats: { in: entities.length, carved, decided: toDecide.length, droppedRefused, droppedByDecider, noContext, deciderError, out: kept.length, ms } };
}
