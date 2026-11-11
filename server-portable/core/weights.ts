// A read's own priority weights (SMD-4193): the refusal the agenda and
// search_thoughts give when the database refuses them by 122's rule, and the
// operator's setting every read takes as its defaults (PR 2, migration 132).
// The schema refuses an unknown name or a value out of range first, by name;
// the database checks them again, and what only it can see (cap below
// unblocks_many_at, which may need a default) comes back in its words.

import type { PriorityWeights } from "../store.ts";
import type { Principal } from "../auth.ts";
import type { Ctx } from "./context.ts";
import { ok, refuse, type Outcome, type Refusal } from "./refusal.ts";
import { PRIORITY_WEIGHT_NAMES, type Input } from "./schemas.ts";
import { actorOf } from "./writes.ts";

/** 122's (128's) refusals of the weights, by their words: lc_messages never translates a RAISE's own message. */
const WEIGHTS_RAISE = /^(?:not a weight: |a weight out of range: |effective_priority's weights are a JSON object)/;

/** The weights a message names, the known names alone, in the input's order. */
const namedIn = (message: string): string[] => PRIORITY_WEIGHT_NAMES.filter((n) => new RegExp(`\\b${n}\\b`).test(message.split(" (")[0]));

/**
 * The refusal for a database error over a read given weights, or null when the error is not 122's refusal of them
 * (another 22023, or any other fault, stays a fault: 132's refusal of the operator's stored setting is 22000).
 */
export function weightsRefused(e: unknown, weights: Partial<PriorityWeights> | undefined): Extract<Refusal, { code: "REFUSED_WEIGHTS" }> | null {
  if (weights === undefined) return null;
  const err = e as { errno?: unknown; message?: unknown };
  const message = String(err?.message ?? "");
  if (String(err?.errno ?? "") !== "22023" || !WEIGHTS_RAISE.test(message)) return null;
  return { code: "REFUSED_WEIGHTS", retryable: false, problem: "rule", message, named: namedIn(message) };
}

/**
 * What the operator's setting did (SMD-4193 PR 2, migration 132): the weights every read now takes as its defaults
 * over the built-in ones (null: none, the built-in weights stand), the setting it replaced, when and by which key the
 * standing one was set, and whether anything was written.
 */
export type WeightsSet = { changed: boolean; weights: Partial<PriorityWeights> | null; previous: Partial<PriorityWeights> | null; setAt: string | null; setBy: string | null; caller: string };
export type WeightsSetCode = "REFUSED_NOT_OPERATOR" | "REFUSED_WEIGHTS";

export async function setPriorityWeights(ctx: Ctx, principal: Principal, { weights }: Input<"set_priority_weights">): Promise<Outcome<WeightsSet, WeightsSetCode>> {
  // Who may is the database's to say: the key's registry kind by its agent id, which the server does not hold. The
  // weights are checked there again, in effective_priority's words (cap against unblocks_many_at). {} clears.
  const result = await (await ctx.store()).setPriorityWeights({ weights: Object.keys(weights).length === 0 ? null : weights, actor: actorOf(ctx, principal) });
  if (!result.ok) {
    if (result.error === "NOT_OPERATOR") return refuse({ code: "REFUSED_NOT_OPERATOR", retryable: false, key: principal.name, kind: result.kind });
    return refuse({ code: "REFUSED_WEIGHTS", retryable: false, problem: "rule", message: result.message, named: namedIn(result.message) });
  }
  // No action-log row, as reset_capture_stamp: 034's log is click-through relevance, and a setting is no search.
  return ok({ changed: result.changed, weights: result.weights, previous: result.previous, setAt: result.setAt, setBy: result.setBy, caller: principal.name });
}
