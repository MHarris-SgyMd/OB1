// What an operation answers when it does not do what was asked (SMD-2283): a
// typed refusal, never a sentence. `code` says which rule; `retryable` is the
// transient/final split SMD-1978 gave the session hook; the other fields are
// the facts a renderer needs to say it — the MCP layer in prose, the REST core
// as JSON. A refusal is what the principal may be told: a field the existence-
// oracle rule (SMD-1298) withholds from a key is left off by the operation.

import type { Citation } from "../store.ts";
import type { StandingFlag } from "../standing.ts";
import type { ProposalSelection } from "./list-cursor.ts";

/**
 * Every refusal an operation returns. The SMD-1978 codes the session hook keys
 * on keep their names; the rest name refusals that carried no code before
 * SMD-2283. A shape refusal of capture_thought's carries a code the session
 * hook's verdictOf maps (recipes/session-capture-hook) to the mend its prose
 * gave — for a hook from the same release. An older checkout's verdictOf reads
 * the two pointer shapes as final and drops the summary, so the hook's
 * checkout is upgraded with the server (changes/smd-2283.md, Upgrading).
 */
export type Refusal =
  // The read tools.
  | { code: "NOT_FOUND"; retryable: false; id: string }               // fetch, update_thought, delete_thought, reset_capture_stamp: no such thought; job_status: no such job for this key; review_supersession_proposal: no such proposal, or a thought it names is gone
  | { code: "REFUSED_FILTER"; retryable: false; message: string }     // a metadata filter (or said_by/actor) the boundary refuses
  | { code: "REFUSED_EGRESS"; retryable: false; rule: string; reason: string; actor: string } // the query may not leave for its embedding (SMD-1903)
  | { code: "REFUSED_SINCE"; retryable: false; value: string }        // a `since` that is neither a time nor a cursor
  | { code: "REFUSED_CURSOR"; retryable: false; value: string; reason?: "shape" | "sort" | "filters"; sort?: "newest" | "oldest"; made?: ProposalSelection } // list_thought_ids' `after` is not a thought id; list_thoughts' is none of this tool's cursors (shape) or was made under the other `sort` (sort: the one it was made under); list_supersession_proposals' is none of its cursors (shape, SMD-3249) or was made under other filters (filters, made: the status, lineage and judge_key it was made under — tokens, a boolean and a pass key, review pass 1)
  // The compat search found nothing while its query's embedding provider did not answer (SMD-2891): what was
  // matched without a vector (the query's literals, or with none the query as one text) and why nothing came of it.
  | { code: "EMBEDDING_PROVIDER_UNAVAILABLE"; retryable: true; reason: string; detail: string; base: string; matched: "literals" | "text" | "none"; needles: string[]; commonNeedles: string[] }
  // capture_thought's shapes, refused before any model call (032, SMD-2014).
  | { code: "REFUSED_SUPERSEDES_SHAPE"; retryable: false; value: string; orNull: boolean } // `supersedes` is not a thought id (update_thought's also takes null)
  | { code: "REFUSED_DERIVED_FROM_SHAPE"; retryable: false; value: string }               // a `derived_from` entry is not a thought id
  | { code: "REFUSED_METADATA_SHAPE"; retryable: false; problem: MetadataProblem; key?: string; count?: number; length?: number } // a caller `metadata` key or value the boundary refuses (update_thought's `metadata_patch` naming `client_key` too)
  // capture_thought's `client_key` (SMD-3314, migration 112).
  | { code: "REFUSED_CLIENT_KEY_SHAPE"; retryable: false; value: string } // not a UUID
  | { code: "REFUSED_CLIENT_KEY_SCOPE"; retryable: false }                // a capture-only key sent one: its dedup reply would say whether an id exists
  // capture_thought's pointers (SMD-1298, SMD-1978).
  | { code: "SUPERSEDES_UNJUDGED"; retryable: true; cause: "check_failed"; detail: string; noPrivilege: boolean } // the target's capture record, or whether it stands, could not be read
  | { code: "SUPERSEDES_UNJUDGED"; retryable: true; cause: "registry_away" }  // a capture key's id is not to hand while the registry may answer — whatever the target (SMD-2473)
  | { code: "REFUSED_SUPERSEDES_UNKNOWN"; retryable: false }          // the supersedes names no thought
  | { code: "DERIVED_FROM_MISSING"; retryable: false; named: { position: number; id: string }[] } // derived_from entries that name no thought — empty for a key that cannot read (the existence-oracle rule)
  // update_thought and delete_thought: the store's refusals (018, 032, 042).
  | { code: "REFUSED_NOTHING_TO_UPDATE"; retryable: false }           // none of content, metadata_patch, supersedes
  | { code: "REFUSED_STALE_READ"; retryable: false; id: string; currentUpdatedAt?: string } // changed since the if_unchanged_since passed
  | { code: "REFUSED_DUPLICATE_CONTENT"; retryable: false }           // the text is another thought's
  | { code: "REFUSED_WOULD_CYCLE"; retryable: false; id: string }     // the supersedes pointer would close a loop
  | { code: "REFUSED_CITED"; retryable: false; id: string; citedBy?: number; citations?: Citation[] } // statements in other thoughts rest on it (042)
  | { code: "REFUSED"; retryable: false; error: string }              // a refusal the store named that this server does not know
  // reset_capture_stamp (086, SMD-2744).
  | { code: "REFUSED_NOT_OPERATOR"; retryable: false; key: string; kind: string | null } // the key is not one the registry classifies operator (kind: what it is), or is capture-only
  | { code: "REFUSED_NOT_CAPTURE_STAMP"; retryable: false; id: string } // the thought's label is no capture-only key's a re-capture moves
  // review_supersession_proposal (029/036, 070, 094; SMD-3338): `id` the proposal's. The first three are the checks
  // `force` waives on an accept, as the CLI's --force does.
  | { code: "REFUSED_EDITED_SINCE"; retryable: false; id: string; olderEdited: boolean; newerEdited: boolean } // a text moved since the pair was judged (a stale row's is one)
  | { code: "REFUSED_LINEAGE_PAIR"; retryable: false; id: string; status: string | null; flags: StandingFlag[] } // one side's derived_from names the other (070); flags: a WRITER flag the force would also waive
  | { code: "REFUSED_WRITER"; retryable: false; id: string; status: string; flags: StandingFlag[]; edited: boolean; lapses: { older: number; newer: number } } // the side to stand is a capture-only key's text or of a lower trust (094)
  | { code: "REFUSED_REVIEW_ARGUMENT"; retryable: false; problem: ReviewArgumentProblem } // an argument the decision does not take
  | { code: "REFUSED_DIRECTION_REQUIRED"; retryable: false; id: string; verdict: string } // the verdict names no current side: pass a direction
  | { code: "REFUSED_ALREADY_ACCEPTED"; retryable: false; id: string; supersedingId: string } // a reject undoes it first
  | { code: "REFUSED_ALREADY_SUPERSEDES"; retryable: false; id: string; supersedingId: string; currentId: string } // the side to stand supersedes a third thought
  | { code: "REFUSED_PROPOSAL_WOULD_CYCLE"; retryable: false; id: string; supersedingId: string; supersededId: string; chainTooLong: boolean } // the pointer would close a loop, or the chain passes update_thought's walk (chainTooLong)
  | { code: "REFUSED_SUPERSEDED_GONE"; retryable: false; id: string; supersededId: string } // the thought to be superseded was deleted
  // The worker actions (SMD-2132, SMD-2272).
  | { code: "REFUSED_EMPTY_WORK_TYPE"; retryable: false }            // a work_type required, or given but blank
  | { code: "REFUSED_LIVE_LEASE_NEEDS_WORKER"; retryable: false }    // release_stale_leases' include_live without a worker_id
  | { code: "RUN_WORKER_DRAIN_NOT_AVAILABLE"; retryable: false };    // run_worker without dry_run: true — the executing drain is deferred (SMD-2304)

