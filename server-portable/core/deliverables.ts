// Deliverables (SMD-1715 PR 2): migration 134's calls as operations of the
// core, so the REST core and the MCP server answer them alike. The database
// decides every rule — the allowed moves, who may not verify, the same
// deliverable again — and this file sends the caller's envelope with its scope
// stated, and turns 134's answers into values and refusals.
//
// capture_deliverable is a capture and a record. The thought is captured as
// capture_thought captures one (its egress, embedding, chunks and tags), its
// derived_from the spec, and its text closing with the checkpoint, so a new
// checkpoint is a new thought (the maintainer's definition of 2026-11-12: a
// deliverable's checkpoint never changes, and reworked output is a new
// deliverable). The two are two statements, not one transaction (134's header
// speaks of one; the capture path is many statements — one transaction is
// SMD-4248). So the key's scope, the spec and whether the text is a thought
// already are asked before the capture, and asked again of the thought the
// capture lands on, which another call may have written meanwhile.
//
// A deliverable is a thought this call's key wrote, derived from its spec
// (the maintainer, 2026-11-12). Text that is a thought already is answered by
// what that thought is (onExisting, below).
// Nothing is ever deleted: a record that does not land after a fresh capture
// leaves the thought, the refusal naming it, and the same call again records
// it (review pass 2: a delete could take a thought another key had just been
// told was stored). The text is held by its fingerprint (016), which ignores
// letter case and runs of white space, so two checkpoints that differ only
// there name one thought.

import type { Principal } from "../auth.ts";
import type { DeliverableAnswer } from "../deliverables.ts";
import type { Deliverable, DeliverableEvent, DeliverableRecord } from "../store.ts";
import type { Ctx } from "./context.ts";
import { ok, refuse, type Outcome, type RefusalCode } from "./refusal.ts";
import type { Input } from "./schemas.ts";
import { actorOf, capture, type Captured } from "./writes.ts";

/** The line a deliverable's text closes with: its checkpoint, so the thought's own fingerprint names it. */
export const checkpointLine = (checkpoint: string) => `Checkpoint: ${checkpoint}`;
/** A deliverable's text as captured: the output's words, a blank line, its checkpoint line. */
export const deliverableText = (content: string, checkpoint: string) => `${content.trim()}\n\n${checkpointLine(checkpoint)}`;

/**
 * What the capture did, as a deliverable's answer says it: capture_thought's safe fields alone (render.ts's
 * safeCapture), so neither door's value carries the provider's address, the egress policy's words or the extractor's
 * tags (review pass 1). `noVector` says why the thought has no vector yet: the policy refused the call, or the
 * provider did not answer.
 */
export type CaptureSummary = { id: string; existed: boolean | null; chunks: number; contextFailures: number; noVector: "refused" | "provider_down" | null };
const summaryOf = (c: Captured): CaptureSummary => ({
  id: c.id, existed: c.existed ?? null, chunks: c.chunks, contextFailures: c.contextFailures,
  noVector: !c.embeddings.allowed ? "refused" : c.vectorFailed ? "provider_down" : null,
});

type WriterCode = "WRITE_SCOPE_REQUIRED" | "NOT_FOUND";
/** `capture` is null when this call captured nothing: its text was a thought already, answered by what that thought is. */
export type CaptureDeliverableResult = { outcome: "captured" | "unchanged"; deliverable: Deliverable; event: DeliverableEvent | null; capture: CaptureSummary | null };
/** capture_thought's own refusals stand (a refused egress, a provider down…), the spec's missing one renamed. */
export type CaptureDeliverableCode = Exclude<RefusalCode, "DERIVED_FROM_MISSING"> | WriterCode | "SPEC_NOT_FOUND" | "SPEC_IS_SELF" | "ALREADY_A_DELIVERABLE" | "OUTPUT_EXISTS";
export type VerifyDeliverableResult = { outcome: "changed"; deliverable: Deliverable; event: DeliverableEvent | null; from: string; to: string };
export type VerifyDeliverableCode = WriterCode | "NOT_A_DELIVERABLE" | "ILLEGAL_TRANSITION" | "VERIFY_NOT_YOURS";
/** deliverable_history's value: the deliverable (null when its thought was deleted: its events stay) and every event, oldest first. */
export type DeliverableHistoryResult = DeliverableRecord;
export type DeliverableHistoryCode = "NOT_A_DELIVERABLE";

