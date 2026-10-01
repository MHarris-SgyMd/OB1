// What an operation answers when it does not do what was asked (SMD-2283): a
// typed refusal, never a sentence. `code` says which rule; `retryable` is the
// transient/final split SMD-1978 gave the session hook; the other fields are
// the facts a renderer needs to say it — the MCP layer in prose, the REST core
// as JSON. A refusal is what the principal may be told: a field the existence-
// oracle rule (SMD-1298) withholds from a key is left off by the operation.

/**
 * Every refusal an operation returns. The SMD-1978 codes the session hook keys
 * on keep their names; the rest name the read tools' refusals, which carried no
 * code before SMD-2283.
 */
export type Refusal =
  // The read tools.
  | { code: "NOT_FOUND"; retryable: false; id: string }               // fetch: no such thought; job_status: no such job for this key
  | { code: "REFUSED_FILTER"; retryable: false; message: string }     // a metadata filter (or said_by/actor) the boundary refuses
  | { code: "REFUSED_EGRESS"; retryable: false; rule: string; reason: string; actor: string } // the query may not leave for its embedding (SMD-1903)
  | { code: "REFUSED_SINCE"; retryable: false; value: string }        // a `since` that is neither a time nor a cursor
  | { code: "REFUSED_CURSOR"; retryable: false; value: string };      // list_thought_ids' `after` is not a thought id

export type RefusalCode = Refusal["code"];

/** An operation's answer: the typed value, or the refusal. A fault — the store down, a missing migration — is thrown, not returned. */
export type Outcome<T> = { ok: true; value: T } | { ok: false; refusal: Refusal };

export const ok = <T>(value: T): Outcome<T> => ({ ok: true, value });
export const refuse = <T = never>(refusal: Refusal): Outcome<T> => ({ ok: false, refusal });

/**
 * A fault an operation threw, typed for a caller that wants a code: FAILED,
 * final, with the thrown message. Final because the fault is unclassified — a
 * missing migration and a dropped connection read alike here, and telling a
 * client to retry the first is the worse error. capture_thought's own
 * STORE_UNAVAILABLE (SMD-1978) classifies its faults and says retryable.
 */
export type Failure = { code: "FAILED"; retryable: false; message: string };
export const failure = (err: unknown): Failure => ({ code: "FAILED", retryable: false, message: (err as Error)?.message ?? String(err) });
