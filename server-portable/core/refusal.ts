// What an operation answers when it does not do what was asked (SMD-2283): a
// typed refusal, never a sentence. `code` says which rule; `retryable` is the
// transient/final split SMD-1978 gave the session hook; the other fields are
// the facts a renderer needs to say it — the MCP layer in prose, the REST core
// as JSON. A refusal is what the principal may be told: a field the existence-
// oracle rule (SMD-1298) withholds from a key is left off by the operation.

import type { Citation } from "../store.ts";

/**
 * Every refusal an operation returns. The SMD-1978 codes the session hook keys
 * on keep their names; the rest name refusals that carried no code before
 * SMD-2283. A shape refusal of capture_thought's carries the code the hook's
 * verdictOf mends by (recipes/session-capture-hook), so a new code never
 * changes what the hook drops and retries.
 */
export type Refusal =
  // The read tools.
  | { code: "NOT_FOUND"; retryable: false; id: string }               // fetch, update_thought, delete_thought: no such thought; job_status: no such job for this key
  | { code: "REFUSED_FILTER"; retryable: false; message: string }     // a metadata filter (or said_by/actor) the boundary refuses
  | { code: "REFUSED_EGRESS"; retryable: false; rule: string; reason: string; actor: string } // the query may not leave for its embedding (SMD-1903)
  | { code: "REFUSED_SINCE"; retryable: false; value: string }        // a `since` that is neither a time nor a cursor
  | { code: "REFUSED_CURSOR"; retryable: false; value: string }       // list_thought_ids' `after` is not a thought id
  // capture_thought's shapes, refused before any model call (032, SMD-2014).
  | { code: "REFUSED_SUPERSEDES_SHAPE"; retryable: false; value: string; orNull: boolean } // `supersedes` is not a thought id (update_thought's also takes null)
  | { code: "REFUSED_DERIVED_FROM_SHAPE"; retryable: false; value: string }               // a `derived_from` entry is not a thought id
  | { code: "REFUSED_METADATA_SHAPE"; retryable: false; problem: MetadataProblem; key?: string; count?: number; length?: number } // a caller `metadata` key or value the boundary refuses
  // capture_thought's pointers (SMD-1298, SMD-1978).
  | { code: "SUPERSEDES_UNJUDGED"; retryable: true; cause: "check_failed"; detail: string; noPrivilege: boolean } // the target's capture record could not be read
  | { code: "SUPERSEDES_UNJUDGED"; retryable: true; cause: "registry_away" }  // the row is attributed and this key's id is not to hand
  | { code: "REFUSED_SUPERSEDES_OWNERSHIP"; retryable: false; registryRefused: boolean } // a capture key named a supersedes it cannot show it wrote — another key's thought, or none at all (what it may learn here is SMD-2473's)
  | { code: "REFUSED_SUPERSEDES_UNKNOWN"; retryable: false }          // the supersedes names no thought
  | { code: "DERIVED_FROM_MISSING"; retryable: false; named: { position: number; id: string }[] } // derived_from entries that name no thought — empty for a key that cannot read (the existence-oracle rule)
  | { code: "EMBEDDING_NOT_ATTACHED"; retryable: true; id: string; detail: string } // saved, but its vector did not attach (the PostgREST two-step)
  // update_thought and delete_thought: the store's refusals (018, 032, 042).
  | { code: "REFUSED_NOTHING_TO_UPDATE"; retryable: false }           // none of content, metadata_patch, supersedes
  | { code: "REFUSED_STALE_READ"; retryable: false; id: string; currentUpdatedAt?: string } // changed since the if_unchanged_since passed
  | { code: "REFUSED_DUPLICATE_CONTENT"; retryable: false }           // the text is another thought's
  | { code: "REFUSED_WOULD_CYCLE"; retryable: false; id: string }     // the supersedes pointer would close a loop
  | { code: "REFUSED_CITED"; retryable: false; id: string; citedBy?: number; citations?: Citation[] } // statements in other thoughts rest on it (042)
  | { code: "REFUSED"; retryable: false; error: string };             // a refusal the store named that this server does not know

/** What is wrong with a caller's `metadata` argument (SMD-2014). */
export type MetadataProblem = "too_many_keys" | "bad_key" | "reserved_key" | "bad_value" | "value_too_long";
/** The bounds a caller's `metadata` is held to (SMD-2014): here, beside the refusal that names them, so its words need not load the write path. */
export const META_VALUE_MAX = 200;
export const META_KEYS_MAX = 8;

export type RefusalCode = Refusal["code"];

/** An operation's answer: the typed value, or the refusal. A fault — the store down, a missing migration — is thrown, not returned. */
export type Outcome<T> = { ok: true; value: T } | { ok: false; refusal: Refusal };

export const ok = <T>(value: T): Outcome<T> => ({ ok: true, value });
export const refuse = <T = never>(refusal: Refusal): Outcome<T> => ({ ok: false, refusal });

/**
 * A fault an operation threw, typed for a caller that wants a code: FAILED,
 * with the thrown message, and no `retryable`. The fault is unclassified — a
 * missing migration and a dropped connection read alike here — so the server
 * states neither verdict rather than one it does not know (review pass 4:
 * `retryable: false` called a restarting database final while capture called
 * it retryable). One classifier for every fault, capture's STORE_UNAVAILABLE
 * included, is SMD-2461, which adds the field back.
 */
export type Failure = { code: "FAILED"; message: string };
export const failure = (err: unknown): Failure => ({ code: "FAILED", message: messageOf(err) });

/**
 * What a thrown value says: an Error's message, anything else as String()
 * prints it — and something String() cannot print (a null-prototype object, a
 * throwing toString) a fixed phrase rather than a second throw inside the
 * caller's catch (review pass 6).
 */
function messageOf(err: unknown): string {
  try {
    return (err as Error)?.message ?? String(err);
  } catch {
    return "a fault that could not be printed";
  }
}