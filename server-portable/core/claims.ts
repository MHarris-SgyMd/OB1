// Work claims (SMD-3598): who holds a ticket, or one piece of it, under a lease
// — migration 115's four functions (SMD-3597) as operations of the core, so the
// REST core and the MCP server answer them alike. The database decides every
// rule: who holds a claim (the key and the token), what is in the way, who may
// force a release (an operator by agent id). This file passes the caller's
// envelope, turns 115's answers into values and refusals, and keeps the token —
// a bearer secret to its key — in claim_work's one answer and nowhere else: no
// refusal, error message or log line carries it.

import type { Principal } from "../auth.ts";
import { ClaimRefused, UUID_RE, type ClaimAnswer, type WorkClaim } from "../store.ts";
import type { Ctx } from "./context.ts";
import { ok, refuse, type HeldClaim, type Outcome } from "./refusal.ts";
import type { Input } from "./schemas.ts";
import { actorOf } from "./writes.ts";

/** claim_work's value: the claim, and on `claimed` the token that proves it — shown this once. */
export type ClaimWorkResult = { outcome: "claimed" | "renewed"; claim: WorkClaim; token?: string };
export type ClaimWorkCode = "WORK_CLAIMED" | "REFUSED_CLAIM_INPUT" | "REFUSED_CLAIM_KEY" | "CLAIM_UNATTRIBUTED";
export type RenewClaimResult = { claim: WorkClaim };
export type RenewClaimCode = "CLAIM_NOT_FOUND" | "CLAIM_NOT_YOURS" | "CLAIM_RELEASED" | "WORK_CLAIMED" | "REFUSED_CLAIM_INPUT" | "CLAIM_UNATTRIBUTED";
export type ReleaseClaimResult = { outcome: "released" | "already_released"; claim: WorkClaim };
export type ReleaseClaimCode = "CLAIM_NOT_FOUND" | "CLAIM_NOT_YOURS" | "REFUSED_CLAIM_INPUT" | "CLAIM_UNATTRIBUTED";
export type ListClaimsResult = { claims: WorkClaim[] };

const held = (c: WorkClaim): HeldClaim => ({ id: c.id, issue: c.issue, piece: c.piece, holder: c.holder, holderKind: c.holderKind, claimedAt: c.claimedAt, expiresAt: c.expiresAt });

/** A store call, or the refusal 115 raised for an argument or an ingested key; any other throw stays a fault. */
async function asked(run: () => Promise<ClaimAnswer>): Promise<ClaimAnswer | ClaimRefused> {
  try {
    return await run();
  } catch (e) {
    if (e instanceof ClaimRefused) return e;
    throw e;
  }
}

/** 115's own words for an argument it refused: never a token (it names the token's rule, not its value). */
const argumentRefused = (e: ClaimRefused) => refuse({ code: "REFUSED_CLAIM_INPUT", retryable: false, problem: e.problem, message: e.message });

/**
 * A claim this key made under its agent id, refused while that id is not to hand (the registry away or set up
 * wrong): 115 matches such a claim by the id alone, so the holder's own key and token read as another's. Said as
 * that, never as CLAIM_NOT_YOURS — an agent told its token is wrong may drop it and lose the work to a takeover.
 */
const unattributed = (principal: Principal, claims: WorkClaim[]): WorkClaim | undefined =>
  principal.agentId === undefined ? claims.find((c) => c.holder === principal.name && c.holderAgentId !== null) : undefined;
const unattributedRefusal = (principal: Principal, id: string | null) =>
  principal.agentUnresolved === "unreachable"
    ? refuse({ code: "CLAIM_UNATTRIBUTED", retryable: true, cause: "registry_away", id })
    : refuse({ code: "CLAIM_UNATTRIBUTED", retryable: false, cause: principal.agentUnresolved === "misconfigured" ? "registry_misconfigured" : principal.agentUnresolved === "refused" ? "registry_refused" : "registry_unknown", id });

/** An outcome 115 does not give for this call — said without the answer, which may carry the token. */
const unread = (what: string): never => {
  throw new Error(`${what} answered an outcome this server does not read`);
};

