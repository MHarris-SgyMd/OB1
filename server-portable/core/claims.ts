// Work claims (SMD-3598): who holds a ticket, or one piece of it, under a lease
// — migration 115's four functions (SMD-3597) as operations of the core, so the
// REST core and the MCP server answer them alike. The database decides every
// rule: who holds a claim (the key and the token), what is in the way, who may
// force a release (an operator by agent id). This file passes the caller's
// envelope and turns 115's answers into values and refusals, saying what 115
// cannot: a claim held by the caller's own key, and one refused only because
// the registry cannot give the caller's agent id. It keeps the token — a bearer
// secret to its key — in claim_work's one answer and a bind parameter: no
// refusal, error message or log line carries it.

import type { Principal } from "../auth.ts";
import { ClaimRefused, UUID_RE, type ClaimLease, type ClaimLeaseWork, type ClosedTicket, type WorkClaim } from "../store.ts";
import { asked, unattributedAs } from "./caller.ts";
import type { Ctx } from "./context.ts";
import { ok, refuse, type HeldClaim, type Outcome } from "./refusal.ts";
import type { Input } from "./schemas.ts";
import { actorOf } from "./writes.ts";

/**
 * A renewal that revived a lapsed claim (SMD-3654): when its lease had run out,
 * and the claims made or renewed on its work since — work another agent may
 * have built on while it was free, each with its `renewedAt`. `claimedSince`
 * is null when they could not be read, and holds the first SINCE_MAX,
 * `moreSince` counting the rest. `at` is null when
 * the lease before the renewal could not be read, so whether it had lapsed is
 * unknown (review pass 1: that was said as nothing at all). Absent on a renewal
 * of a live claim. 115 revives a lapsed claim nothing covers without a word;
 * this is the word.
 */
export type ClaimLapse = { at: string | null; claimedSince: (HeldClaim & { renewedAt: string | null; state: WorkClaim["state"]; releasedAt: string | null })[] | null; moreSince?: number };
/** How many of the claims made since a lapse a reply names (review pass 1: a long lapse could list without end). */
const SINCE_MAX = 10;
/** claim_work's value: the claim, and on `claimed` the token that proves it — shown this once. `ticketClosed` when the brain records its ticket as closed: board-sync releases the claim at its next pass (SMD-3600). */
export type ClaimWorkResult = { outcome: "claimed" | "renewed"; claim: WorkClaim; token?: string; lapsed?: ClaimLapse; ticketClosed?: ClosedTicket };
export type ClaimWorkCode = "WORK_CLAIMED" | "CLAIM_LIMIT" | "REFUSED_CLAIM_INPUT" | "REFUSED_CLAIM_KEY" | "CLAIM_RELEASED" | "CLAIM_UNATTRIBUTED";
export type RenewClaimResult = { claim: WorkClaim; lapsed?: ClaimLapse; ticketClosed?: ClosedTicket };
export type RenewClaimCode = "CLAIM_NOT_FOUND" | "CLAIM_NOT_YOURS" | "CLAIM_RELEASED" | "WORK_CLAIMED" | "REFUSED_CLAIM_INPUT" | "CLAIM_UNATTRIBUTED";
export type ReleaseClaimResult = { outcome: "released" | "already_released"; claim: WorkClaim };
export type ReleaseClaimCode = "CLAIM_NOT_FOUND" | "CLAIM_NOT_YOURS" | "REFUSED_CLAIM_INPUT" | "CLAIM_UNATTRIBUTED";
/** list_claims' value: the claims, and whether the limit cut the list (narrow by ticket or holder to see the rest). */
export type ListClaimsResult = { claims: WorkClaim[]; truncated: boolean };

/** 115's own release reason for a claim taken over after it lapsed (its claim_work writes it). */
export const TAKEN_OVER = "lapsed; taken over";
/**
 * Whether board-sync ended a claim because its ticket closed (SMD-3600): 118's reason for this ticket, word for word —
 * `<issue> closed: <status> (<settled type>); <run>` — by a releaser neither an operator nor an agent (board-sync's key
 * is ingested, or unclassified on a brain that never classified it). An operator's or a holder's own reason worded
 * alike is theirs to be read as written (review pass 2).
 */
