/**
 * thoughts.ts — the vocabulary and presentation rules for a captured thought.
 *
 * Extracted from index.ts for testability, not tidiness. These are pure decisions
 * with real edge cases — an alias table, an 80-character truncation, a trailing
 * slash — and index.ts exports nothing but its fetch handler, so exercising any of
 * them meant booting a server, stubbing a model provider and driving a capture over
 * JSON-RPC, once per case. That is a heavy way to assert that `action_item` maps to
 * `task`, and heavy enough that nobody did: none of this had a direct test.
 *
 * `thoughtUrl` takes its base as an argument rather than reading the environment,
 * which is what lets this file be tested without one.
 */

/**
 * The `type` field is a closed set, but only the prompt says so — nothing enforced
 * it, so a model free to invent one did. Observed for real: llama3.2 returned
 * "action_item" for a reminder.
 *
 * Unenforced, that fragments the taxonomy silently. `list_thoughts` filtering on
 * `type=task` misses the row, and `thought_stats` accumulates a long tail of
 * one-off types that look like categories but are model noise. A smaller local
 * model drifts more than a hosted one, which makes this matter more now that the
 * local path is supported.
 *
 * Unknown values are coerced to `observation` — the same neutral default the
 * failure path uses — and the model's original answer is kept in `type_raw` so
 * drift is visible rather than discarded.
 */
export const THOUGHT_TYPES = ["observation", "task", "idea", "reference", "person_note"] as const;

export const TYPE_ALIASES: Record<string, (typeof THOUGHT_TYPES)[number]> = {
  action_item: "task",
  action: "task",
  todo: "task",
  note: "observation",
  fact: "reference",
  person: "person_note",
  contact: "person_note",
};

export function normaliseType(raw: unknown): { type: string; raw?: string } {
  if (typeof raw !== "string" || raw.trim() === "") return { type: "observation" };
  const key = raw.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if ((THOUGHT_TYPES as readonly string[]).includes(key)) return { type: key };
  const aliased = TYPE_ALIASES[key];
  if (aliased) return { type: aliased, raw: raw.trim() };
  console.warn(`extractMetadata: model returned type "${raw}", which is not one of ${THOUGHT_TYPES.join(", ")}; recorded as observation`);
  return { type: "observation", raw: raw.trim() };
}

export function thoughtTitle(content: string, createdAt?: string): string {
  const firstLine = content.replace(/\s+/g, " ").trim().slice(0, 80);
  const datePrefix = createdAt ? new Date(createdAt).toLocaleDateString() : "Open Brain";
  return firstLine ? `${datePrefix} - ${firstLine}` : `${datePrefix} thought`;
}

export function thoughtUrl(base: string, id: string): string {
  return `${base.replace(/\/$/, "")}/${id}`;
}
