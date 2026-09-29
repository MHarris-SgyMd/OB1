#!/usr/bin/env bun
/**
 * worker-bootstrap.ts — the one place the db/ claim workers bootstrap their
 * provider egress (and, from SMD-2303's later slices, identity and error
 * classification). SMD-2134 cut 3.
 *
 * Before this, extract-entities.ts, consolidate.ts and reembed.ts each carried
 * a near-identical egress banner and blanket gate that differed only in the
 * verb of the refusal ("extracted" / "judged" / "re-embedded"), and
 * sync-linear.ts a fourth variant. They now share this module, and
 * test-cli.ts's census holds that no other db/ file reaches egress.ts's
 * `refusesEverything` or `describeEgress` directly.
 *
 * These functions RETURN their outcome — a refusal string, or null when at
 * least one call would go through — and never call process.exit or touch the
 * sql client. The CLI worker exits on the result today; SMD-2304's importable
 * run() will turn the same result into a return code. Banners are returned as
 * strings for the caller to print with its own label and spacing.
 */

import { describeEgress, refusesEverything, type EgressPolicy, type EgressUnit } from "../server-portable/egress.ts";
import type { ProviderEndpoint } from "../server-portable/embed.ts";

/**
 * One banner line: what the gate does for calls to this endpoint under this
 * policy, in words. The worker prints it under its own `  egress:` label.
 */
export function egressDescription(endpoint: ProviderEndpoint, policy: EgressPolicy, localKnobKey: string): string {
  return describeEgress(endpoint, policy, localKnobKey);
}

/**
 * The bare reason every call to this endpoint would be refused, or null when at
 * least one would go through. `units` are what a row of the pass carries; left
 * undefined it is the full set (an actor credited optimistically before a worker
 * key has, or has not, resolved). A caller that wants the worker's full "Nothing
 * would be <verb>" sentence uses blanketGate; sync-linear.ts, and reembed.ts's
 * blurbs warning, wrap the bare reason in their own text and use this.
 */
export function egressRefusal(
  endpoint: Pick<ProviderEndpoint, "base" | "local">,
  policy: EgressPolicy,
  units?: readonly EgressUnit[],
): string | null {
  return units === undefined ? refusesEverything(endpoint, policy) : refusesEverything(endpoint, policy, units);
}

/**
 * The refusal a claim worker prints before it claims anything: a policy that
 * would refuse whatever the row (SMD-1903) stops the pass rather than fail every
 * row in the pool one at a time. Returns the full sentence, or null when the
 * pass may run. `verb` is the pass's own word for what it does; the remedy tail
 * is one text for every worker.
 */
export function blanketGate(opts: {
  endpoint: Pick<ProviderEndpoint, "base" | "local">;
  policy: EgressPolicy;
  units?: readonly EgressUnit[];
  verb: string;
  localKnobKey: string;
}): string | null {
  const reason = egressRefusal(opts.endpoint, opts.policy, opts.units);
  if (reason === null) return null;
  return `Nothing would be ${opts.verb}: ${reason}. Declare the endpoint local (${opts.localKnobKey}=1) if it is, name what may leave in OB1_EGRESS_ALLOW, or set OB1_EGRESS_POLICY — in words, before a pass that would fail every row it claims.`;
}

/**
 * The re-gate after identity: the blanket gate above credited an actor because a
 * worker key was set, but the key did not resolve to a name, so the pass carries
 * no actor after all and is asked again without one (SMD-2303, from the workers'
 * third review pass). `reason` is egressRefusal(..., ROW_UNITS).
 */
export function regateMessage(verb: string, reason: string): string {
  return `Nothing would be ${verb}: ${reason} — the worker key did not resolve, so the pass carries no actor for an actor: term to name.`;
}