export const closedBySync = (issue: string | null | undefined, reason: string | null | undefined, kind: string | null | undefined): boolean => {
  if (!issue || !reason || kind === "operator" || kind === "agent") return false;
  const head = `${issue} closed: `;
  return reason.startsWith(head) && /^.+ \((?:completed|canceled|duplicate)\); .+$/.test(reason.slice(head.length));
};
/** 115's clamp on list_work_claims' limit. */
const LIST_MAX = 1000;

/** The claim's holder is the caller's own key — another session of it, or this one without its token — so the words say so rather than name the caller's key as someone else's. */
const ownKey = (principal: Principal, c: WorkClaim | null) => !!c && c.holder === principal.name;
const held = (principal: Principal) => (c: WorkClaim): HeldClaim => ({ id: c.id, issue: c.issue, piece: c.piece, holder: c.holder, holderKind: c.holderKind, claimedAt: c.claimedAt, expiresAt: c.expiresAt, ownKey: ownKey(principal, c) });
/** A claim that ended, refused a renewal: by whom and why, and whether it was taken over — work to stop. */
const releasedRefusal = (id: string, c: WorkClaim | null) =>
  refuse({ code: "CLAIM_RELEASED", retryable: false, id, releasedAt: c?.releasedAt ?? null, takenOver: c?.releaseReason === TAKEN_OVER, releasedBy: c?.releasedBy ?? null, reason: c?.releaseReason ?? null, ticketClosed: closedBySync(c?.issue, c?.releaseReason, c?.releasedByKind) });
const notYoursRefusal = (principal: Principal, id: string, c: WorkClaim | null, forced: boolean) =>
  refuse({ code: "CLAIM_NOT_YOURS", retryable: false, id, holder: c?.holder ?? "", forced, ownKey: ownKey(principal, c), expiresAt: c?.expiresAt ?? null });
/** A token as claim_work mints it: lower-case hex. One a model upper-cased is the same token. */
const tokenOf = (t: string | undefined) => t?.toLowerCase();

/**
 * 115's own words for an argument it refused: never a token (it names the token's rule, not its value) — with a hint
 * for the two swaps an agent makes: a claim id where the token goes, a piece inside the ticket.
 */
const argumentRefused = (e: ClaimRefused, given: { token?: string; ticket?: string } = {}) => {
  const hint = e.problem === "token" && given.token !== undefined && UUID_RE.test(given.token.trim()) ? " — that is a claim id; the token is the wc_ value claim_work returned"
    : e.problem === "ticket" && given.ticket !== undefined && /^\s*[A-Za-z][A-Za-z0-9]*-\d+\s+\S/.test(given.ticket) ? " — pass the ticket's key as `ticket` and the rest (e.g. `PR 4`) as `piece`"
    : "";
  return refuse({ code: "REFUSED_CLAIM_INPUT", retryable: false, problem: e.problem, message: e.message + hint });
};

/**
 * This key's own claim, made under its agent id, while that id is not to hand (the registry away or set up wrong):
 * 115 matches such a claim by the id alone, so the holder's own key and token read as another's. Only when the
 * token given is this claim's — read against its hash — is it said as that, never as CLAIM_NOT_YOURS: an agent told
 * its token is wrong may drop a good one and lose the work to a takeover. A wrong token stays CLAIM_NOT_YOURS.
 */
async function ownWhileAway(ctx: Ctx, principal: Principal, claim: WorkClaim | null, token: string | undefined): Promise<boolean> {
  if (principal.agentId !== undefined || !claim || token === undefined || claim.holder !== principal.name || claim.holderAgentId === null) return false;
  return (await ctx.store()).claimTokenIs(claim.id, token);
}
/**
 * Its callers hold no agent id. With no registry failure named either, the cause is registry_unknown. `expiresAt`, the
 * caller's own claim's lease: one run out is said (`lapsedAt`), since another claim may cover its work by now, which
 * 115 would name once the registry answers (SMD-3705 review pass 1: "keep the token" hid it).
 */
