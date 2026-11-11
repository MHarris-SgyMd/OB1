// A read's own priority weights (SMD-4193): the refusal the agenda and
// search_thoughts give when the database refuses them by 122's rule. The
// schema refuses an unknown name or a value out of range first, by name; the
// database checks them again, and what only it can see (cap below
// unblocks_many_at, which may need a default) comes back 22023 in its words.

import type { PriorityWeights } from "../store.ts";
import type { Refusal } from "./refusal.ts";
import { PRIORITY_WEIGHT_NAMES } from "./schemas.ts";

/** 122's (128's) refusals of the weights, by their words: lc_messages never translates a RAISE's own message. */
const WEIGHTS_RAISE = /^(?:not a weight: |a weight out of range: |effective_priority's weights are a JSON object)/;

/** The weights a message names, the known names alone, in the input's order. */
const namedIn = (message: string): string[] => PRIORITY_WEIGHT_NAMES.filter((n) => new RegExp(`\\b${n}\\b`).test(message.split(" (")[0]));

/**
 * The refusal for a database error over a read given weights, or null when the error is not 122's refusal of them
 * (another 22023, or any other fault, stays a fault).
 */
export function weightsRefused(e: unknown, weights: Partial<PriorityWeights> | undefined): Extract<Refusal, { code: "REFUSED_WEIGHTS" }> | null {
  if (weights === undefined) return null;
  const err = e as { errno?: unknown; message?: unknown };
  const message = String(err?.message ?? "");
  if (String(err?.errno ?? "") !== "22023" || !WEIGHTS_RAISE.test(message)) return null;
  return { code: "REFUSED_WEIGHTS", retryable: false, problem: "rule", message, named: namedIn(message) };
}
