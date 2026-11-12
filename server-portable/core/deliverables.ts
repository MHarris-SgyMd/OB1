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
// speaks of one; the capture path is many statements), so everything that can
// be asked before the capture is asked first — the key's scope, the spec, and
// whether the text is a thought already — and a record that still fails after
// a capture that wrote a new thought deletes that thought (review pass 1).
//
// A deliverable is always a thought this call wrote: text that is a thought
// already is refused (OUTPUT_EXISTS), unless it is a deliverable, which is
// answered from 134 with nothing captured (the maintainer, 2026-11-12). The
// text is held by its fingerprint (016), which ignores letter case and runs of
// white space, so two checkpoints that differ only there name one thought.

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
/** `capture` is null when nothing was captured: the same deliverable again, answered from the record. */
export type CaptureDeliverableResult = { outcome: "captured" | "unchanged"; deliverable: Deliverable; event: DeliverableEvent | null; capture: CaptureSummary | null };
/** capture_thought's own refusals stand (a refused egress, a provider down…), the spec's missing one renamed. */
export type CaptureDeliverableCode = Exclude<RefusalCode, "DERIVED_FROM_MISSING"> | WriterCode | "SPEC_NOT_FOUND" | "SPEC_IS_SELF" | "ALREADY_A_DELIVERABLE" | "OUTPUT_EXISTS";
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
  const store = await ctx.store();
  const actor = actorOf(ctx, principal);
  // The spec as the capture would read it — an id, or a thought's client_key (SMD-3314) — resolved once and passed to
  // both, so the record never meets a name the capture took (review pass 1: a client_key captured, then refused).
  const named = id(input.spec);
  const spec = (await store.thoughtsNamed([named])).get(named);
  if (!spec) return refuse({ code: "SPEC_NOT_FOUND", retryable: false, spec: named });
  const text = deliverableText(input.content, input.checkpoint);
  // Text that is a thought already is never captured onto (review pass 1: a re-capture merged a rival's tags into a
  // deliverable before its refusal, and one onto a plain thought left its derived_from unset). A deliverable is
  // answered from 134, which writes nothing for it: unchanged for its own key, spec and checkpoint, else
  // ALREADY_A_DELIVERABLE. Any other thought is refused OUTPUT_EXISTS.
  const held = (await store.keyAtText(text))?.id;
  if (held !== undefined) {
    if (held === spec) return refuse({ code: "SPEC_IS_SELF", retryable: false, id: held });
    if ((await store.deliverableHistory(held)).events.length === 0) return refuse({ code: "OUTPUT_EXISTS", retryable: false, id: held });
    const again = await store.recordDeliverable({ thought: held, spec, checkpoint: input.checkpoint, actor });
    if (again.outcome === "unchanged" && again.deliverable) return ok({ outcome: "unchanged", deliverable: again.deliverable, event: again.event, capture: null });
    if (again.outcome === "refused") return (await refusedBy(ctx, again, principal, held, spec)) as Outcome<never, CaptureDeliverableCode>;
    throw new Error(`record_deliverable answered ${again.outcome} for a thought that is a deliverable already`);
  }
  const c = await capture(ctx, principal, { content: text, derived_from: [spec] });
  if (!c.ok) {
    // upsert_thought refuses a derived_from naming no thought before it writes: the spec, deleted since it was read.
    if (c.refusal.code === "DERIVED_FROM_MISSING") return refuse({ code: "SPEC_NOT_FOUND", retryable: false, spec: named });
    return c as Outcome<never, CaptureDeliverableCode>;
  }
  const thought = c.value.id;
  // A record that does not land after a capture that wrote a new thought deletes that thought, so no capture is left
  // as a thought no deliverable names: the spec deleted between them, another key recording the thought first, a
  // server role without the deliverables group. A text that was there already (another call's, landed meanwhile) is
  // left as it was, and so is a thought another call has since recorded as its deliverable: two identical calls racing
  // past the check above both capture, one writing the thought and the other landing on it, and the second may record
  // it first.
  const undo = async () => {
    if (c.value.existed !== false) return;
    const recorded = await store.deliverableHistory(thought).then((h) => h.events.length > 0, () => true);
    if (!recorded) await store.deleteThought({ id: thought, actor }).catch(() => undefined);
  };
  let a: DeliverableAnswer;
  try {
    a = await store.recordDeliverable({ thought, spec, checkpoint: input.checkpoint, actor });
  } catch (e) {
    await undo();
    throw e;
  }
  if ((a.outcome === "captured" || a.outcome === "unchanged") && a.deliverable) return ok({ outcome: a.outcome, deliverable: a.deliverable, event: a.event, capture: summaryOf(c.value) });
  await undo();
  if (a.outcome === "refused") return (await refusedBy(ctx, a, principal, thought, named)) as Outcome<never, CaptureDeliverableCode>;
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