const unattributedRefusal = (principal: Principal, id: string, forced: boolean, expiresAt?: string | null) => {
  const facts = { id, forced, ...(expiresAt && Date.parse(expiresAt) <= Date.now() ? { lapsedAt: expiresAt } : {}) };
  return unattributedAs("CLAIM_UNATTRIBUTED", principal, facts) ?? refuse({ code: "CLAIM_UNATTRIBUTED", retryable: false, cause: "registry_unknown", ...facts });
};

/**
 * The lease a token's claim had before a renewal (SMD-3654): 115's writers answer
 * with the new lease, so whether the renewal revived a lapsed claim is read here,
 * first — by id and token for renew_claim, which the primary key finds (review
 * pass 1: the token alone scanned the table), by token for claim_work. Null: no
 * claim has the token (the writer will say so). "unread": the read failed, and a
 * renewal that then succeeds says it could not tell whether the claim had lapsed.
 */
type LeaseBefore = ClaimLease | null | "unread";
async function leaseBefore(ctx: Ctx, token: string | undefined, id?: string, work?: ClaimLeaseWork): Promise<LeaseBefore | undefined> {
  if (token === undefined) return undefined;
  try { return await (await ctx.store()).claimLease(token, id, work); } catch { return "unread"; }
}

/** The lapse a renewal revived, if it did: the lease before had run out by the renewal. With the claims made or renewed on the work since (the first SINCE_MAX, the rest counted), or null when they can't be read. */
async function lapseOf(ctx: Ctx, principal: Principal, before: LeaseBefore | undefined, claim: WorkClaim): Promise<ClaimLapse | undefined> {
  if (before === "unread") return { at: null, claimedSince: null };
  if (!before || before.id !== claim.id || before.releasedAt !== null) return undefined;
  const renewedAt = Date.parse(claim.renewedAt ?? "") || Date.now();
  if (!(Date.parse(before.expiresAt) <= renewedAt)) return undefined;
  try {
    // Read bounded, the rest counted by the store (review pass 2: every row was fetched for ten).
    const since = await (await ctx.store()).claimsMadeSince(claim.id, before.expiresAt, SINCE_MAX);
    const named = since.claims.slice(0, SINCE_MAX).map((c) => ({ ...held(principal)(c), renewedAt: c.renewedAt, state: c.state, releasedAt: c.releasedAt }));
    return { at: before.expiresAt, claimedSince: named, ...(since.total > named.length ? { moreSince: since.total - named.length } : {}) };
  } catch {
    return { at: before.expiresAt, claimedSince: null };
  }
}

/** Whether the claim's ticket is one board-sync will release it from (SMD-3600): best-effort, as the claimed label is — a failed read says nothing, and the claim stands. */
async function closedOf(ctx: Ctx, issue: string): Promise<ClosedTicket | null> {
  try { return await (await ctx.store()).closedTicket(issue); } catch (e) {
    const err = e as { errno?: unknown; code?: unknown; message?: unknown };
    console.error(`claims: whether ${issue} is closed could not be read (${String(err.errno ?? err.code ?? "no code")}): ${String(err.message ?? e).slice(0, 200)}; the reply says nothing of it`);
    return null;
  }
}

/** An outcome 115 does not give for this call — said without the answer, which may carry the token. */
const unread = (what: string): never => {
  throw new Error(`${what} answered an outcome this server does not read`);
};

