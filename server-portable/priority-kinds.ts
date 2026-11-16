// The item kinds migration 116 takes a priority on (SMD-3664): one list, read by
// the store (a row of another kind is a fault) and by the tools' schema (an
// argument of another kind is refused), in a file of its own so the schema loads
// no store. Open items (`item`) are 117's (SMD-3665).

export const PRIORITY_KINDS = ["thought", "ticket", "entity", "item"] as const;
export type PriorityKind = (typeof PRIORITY_KINDS)[number];

// The priority review's findings (migration 142, SMD-3671): what a finding is about, and where its decision stands —
// the list's filters and the store's read of a row, here for the same reason.
export const FINDING_KINDS = ["stale", "overdue", "disagree", "settled"] as const;
export type FindingKind = (typeof FINDING_KINDS)[number];
export const FINDING_STATUSES = ["pending", "accepted", "rejected", "moot"] as const;
export type FindingStatus = (typeof FINDING_STATUSES)[number];
/** 142's refusals of a decision's arguments, asked after who may decide: the store reads them, the refusal names them. */
export const FINDING_INPUT_ERRORS = ["BAD_DECISION", "BAD_NOTE", "ACCEPT_NEEDS_OUTCOME", "BAD_OUTCOME"] as const;
export type FindingInputError = (typeof FINDING_INPUT_ERRORS)[number];
