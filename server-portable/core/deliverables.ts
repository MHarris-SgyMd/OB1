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
// deliverable). Every refusal the record can answer after the capture lands on
// a thought that was there before it — the same text again, or the spec's own
// — so no capture is left behind as a thought no deliverable names.

import type { Principal } from "../auth.ts";
import type { DeliverableAnswer } from "../deliverables.ts";
import type { Deliverable, DeliverableEvent } from "../store.ts";
import type { Ctx } from "./context.ts";
import { ok, refuse, type Outcome, type RefusalCode } from "./refusal.ts";
import type { Input } from "./schemas.ts";
import { actorOf, capture, type Captured } from "./writes.ts";

/** The line a deliverable's text closes with: its checkpoint, so the thought's own fingerprint names it. */
export const checkpointLine = (checkpoint: string) => `Checkpoint: ${checkpoint}`;
/** A deliverable's text as captured: the output's words, a blank line, its checkpoint line. */
export const deliverableText = (content: string, checkpoint: string) => `${content.trimEnd()}\n\n${checkpointLine(checkpoint)}`;

type WriterCode = "WRITE_SCOPE_REQUIRED" | "NOT_FOUND";
export type CaptureDeliverableResult = { outcome: "captured" | "unchanged"; deliverable: Deliverable; event: DeliverableEvent | null; capture: Captured };
/** capture_thought's own refusals stand (a refused egress, a provider down…), the spec's missing one renamed. */
export type CaptureDeliverableCode = Exclude<RefusalCode, "DERIVED_FROM_MISSING"> | WriterCode | "SPEC_NOT_FOUND" | "SPEC_IS_SELF" | "ALREADY_A_DELIVERABLE";
export type VerifyDeliverableResult = { outcome: "changed"; deliverable: Deliverable; event: DeliverableEvent | null; from: string; to: string };
export type VerifyDeliverableCode = WriterCode | "NOT_A_DELIVERABLE" | "ILLEGAL_TRANSITION" | "VERIFY_NOT_YOURS";
/** deliverable_history's value: the deliverable (null when its thought was deleted: its events stay) and every event, oldest first. */
export type DeliverableHistoryResult = { deliverable: Deliverable | null; events: DeliverableEvent[] };
export type DeliverableHistoryCode = "NOT_A_DELIVERABLE";

const writeScopeRequired = (principal: Principal) => refuse({ code: "WRITE_SCOPE_REQUIRED", retryable: false, key: principal.name });
const id = (s: string) => s.trim().toLowerCase();

/**
 * A refusal 134 answered as a value, by its code. ALREADY_A_DELIVERABLE names the deliverable that stands, read
 * again, since 134 answers it in words alone; VERIFY_NOT_YOURS says which rule refused, by its words' close (they
 * open with the key's own name, which the server does not choose).
 */
async function refusedBy(ctx: Ctx, a: DeliverableAnswer, principal: Principal, thought: string, spec = "") {
  switch (a.code) {
    case "WRITE_SCOPE_REQUIRED": return writeScopeRequired(principal);
    case "THOUGHT_NOT_FOUND": return refuse({ code: "NOT_FOUND", retryable: false, id: thought });
    case "SPEC_NOT_FOUND": return refuse({ code: "SPEC_NOT_FOUND", retryable: false, spec });
    case "SPEC_IS_SELF": return refuse({ code: "SPEC_IS_SELF", retryable: false, id: thought });
    case "ALREADY_A_DELIVERABLE": {
      const d = (await (await ctx.store()).deliverableHistory(thought)).deliverable;
      if (!d) throw new Error("record_deliverable answered ALREADY_A_DELIVERABLE for a thought with no deliverable");
      return refuse({ code: "ALREADY_A_DELIVERABLE", retryable: false, id: thought, recordedBy: d.capturedBy, spec: d.specRef, checkpoint: d.checkpoint });
    }
    case "NOT_A_DELIVERABLE": return refuse({ code: "NOT_A_DELIVERABLE", retryable: false, id: thought, deleted: /thought was deleted\b/.test(a.message ?? "") });
    case "ILLEGAL_TRANSITION": return refuse({ code: "ILLEGAL_TRANSITION", retryable: false, id: thought, from: a.from ?? "", to: a.to ?? "" });
    case "VERIFY_NOT_YOURS": return refuse({ code: "VERIFY_NOT_YOURS", retryable: false, id: thought, as: /its author may mark it corrected$/.test(a.message ?? "") ? "author" : "recorder" });
  }
  throw new Error("a deliverable call answered refused without a code this server reads");
}

export async function captureDeliverable(ctx: Ctx, principal: Principal, input: Input<"capture_deliverable">): Promise<Outcome<CaptureDeliverableResult, CaptureDeliverableCode>> {
  // Asked first, so a key 134 would refuse captures nothing (review pass 4 of PR 1: the refusal came after the thought).
  if (principal.scope !== "write") return writeScopeRequired(principal);
  const spec = id(input.spec);
  const c = await capture(ctx, principal, { content: deliverableText(input.content, input.checkpoint), derived_from: [spec] });
  if (!c.ok) {
    // upsert_thought refuses a derived_from naming no thought before it writes: the spec, the only entry.
    if (c.refusal.code === "DERIVED_FROM_MISSING") return refuse({ code: "SPEC_NOT_FOUND", retryable: false, spec });
    return c as Outcome<never, CaptureDeliverableCode>;
  }
  const thought = c.value.id;
  const a = await (await ctx.store()).recordDeliverable({ thought, spec, checkpoint: input.checkpoint, actor: actorOf(ctx, principal) });
  if ((a.outcome === "captured" || a.outcome === "unchanged") && a.deliverable) return ok({ outcome: a.outcome, deliverable: a.deliverable, event: a.event, capture: c.value });
  // A SPEC_NOT_FOUND here is the spec deleted between the capture, which checked it, and the record.
  if (a.outcome === "refused") return (await refusedBy(ctx, a, principal, thought, spec)) as Outcome<never, CaptureDeliverableCode>;
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