/** What a decision does not take (SMD-3338), as the CLI refuses it: a direction or force on a reject, or a note beginning with the pass's own marker (067). */
export type ReviewArgumentProblem = "direction_on_reject" | "force_on_reject" | "note_marker";

/** What is wrong with a caller's `metadata` argument (SMD-2014). */
export type MetadataProblem = "too_many_keys" | "bad_key" | "reserved_key" | "ticket_key" | "bad_value" | "value_too_long";
/**
 * The keys a ticket's lifecycle is read from (068's head and node_lifecycle,
 * 071's dependencies, 079's pairing, board-sync's plan), which a key that cannot
 * read may not set (SMD-2617). `ticket` files a thought under a ticket, read
 * ahead of `issue` (SMD-2657).
 */
export const TICKET_META_KEYS = ["issue", "ticket", "status", "status_type", "linear_updated_at"] as const;
/** The keys as the tool description and the refusal name them, one rendering for both. */
export const TICKET_META_KEYS_TEXT = TICKET_META_KEYS.map((k) => `\`${k}\``).join(", ");
/** The bounds a caller's `metadata` is held to (SMD-2014): here, beside the refusal that names them, so its words need not load the write path. */
export const META_VALUE_MAX = 200;
export const META_KEYS_MAX = 8;

export type RefusalCode = Refusal["code"];

/**
 * What each refusal may say beside its code and its `retryable` to a client
 * that reads values, not words (the MCP `structuredContent`, the REST core's
 * JSON): ids, times, counts, rule tokens — never the caller's raw input or the
 * store's wording, which a renderer bounds into its text. One entry per code,
 * so a new refusal fails to compile until its facts are declared beside it
 * (SMD-2283 PR 3; the list lived in render.ts, a second file to remember).
 */