export async function claimWork(ctx: Ctx, principal: Principal, input: Input<"claim_work">): Promise<Outcome<ClaimWorkResult, ClaimWorkCode>> {
  const a = await asked(async () => (await ctx.store()).claimWork({
    issue: input.ticket, piece: input.piece, label: input.label, leaseSeconds: input.lease_seconds, token: input.token, actor: actorOf(ctx, principal),
  }));
  if (a instanceof ClaimRefused) {
    return a.kind === "ingested" ? refuse({ code: "REFUSED_CLAIM_KEY", retryable: false, key: principal.name }) : argumentRefused(a);
  }
  if (a.outcome === "refused" && a.code === "WORK_CLAIMED") {
    // With a token, the caller's own claim in the way while its id is away: not another's (115 cannot tell).
    const own = input.token !== undefined ? unattributed(principal, a.heldBy) : undefined;
    if (own) return unattributedRefusal(principal, own.id);
    // The ticket as 115 keyed it (cleaned, upper-cased), read off the claims in the way; the piece is the caller's own.
    return refuse({ code: "WORK_CLAIMED", retryable: false, ticket: a.heldBy[0]?.issue ?? input.ticket.trim().toUpperCase(), piece: input.piece ?? null, heldBy: a.heldBy.map(held) });
  }
  // A claim is answered with the token that proves it; a `claimed` without one would leave a claim nobody can prove.
  if (a.outcome === "claimed" && a.claim && a.token) return ok({ outcome: "claimed", claim: a.claim, token: a.token });
  if (a.outcome === "renewed" && a.claim) return ok({ outcome: "renewed", claim: a.claim });
  return unread("claim_work");
}

export async function renewClaim(ctx: Ctx, principal: Principal, input: Input<"renew_claim">): Promise<Outcome<RenewClaimResult, RenewClaimCode>> {
  // A string that is no uuid names no claim; the function's cast would raise it as a fault.
  if (!UUID_RE.test(input.id)) return refuse({ code: "CLAIM_NOT_FOUND", retryable: false, id: input.id });
  const a = await asked(async () => (await ctx.store()).renewClaim({ id: input.id, token: input.token, leaseSeconds: input.lease_seconds, actor: actorOf(ctx, principal) }));
  if (a instanceof ClaimRefused) return argumentRefused(a);
  if (a.outcome === "renewed" && a.claim) return ok({ claim: a.claim });
  switch (a.outcome === "refused" ? a.code : null) {
    case "CLAIM_NOT_FOUND": return refuse({ code: "CLAIM_NOT_FOUND", retryable: false, id: input.id });
    case "CLAIM_NOT_YOURS":
      if (a.claim && unattributed(principal, [a.claim])) return unattributedRefusal(principal, input.id);
      return refuse({ code: "CLAIM_NOT_YOURS", retryable: false, id: input.id, holder: a.claim?.holder ?? "", forced: false });
    case "CLAIM_RELEASED": return refuse({ code: "CLAIM_RELEASED", retryable: false, id: input.id, releasedAt: a.claim?.releasedAt ?? null });
    case "WORK_CLAIMED": return refuse({ code: "WORK_CLAIMED", retryable: false, ticket: a.claim?.issue ?? "", piece: a.claim?.piece ?? null, heldBy: a.heldBy.map(held) });
  }
  return unread("renew_work_claim");
}

export async function releaseClaim(ctx: Ctx, principal: Principal, input: Input<"release_claim">): Promise<Outcome<ReleaseClaimResult, ReleaseClaimCode>> {
  if (!UUID_RE.test(input.id)) return refuse({ code: "CLAIM_NOT_FOUND", retryable: false, id: input.id });
  const a = await asked(async () => (await ctx.store()).releaseClaim({ id: input.id, token: input.token, reason: input.reason, force: input.force, actor: actorOf(ctx, principal) }));
  if (a instanceof ClaimRefused) return argumentRefused(a);
  if ((a.outcome === "released" || a.outcome === "already_released") && a.claim) return ok({ outcome: a.outcome, claim: a.claim });
  switch (a.outcome === "refused" ? a.code : null) {
    case "CLAIM_NOT_FOUND": return refuse({ code: "CLAIM_NOT_FOUND", retryable: false, id: input.id });
    case "CLAIM_NOT_YOURS":
      // Its own claim, or a force by a key whose id — what classifies an operator — is not to hand.
      if ((a.claim && unattributed(principal, [a.claim])) || (input.force === true && principal.agentId === undefined)) return unattributedRefusal(principal, input.id);
      return refuse({ code: "CLAIM_NOT_YOURS", retryable: false, id: input.id, holder: a.claim?.holder ?? "", forced: input.force === true });
  }
  return unread("release_work_claim");
}

export async function listClaims(ctx: Ctx, _principal: Principal, input: Input<"list_claims">): Promise<Outcome<ListClaimsResult>> {
  return ok({ claims: await (await ctx.store()).listClaims({ issue: input.ticket, holder: input.holder, includeEnded: input.include_ended, limit: input.limit }) });
}
