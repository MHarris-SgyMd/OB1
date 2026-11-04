// What the claim, priority and item operations (claims.ts, priority.ts,
// items.ts) share about their caller and their store's answers, kept in one
// place so the three keep one rule (SMD-3780): each had its own copy, and the
// copies drifted once (SMD-3665 PR 2 review passes 1 and 2).

import type { Principal } from "../auth.ts";
import { refuse, type Outcome, type Refusal } from "./refusal.ts";

/**
 * The scope 116 and 117 read off the envelope: `write` for a write key, `capture` for a capture-only key. A read key
 * states none, and they refuse it (READ_ONLY_KEY); the manifest gives a read key no writer, so that is a caller of
 * the core's own (a plugin's ctx.call under a read key's principal) meeting the database's rule.
 */
export const writerScope = (principal: Principal): "write" | "capture" | undefined =>
  principal.scope === "write" ? "write" : principal.scope === "capture" ? "capture" : undefined;

export const readOnly = (principal: Principal) => refuse({ code: "READ_ONLY_KEY", retryable: false, key: principal.name });

/** A store call, or the refusal the database raised as the store's own class (`Refused`): an argument, or for 115 an ingested key; any other throw stays a fault. */
export async function asked<T, E extends Error>(Refused: abstract new (...args: never[]) => E, run: () => Promise<T>): Promise<T | E> {
  try {
    return await run();
  } catch (e) {
    if (e instanceof Refused) return e;
    throw e;
  }
}

type UnattributedCode = "CLAIM_UNATTRIBUTED" | "PRIORITY_UNATTRIBUTED" | "ITEM_UNATTRIBUTED";
/** What a code's refusal names beyond its cause: a claim's id and whether a force was asked; nothing for the others. */
type UnattributedFacts<C extends UnattributedCode> = Omit<Extract<Refusal, { code: C }>, "code" | "retryable" | "cause">;

/**
 * The registry's failure to give the caller's agent id (`agentUnresolved`) as `code`'s refusal: retryable while it
 * may answer (unreachable), final until an operator acts (misconfigured, refused). Null when there is no such
 * failure: the caller has its agent id, or no registry was asked for one — a plugin hook's principal, `hook:<plugin>`,
 * has none by design — and what to say then is the caller's (the database's answer, or registry_unknown).
 */
export function unattributedAs<C extends UnattributedCode>(code: C, principal: Principal, ...facts: {} extends UnattributedFacts<C> ? [] : [UnattributedFacts<C>]): Outcome<never, C> | null {
  if (principal.agentId !== undefined || principal.agentUnresolved === undefined) return null;
  const refusal = principal.agentUnresolved === "unreachable"
    ? { code, retryable: true, cause: "registry_away", ...facts[0] }
    : { code, retryable: false, cause: principal.agentUnresolved === "misconfigured" ? "registry_misconfigured" : "registry_refused", ...facts[0] };
  return refuse<never, C>(refusal as unknown as Extract<Refusal, { code: C }> & { code: C });
}
