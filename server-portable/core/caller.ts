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

/** A key with neither scope reaching a writer: 116's and 117's READ_ONLY_KEY, naming the key. */
export const readOnly = (principal: Principal) => refuse({ code: "READ_ONLY_KEY", retryable: false, key: principal.name });

/**
 * A store call, or the refusal the database raised as the store's own class (`Refused`): an argument, or for 115 an
 * ingested key. Any other throw stays a fault.
 */
export async function asked<T, E extends Error>(Refused: abstract new (...args: never[]) => E, run: () => Promise<T>): Promise<T | E> {
  try {
    return await run();
  } catch (e) {
    if (e instanceof Refused) return e;
    throw e;
  }
}

type UnattributedCode = "CLAIM_UNATTRIBUTED" | "PRIORITY_UNATTRIBUTED" | "ITEM_UNATTRIBUTED";
/**
 * What a claim's refusal names beyond its cause: its id, whether a force was asked, and when the caller's own claim
 * had lapsed, if it had (SMD-3705). The other two name nothing more.
 */
type ClaimFacts = { id: string; forced: boolean; lapsedAt?: string };

/**
 * The registry's failure to give the caller's agent id (`agentUnresolved`) as `code`'s refusal: retryable while it
 * may answer (unreachable), final until an operator acts (misconfigured, refused). Null when there is no such
 * failure: the caller has its agent id, or no registry was asked for one — a plugin hook's principal, `hook:<plugin>`,
 * has none by design — and what to say then is the caller's (the database's answer, or registry_unknown). One
 * signature per code, so a code widened to a union matches none and a claim's facts can't be left off (review pass 1).
 */
export function unattributedAs(code: "CLAIM_UNATTRIBUTED", principal: Principal, facts: ClaimFacts): Outcome<never, "CLAIM_UNATTRIBUTED"> | null;
export function unattributedAs(code: "PRIORITY_UNATTRIBUTED", principal: Principal): Outcome<never, "PRIORITY_UNATTRIBUTED"> | null;
export function unattributedAs(code: "ITEM_UNATTRIBUTED", principal: Principal): Outcome<never, "ITEM_UNATTRIBUTED"> | null;
export function unattributedAs(code: UnattributedCode, principal: Principal, facts?: ClaimFacts): Outcome<never, UnattributedCode> | null {
  if (principal.agentId !== undefined || principal.agentUnresolved === undefined) return null;
  // Typed by the refusal's own shape, PRIORITY_UNATTRIBUTED's causes the narrowest of the three, so a mistyped cause
  // or a flag paired with the wrong cause fails here, where the overloads guard only the callers (review pass 2).
  const said: Pick<Extract<Refusal, { code: "PRIORITY_UNATTRIBUTED" }>, "retryable" | "cause"> = principal.agentUnresolved === "unreachable"
    ? { retryable: true, cause: "registry_away" }
    : { retryable: false, cause: principal.agentUnresolved === "misconfigured" ? "registry_misconfigured" : "registry_refused" };
  return refuse<never, UnattributedCode>({ code, ...said, ...facts } as Extract<Refusal, { code: UnattributedCode }>);
}
