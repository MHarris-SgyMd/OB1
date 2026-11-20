// The validity read (SMD-3887 PR 2b): migration 149's thought_validity as an operation of the core, so the REST core
// and the MCP server answer it alike. docs/claim-validity.md decides what each state means and which record it is read
// from; the database reads them, and this file turns its answer into a value or a refusal. It labels only: nothing it
// reads moves a rank, and no other read changes.

import type { Principal } from "../auth.ts";
import type { ValidityThought } from "../validity.ts";
import type { Ctx } from "./context.ts";
import { ok, type Outcome } from "./refusal.ts";
import type { Input } from "./schemas.ts";

/** The validity read's value: the cap on distinct ids, and each thought asked for, in the order given, a repeat once. */
export type ValidityResult = { cap: number; thoughts: ValidityThought[] };
/** None: the schema holds the list to the cap, so 149 has nothing to refuse a call from here. */
export type ValidityCode = never;

export async function validity(ctx: Ctx, _principal: Principal, input: Input<"validity">): Promise<Outcome<ValidityResult, ValidityCode>> {
  const ids = input.ids.map((s) => s.trim().toLowerCase());
  const a = await (await ctx.store()).thoughtValidity(ids);
  if (a.ok) return ok({ cap: a.cap, thoughts: a.thoughts });
  // The schema holds the list to the cap (at most 100 ids, so at most 100 distinct): a TOO_MANY from 149 is the
  // store's fault, as NO_IDS is. The REST door could not carry the 1,000 ids 149's raw bound allows: Bun refuses a
  // request line past 16 KB (431), some 400 ids (review pass 1).
  if (a.error === "TOO_MANY") throw new Error(`thought_validity answered TOO_MANY (${a.given} over ${a.cap}) to a list the operation's schema holds to the cap`);
  // The server's own role cannot read thoughts: a fault of the deployment, not of the call (149 answers NOT_READABLE
  // where a role lacks the one table it cannot do without).
  if (a.error === "NOT_READABLE") throw new Error("thought_validity: the server's database role cannot read thoughts");
  // The schema holds the list non-empty, so 149's NO_IDS never meets a call from here.
  throw new Error("thought_validity answered NO_IDS to a list the operation's schema holds non-empty");
}
