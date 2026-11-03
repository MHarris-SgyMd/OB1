// The item kinds migration 116 takes a priority on (SMD-3664): one list, read by
// the store (a row of another kind is a fault) and by the tools' schema (an
// argument of another kind is refused), in a file of its own so the schema loads
// no store. Open items (`item`) are refused by 116 until SMD-3665.

export const PRIORITY_KINDS = ["thought", "ticket", "entity", "item"] as const;
export type PriorityKind = (typeof PRIORITY_KINDS)[number];