export async function claimWork(ctx: Ctx, principal: Principal, input: Input<"claim_work">): Promise<Outcome<ClaimWorkResult, ClaimWorkCode>> {
  const before = await leaseBefore(ctx, tokenOf(input.token), undefined, { ticket: input.ticket, piece: input.piece, name: principal.name, agentId: principal.agentId });
  // The caller's own token whose claim on exactly this work ended — released, or taken over after it lapsed — is
  // refused as renew_claim refuses it, before 115's writer, which would make a new claim without a word: the silent
  // revival by the other door (review pass 3). Only that work: a token passed while claiming other work — a split's
  // pieces, the next ticket — is 115's to ignore, and a new claim is right (review pass 4). Another key's token is the
  // writer's too, as renew_claim names the holder before the end. Without a token, a new claim as before.
  if (before && before !== "unread" && before.releasedAt !== null && before.ownOnThisWork === true) {
    return refuse({ code: "CLAIM_RELEASED", retryable: false, id: before.id, releasedAt: before.releasedAt, takenOver: before.releaseReason === TAKEN_OVER, releasedBy: before.releasedBy, reason: before.releaseReason, ticketClosed: closedBySync(before.issue, before.releaseReason, before.releasedByKind) });
  }
  // SMD-3705: its own claim on exactly this work, unreleased (an ended one was answered above), made under its agent
  // id while that id is not to hand — 115's holder test reads it as another's, and its writer would take a lapsed one
  // over, or answer a live one WORK_CLAIMED. Refused as renew_claim refuses it; the lease read by the token's hash is
  // the proof ownWhileAway's claimTokenIs gives there. One made by name alone is 115's own by name, and renews.
  if (principal.agentId === undefined && before && before !== "unread" && before.ownOnThisWork === true && before.byAgentId === true) {
    return unattributedRefusal(principal, before.id, false, before.expiresAt);
  }
  const a = await asked(ClaimRefused, async () => (await ctx.store()).claimWork({
    issue: input.ticket, piece: input.piece, label: input.label, leaseSeconds: input.lease_seconds, token: tokenOf(input.token), actor: actorOf(ctx, principal),
  }));
  if (a instanceof ClaimRefused) {
    return a.kind === "ingested" ? refuse({ code: "REFUSED_CLAIM_KEY", retryable: false, key: principal.name }) : argumentRefused(a, { token: input.token, ticket: input.ticket });
  }
  if (a.outcome === "refused" && a.code === "WORK_CLAIMED") {
    // The ticket as 115 keyed it (cleaned, upper-cased), read off the claims in the way; the piece is the caller's own.
    return refuse({ code: "WORK_CLAIMED", retryable: false, ticket: a.heldBy[0]?.issue ?? input.ticket.trim().toUpperCase(), piece: input.piece ?? null, heldBy: a.heldBy.map(held(principal)) });
  }
  // The holder already holds its cap of live claims (SMD-3606, migration 140): a new claim is refused until one ends or
  // the operator raises the cap. 140 answers with no claim and no held_by, the cap and the count beside the code.
  if (a.outcome === "refused" && a.code === "CLAIM_LIMIT") {
    return refuse({ code: "CLAIM_LIMIT", retryable: false, ticket: input.ticket.trim().toUpperCase(), piece: input.piece ?? null, cap: a.cap ?? 0, held: a.held ?? 0 });
  }
  // A claim is answered with the token that proves it; a `claimed` without one would leave a claim nobody can prove.
  if (a.outcome === "claimed" && a.claim && a.token) {
    const closed = await closedOf(ctx, a.claim.issue);
    return ok({ outcome: "claimed", claim: a.claim, token: a.token, ...(closed ? { ticketClosed: closed } : {}) });
  }
  if (a.outcome === "renewed" && a.claim) {
    const lapsed = await lapseOf(ctx, principal, before, a.claim);
    const closed = await closedOf(ctx, a.claim.issue);
    return ok({ outcome: "renewed", claim: a.claim, ...(lapsed ? { lapsed } : {}), ...(closed ? { ticketClosed: closed } : {}) });
  }
  return unread("claim_work");
}