type Facts = { [C in RefusalCode]: (r: Extract<Refusal, { code: C }>) => Record<string, unknown> };
const none = () => ({});
const FACTS: Facts = {
  NOT_FOUND: none,
  REFUSED_FILTER: none,
  REFUSED_EGRESS: (r) => ({ rule: r.rule }),
  REFUSED_SINCE: none,
  // list_thoughts' (SMD-2995): which way the cursor would not do, and the sort it was made under — never the cursor itself;
  // list_supersession_proposals' (SMD-3249) the filters it was made under.
  REFUSED_CURSOR: (r) => ({ ...(r.reason ? { reason: r.reason } : {}), ...(r.sort ? { sort: r.sort } : {}), ...(r.made ? { made: r.made } : {}) }),
  // The provider's marker word and what was matched: the endpoint and the literals are in the text.
  EMBEDDING_PROVIDER_UNAVAILABLE: (r) => ({ reason: r.reason, matched: r.matched }),
  REFUSED_SUPERSEDES_SHAPE: none,
  REFUSED_DERIVED_FROM_SHAPE: none,
  // Which rule, and the key, so a client reading values knows what to drop
  // (SMD-2617) — unless the key itself is malformed: a bad key is the
  // caller's raw input, and stays in the text.
  REFUSED_METADATA_SHAPE: (r) => ({ problem: r.problem, ...(r.key !== undefined && r.problem !== "bad_key" ? { key: r.key } : {}) }),
  REFUSED_CLIENT_KEY_SHAPE: none,
  REFUSED_CLIENT_KEY_SCOPE: none,
  SUPERSEDES_UNJUDGED: none,
  REFUSED_SUPERSEDES_UNKNOWN: none,
  // The derived_from indices to drop — present only for a caller allowed to
  // know they exist (SMD-1978); what the session hook mends by.
  DERIVED_FROM_MISSING: (r) => (r.named.length ? { positions: r.named.map((n) => n.position) } : {}),
  REFUSED_NOTHING_TO_UPDATE: none,
  REFUSED_STALE_READ: (r) => (r.currentUpdatedAt ? { currentUpdatedAt: r.currentUpdatedAt } : {}),
  REFUSED_DUPLICATE_CONTENT: none,
  REFUSED_WOULD_CYCLE: none,
  REFUSED_CITED: (r) => (r.citedBy !== undefined ? { citedBy: r.citedBy } : {}),
  REFUSED: none,
  // The key's own name and kind are in the text, not here: a name is the
  // env's, not a token, and the kind is the registry's word about the key.
  REFUSED_NOT_OPERATOR: none,
  REFUSED_NOT_CAPTURE_STAMP: none,
  // A decision's refusals: the proposal's and its thoughts' ids, the flags as
  // tokens and the counts — the writers' names are in the text.
  REFUSED_EDITED_SINCE: (r) => ({ id: r.id, olderEdited: r.olderEdited, newerEdited: r.newerEdited }),
  REFUSED_LINEAGE_PAIR: (r) => ({ id: r.id, ...(r.status ? { status: r.status } : {}), flags: r.flags }),
  REFUSED_WRITER: (r) => ({ id: r.id, status: r.status, flags: r.flags, edited: r.edited, lapses: r.lapses }),
  REFUSED_REVIEW_ARGUMENT: (r) => ({ problem: r.problem }),
  REFUSED_DIRECTION_REQUIRED: (r) => ({ id: r.id, verdict: r.verdict }),
  REFUSED_ALREADY_ACCEPTED: (r) => ({ id: r.id, supersedingId: r.supersedingId }),
  REFUSED_ALREADY_SUPERSEDES: (r) => ({ id: r.id, supersedingId: r.supersedingId, currentId: r.currentId }),
  REFUSED_PROPOSAL_WOULD_CYCLE: (r) => ({ id: r.id, supersedingId: r.supersedingId, supersededId: r.supersededId, chainTooLong: r.chainTooLong }),
  REFUSED_SUPERSEDED_GONE: (r) => ({ id: r.id, supersededId: r.supersededId }),
  REFUSED_EMPTY_WORK_TYPE: none,
  REFUSED_LIVE_LEASE_NEEDS_WORKER: none,
  RUN_WORKER_DRAIN_NOT_AVAILABLE: none,
};

/** A refusal as a value: its code, whether a retry can help, and its declared facts (FACTS). */
export function refusalValue(r: Refusal): Record<string, unknown> {
  return { code: r.code, retryable: r.retryable, ...(FACTS[r.code] as (r: Refusal) => Record<string, unknown>)(r) };
}

/**
 * An operation's answer: the typed value, or the refusal. A fault — the store
 * down, a missing migration — is thrown, not returned. `C` narrows the codes an
 * operation can refuse with, so a caller that words each code (render.ts, the
 * REST routes) must word every one, and no other.
 */
export type Outcome<T, C extends RefusalCode = RefusalCode> = { ok: true; value: T } | { ok: false; refusal: Extract<Refusal, { code: C }> };

export const ok = <T>(value: T): Outcome<T, never> => ({ ok: true, value });
// The parameter is the refusal's own member, not a type parameter of it, so a
// field it does not declare (`citeBy` for `citedBy`) is an excess property.
export const refuse = <T = never, C extends RefusalCode = RefusalCode>(refusal: Extract<Refusal, { code: C }> & { code: C }): Outcome<T, C> => ({ ok: false, refusal } as unknown as Outcome<T, C>);

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