const writeScopeRequired = (principal: Principal) => refuse({ code: "WRITE_SCOPE_REQUIRED", retryable: false, key: principal.name });
const id = (s: string) => s.trim().toLowerCase();

/**
 * A refusal 134 answered as a value, by its code. ALREADY_A_DELIVERABLE names what was recorded on the thought, read
 * from its capture event, since 134 answers it in words alone; VERIFY_NOT_YOURS says which rule refused, by its words' close (they
 * open with the key's own name, which the server does not choose).
 */
async function refusedBy(ctx: Ctx, a: DeliverableAnswer, principal: Principal, thought: string, spec = "", left?: string) {
  switch (a.code) {
    case "WRITE_SCOPE_REQUIRED": return writeScopeRequired(principal);
    case "THOUGHT_NOT_FOUND": return refuse({ code: "NOT_FOUND", retryable: false, id: thought });
    // `left`: the thought a fresh capture wrote before the record was refused, which stays (review pass 2).
    case "SPEC_NOT_FOUND": return refuse({ code: "SPEC_NOT_FOUND", retryable: false, spec, ...(left ? { left } : {}) });
    case "SPEC_IS_SELF": return refuse({ code: "SPEC_IS_SELF", retryable: false, id: thought });
    case "ALREADY_A_DELIVERABLE": {
      // From the capture event, which outlives its thought: the thought deleted since 134 answered leaves no
      // deliverable standing, and its events say what was recorded (review pass 2: that read threw, a 500).
      const h = await (await ctx.store()).deliverableHistory(thought);
      const c = h.events.find((e) => e.event === "captured");
      if (!c) throw new Error("record_deliverable answered ALREADY_A_DELIVERABLE for a thought no deliverable was recorded on");
      return refuse({ code: "ALREADY_A_DELIVERABLE", retryable: false, id: thought, recordedBy: c.maker.name, spec: c.specRef, checkpoint: c.checkpoint });
    }
    case "NOT_A_DELIVERABLE": return refuse({ code: "NOT_A_DELIVERABLE", retryable: false, id: thought, deleted: /thought was deleted\b/.test(a.message ?? "") });
    case "ILLEGAL_TRANSITION": return refuse({ code: "ILLEGAL_TRANSITION", retryable: false, id: thought, from: a.from ?? "", to: a.to ?? "" });
    case "VERIFY_NOT_YOURS": return refuse({ code: "VERIFY_NOT_YOURS", retryable: false, id: thought, as: /its author may mark it corrected$/.test(a.message ?? "") ? "author" : "recorder" });
  }
  throw new Error("a deliverable call answered refused without a code this server reads");
}

/**
 * A thought that holds the deliverable's text already — found before the capture, or landed on by it — answered by what
 * it is. A deliverable: 134's answer, which writes nothing (unchanged for its own key, spec and checkpoint, else
 * ALREADY_A_DELIVERABLE). A thought this key captured, derived from this spec, that no deliverable names — a record
 * that did not land after a capture of the key's own — recorded now. Any other thought: OUTPUT_EXISTS, recording
 * nothing (the maintainer, 2026-11-12). `summary` is what this call's capture did, when it made one.
 */
async function onExisting(ctx: Ctx, principal: Principal, thought: string, spec: string, named: string, checkpoint: string, summary: CaptureSummary | null): Promise<Outcome<CaptureDeliverableResult, CaptureDeliverableCode>> {
  const store = await ctx.store();
  if (thought === spec) return refuse({ code: "SPEC_IS_SELF", retryable: false, id: thought });
  if ((await store.deliverableHistory(thought)).events.length === 0) {
    const [by, from] = await Promise.all([store.captureActorOf(thought), store.derivedFromOf(thought)]);
    const ownKey = by !== null && (by.actorName === principal.name || (by.agentId !== null && by.agentId === principal.agentId));
    if (!ownKey || !from?.includes(spec)) return refuse({ code: "OUTPUT_EXISTS", retryable: false, id: thought });
  }
  const a = await store.recordDeliverable({ thought, spec, checkpoint, actor: actorOf(ctx, principal) });
  if ((a.outcome === "captured" || a.outcome === "unchanged") && a.deliverable) return ok({ outcome: a.outcome, deliverable: a.deliverable, event: a.event, capture: summary });
  if (a.outcome === "refused") return (await refusedBy(ctx, a, principal, thought, named)) as Outcome<never, CaptureDeliverableCode>;
  throw new Error("record_deliverable answered an outcome this server does not read");
}