export async function renewClaim(ctx: Ctx, principal: Principal, input: Input<"renew_claim">): Promise<Outcome<RenewClaimResult, RenewClaimCode>> {
  // A string that is no uuid names no claim; the function's cast would raise it as a fault.
  if (!UUID_RE.test(input.id)) return refuse({ code: "CLAIM_NOT_FOUND", retryable: false, id: input.id });
  const token = tokenOf(input.token)!;
  const before = await leaseBefore(ctx, token, input.id);
  const a = await asked(ClaimRefused, async () => (await ctx.store()).renewClaim({ id: input.id, token, leaseSeconds: input.lease_seconds, actor: actorOf(ctx, principal) }));
  if (a instanceof ClaimRefused) return argumentRefused(a, { token: input.token });
  if (a.outcome === "renewed" && a.claim) {
    const lapsed = await lapseOf(ctx, principal, before, a.claim);
    // The rule and the hook renew here: a closed ticket said on this door too (review pass 2).
    const closed = await closedOf(ctx, a.claim.issue);
    return ok({ claim: a.claim, ...(lapsed ? { lapsed } : {}), ...(closed ? { ticketClosed: closed } : {}) });
  }
  switch (a.outcome === "refused" ? a.code : null) {
    case "CLAIM_NOT_FOUND": return refuse({ code: "CLAIM_NOT_FOUND", retryable: false, id: input.id });
    case "CLAIM_NOT_YOURS":
      if (await ownWhileAway(ctx, principal, a.claim, token)) {
        // 115 reads the holder before the end: the holder's own ended claim is CLAIM_RELEASED, as with its id to hand.
        return a.claim?.releasedAt ? releasedRefusal(input.id, a.claim) : unattributedRefusal(principal, input.id, false, a.claim?.expiresAt);
      }
      return notYoursRefusal(principal, input.id, a.claim, false);
    case "CLAIM_RELEASED": return releasedRefusal(input.id, a.claim);
    case "WORK_CLAIMED": return refuse({ code: "WORK_CLAIMED", retryable: false, ticket: a.claim?.issue ?? "", piece: a.claim?.piece ?? null, heldBy: a.heldBy.map(held(principal)) });
  }
  return unread("renew_work_claim");
}

export async function releaseClaim(ctx: Ctx, principal: Principal, input: Input<"release_claim">): Promise<Outcome<ReleaseClaimResult, ReleaseClaimCode>> {
  if (!UUID_RE.test(input.id)) return refuse({ code: "CLAIM_NOT_FOUND", retryable: false, id: input.id });
  const token = tokenOf(input.token);
  const a = await asked(ClaimRefused, async () => (await ctx.store()).releaseClaim({ id: input.id, token, reason: input.reason, force: input.force, actor: actorOf(ctx, principal) }));
  if (a instanceof ClaimRefused) return argumentRefused(a, { token: input.token });
  if ((a.outcome === "released" || a.outcome === "already_released") && a.claim) return ok({ outcome: a.outcome, claim: a.claim });
  switch (a.outcome === "refused" ? a.code : null) {
    case "CLAIM_NOT_FOUND": return refuse({ code: "CLAIM_NOT_FOUND", retryable: false, id: input.id });
    case "CLAIM_NOT_YOURS":
      // 115 answers an ended claim already_released before it reads the holder, so a claim here is unreleased, live or lapsed: a release gives no `lapsedAt`, since dropping a claim needs none.
      if (await ownWhileAway(ctx, principal, a.claim, token)) return unattributedRefusal(principal, input.id, false);
      // A force judged without the id that classifies an operator: said as that, to retry once the registry answers.
      if (input.force === true && principal.agentId === undefined) return unattributedRefusal(principal, input.id, true);
      return notYoursRefusal(principal, input.id, a.claim, input.force === true);
  }
  return unread("release_work_claim");
}

export async function listClaims(ctx: Ctx, _principal: Principal, input: Input<"list_claims">): Promise<Outcome<ListClaimsResult>> {
  // One more than asked says whether the limit cut the list; at 115's clamp a full page is said cut, as it may be.
  const rows = await (await ctx.store()).listClaims({ issue: input.ticket, holder: input.holder, includeEnded: input.include_ended, limit: Math.min(input.limit + 1, LIST_MAX) });
  return ok({ claims: rows.slice(0, input.limit), truncated: rows.length > input.limit || (input.limit === LIST_MAX && rows.length === LIST_MAX) });
}