export async function captureDeliverable(ctx: Ctx, principal: Principal, input: Input<"capture_deliverable">): Promise<Outcome<CaptureDeliverableResult, CaptureDeliverableCode>> {
  // Asked first, so a key 134 would refuse captures nothing (review pass 4 of PR 1: the refusal came after the thought).
  if (principal.scope !== "write") return writeScopeRequired(principal);
  const store = await ctx.store();
  // The spec as the capture would read it — an id, or a thought's client_key (SMD-3314) — resolved once and passed to
  // both, so the record never meets a name the capture took (review pass 1: a client_key captured, then refused).
  const named = id(input.spec);
  const spec = (await store.thoughtsNamed([named])).get(named);
  if (!spec) return refuse({ code: "SPEC_NOT_FOUND", retryable: false, spec: named });
  const text = deliverableText(input.content, input.checkpoint);
  // Text that is a thought already is never captured onto (review pass 1: a re-capture merged another key's tags into
  // a deliverable before its refusal): answered by what that thought is.
  const held = (await store.keyAtText(text))?.id;
  if (held !== undefined) return onExisting(ctx, principal, held, spec, named, input.checkpoint, null);
  const c = await capture(ctx, principal, { content: text, derived_from: [spec] });
  if (!c.ok) {
    // upsert_thought refuses a derived_from naming no thought before it writes: the spec, deleted since it was read.
    if (c.refusal.code === "DERIVED_FROM_MISSING") return refuse({ code: "SPEC_NOT_FOUND", retryable: false, spec: named });
    return c as Outcome<never, CaptureDeliverableCode>;
  }
  const summary = summaryOf(c.value);
  // The capture landed on a thought that was there by then — another call's, written while this one's model calls
  // ran — so it is answered as the one found before would have been: never recorded onto blindly (review pass 2).
  if (c.value.existed !== false) return onExisting(ctx, principal, c.value.id, spec, named, input.checkpoint, summary);
  const a = await store.recordDeliverable({ thought: c.value.id, spec, checkpoint: input.checkpoint, actor: actorOf(ctx, principal) });
  if ((a.outcome === "captured" || a.outcome === "unchanged") && a.deliverable) return ok({ outcome: a.outcome, deliverable: a.deliverable, event: a.event, capture: summary });
  // A record refused after this call's own fresh capture leaves the thought, named: the same call again records it.
  if (a.outcome === "refused") return (await refusedBy(ctx, a, principal, c.value.id, named, c.value.id)) as Outcome<never, CaptureDeliverableCode>;
  throw new Error("record_deliverable answered an outcome this server does not read");
}

export async function verifyDeliverable(ctx: Ctx, principal: Principal, input: Input<"verify_deliverable">): Promise<Outcome<VerifyDeliverableResult, VerifyDeliverableCode>> {
  if (principal.scope !== "write") return writeScopeRequired(principal);
  const thought = id(input.id);
  const a = await (await ctx.store()).verifyDeliverable({ thought, status: input.status, method: input.method, finding: input.finding, actor: actorOf(ctx, principal) });
  if (a.outcome === "changed" && a.deliverable && a.from && a.to) return ok({ outcome: "changed", deliverable: a.deliverable, event: a.event, from: a.from, to: a.to });
  if (a.outcome === "refused") return (await refusedBy(ctx, a, principal, thought)) as Outcome<never, VerifyDeliverableCode>;
  throw new Error("verify_deliverable answered an outcome this server does not read");
}

export async function deliverableHistory(ctx: Ctx, _principal: Principal, input: Input<"deliverable_history">): Promise<Outcome<DeliverableHistoryResult, DeliverableHistoryCode>> {
  const thought = id(input.id);
  const r = await (await ctx.store()).deliverableHistory(thought);
  if (!r.deliverable && r.events.length === 0) return refuse({ code: "NOT_A_DELIVERABLE", retryable: false, id: thought, deleted: false });
  return ok(r);
}
