// What an operation answers when it does not do what was asked (SMD-2283): a
// typed refusal, never a sentence. `code` says which rule; `retryable` is the
// transient/final split SMD-1978 gave the session hook; the other fields are
// the facts a renderer needs to say it — the MCP layer in prose, the REST core
// as JSON. A refusal is what the principal may be told: a field the existence-
// oracle rule (SMD-1298) withholds from a key is left off by the operation.

import type { Citation, ClaimProblem, PriorityItem, PriorityProblem } from "../store.ts";
import type { ItemProblem } from "../open-items.ts";
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
  | { code: "REFUSED_THREAD_INPUT"; retryable: false; problem: "key_or_id" | "key_shape" | "after_needs_key"; value?: string } // thread (SMD-3306 PR 7a-2a): neither or both of key and id; a key that is no subject key (value: it, in the text alone); after without key
  | { code: "REFUSED_SINCE"; retryable: false; value: string }        // a `since` that is neither a time nor a cursor
  | { code: "REFUSED_CURSOR"; retryable: false; value: string; reason?: "shape" | "sort" | "filters"; sort?: "newest" | "oldest"; made?: ProposalSelection } // list_thought_ids' `after` is not a thought id; list_thoughts' is none of this tool's cursors (shape) or was made under the other `sort` (sort: the one it was made under); list_supersession_proposals' is none of its cursors (shape, SMD-3249) or was made under other filters (filters, made: the status, lineage and judge_key it was made under — tokens, a boolean and a pass key, review pass 1)
  // The compat search found nothing while its query's embedding provider did not answer (SMD-2891): what was
  // matched without a vector (the query's literals, or with none the query as one text) and why nothing came of it.
  | { code: "EMBEDDING_PROVIDER_UNAVAILABLE"; retryable: true; reason: string; detail: string; base: string; matched: "literals" | "text" | "none"; needles: string[]; commonNeedles: string[] }
  // The embedding call failed where nothing could be done without it (SMD-2892): a search, capture or edit whose
  // provider answered an error that is no outage (a credential refused, a model not there: final), or an edit whose
  // provider did not answer (retryable; a capture lands without the vector, a search answers by its literals).
  // `retryable` is providerDown's (embed.ts providerFault); `base`, masked, only to a key that can read (SMD-2284's
  // rule for a capture's provider); `provider`, the provider's own capped words, to the text alone.
  | { code: "EMBEDDING_PROVIDER_ERROR"; retryable: boolean; reason: string; detail: string; status?: number; setting: "OB1_LLM_BASE_URL"; base?: string; provider?: string }
  // capture_thought's shapes, refused before any model call (032, SMD-2014).
  | { code: "REFUSED_SUPERSEDES_SHAPE"; retryable: false; value: string; orNull: boolean } // `supersedes` is not a thought id (update_thought's also takes null)
  | { code: "REFUSED_DERIVED_FROM_SHAPE"; retryable: false; value: string }               // a `derived_from` entry is not a thought id
  | { code: "REFUSED_METADATA_SHAPE"; retryable: false; problem: MetadataProblem; key?: string; count?: number; length?: number } // a caller `metadata` key or value the boundary refuses (update_thought's `metadata_patch` naming `client_key` too)
  // capture_thought's `client_key` (SMD-3314, migration 112).
  | { code: "REFUSED_CLIENT_KEY_SHAPE"; retryable: false; value: string } // not a UUID
  | { code: "REFUSED_CLIENT_KEY_SCOPE"; retryable: false }                // a capture-only key sent one: its dedup reply would say whether an id exists
  // capture_thought's `source` and update_thought's metadata_patch (SMD-3600): a label the board's importers write directly, which a ticket row's closing release reads (migration 118).
  | { code: "REFUSED_SOURCE_RESERVED"; retryable: false; source: string }
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
  | { code: "REFUSED_NOT_OPERATOR"; retryable: false; key: string; kind: string | null; unidentified?: true } // the key is not one the registry classifies operator (kind: what it is), or is capture-only; unidentified: it reached the server with no agent id, so it has no registry kind (set_priority_weights, SMD-4193 PR 2)
  | { code: "REFUSED_NOT_CAPTURE_STAMP"; retryable: false; id: string } // the thought's label is no capture-only key's a re-capture moves
  // append_thought_evidence (SMD-2690 PR 3b): the thought's own evidence list will not take an entry.
  | { code: "REFUSED_THOUGHT_EVIDENCE"; retryable: false; id: string; problem: EvidenceProblem; count?: number } // full: it holds EVIDENCE_LIMITS.entries or more (count); not_list: its metadata.evidence is no list; metadata_not_object: its metadata is no object; unstamped: it has neither updated_at nor created_at, so no edit of it can be checked against another
  | { code: "THOUGHT_EVIDENCE_BUSY"; retryable: true; id: string } // other writes moved the thought under each of the append's EVIDENCE_LIMITS.tries reads: the same call can land a moment later
  // Work claims (115, SMD-3598): claim_work, renew_claim, release_claim. Never a token: 115 returns one only to the
  // caller who claimed, in the value, and no refusal carries one.
  | { code: "WORK_CLAIMED"; retryable: false; ticket: string; piece: string | null; heldBy: HeldClaim[] } // live claims cover the work: another key's, the same key's without its token, or the caller's own on overlapping work
  | { code: "CLAIM_NOT_FOUND"; retryable: false; id: string }         // no claim with that id
  | { code: "CLAIM_NOT_YOURS"; retryable: false; id: string; holder: string; forced: boolean; ownKey: boolean; expiresAt: string | null } // not this key with this token; forced: a force refused (the key is no operator named by its agent id); ownKey: the caller's own key holds it, under a token this call did not give
  | { code: "CLAIM_RELEASED"; retryable: false; id: string; releasedAt: string | null; takenOver: boolean; releasedBy: string | null; reason: string | null; ticketClosed: boolean } // a renewal of a claim that ended: released (by releasedBy, for reason), or taken over after it lapsed (by releasedBy); ticketClosed: board-sync released it because its ticket closed (SMD-3600)
  | { code: "REFUSED_CLAIM_INPUT"; retryable: false; problem: ClaimProblem; message: string } // an argument 115 refused by its rule (SQLSTATE 22023); message: the database's words, which never carry a token
  | { code: "REFUSED_CLAIM_KEY"; retryable: false; key: string }     // a key the registry calls ingested (an importer's) cannot claim
  | { code: "CLAIM_UNATTRIBUTED"; retryable: true; cause: "registry_away"; id: string; forced: boolean; lapsedAt?: string } // this key's agent id is not to hand while the registry may answer: its own claim made under it, by its token (forced: false), or a force, which the id classifies
  | { code: "CLAIM_UNATTRIBUTED"; retryable: false; cause: "registry_misconfigured" | "registry_refused" | "registry_unknown"; id: string; forced: boolean; lapsedAt?: string } // …and the registry cannot answer this server until an operator acts
  // Priority assertions (116, SMD-3664): set_priority, clear_priority, priority_history. `item` is 116's normalised
  // form of the caller's own input, so neither refusal tells a capture-only key what exists.
  | { code: "ITEM_NOT_FOUND"; retryable: false; which: "item" | "due_ref"; item: PriorityItem } // the brain holds no such item (or due reference, `which`): a thought, ticket, entity or open item (117)
  | { code: "ITEM_NOT_YOURS"; retryable: false; item: PriorityItem | null; dueRef: PriorityItem | null } // a capture-only key on anything but a thought it captured or an open item it opened, which nobody else took, or one its plugin's row stands for (or a due reference to one) — answered alike whether it exists or not
  | { code: "REFUSED_PRIORITY_INPUT"; retryable: false; problem: PriorityProblem; message: string } // an argument 116 refused by its rule (SQLSTATE 22023); message: the database's words
  | { code: "PRIORITY_UNATTRIBUTED"; retryable: true; cause: "registry_away" } // a capture-only key's agent id, which proves its own thoughts, is not to hand while the registry may answer
  | { code: "PRIORITY_UNATTRIBUTED"; retryable: false; cause: "registry_misconfigured" | "registry_refused" } // …and the registry cannot answer this server until an operator acts
  // Open items (117, SMD-3665 PR 2): the item writers' own refusals. ITEM_NOT_FOUND, ITEM_NOT_YOURS and READ_ONLY_KEY
  // above answer them too, an open item named `{kind: "item", key: <its id>}` — ITEM_NOT_YOURS's item null for a
  // proposal a capture-only key may not decide, which names no item it may be told of.
  | { code: "REFUSED_ITEM_INPUT"; retryable: false; problem: ItemProblem; message: string } // an argument 117 refused by raising (SQLSTATE 22023): `problem` names which; message: the database's words
  | { code: "ITEM_UNATTRIBUTED"; retryable: true; cause: "registry_away" } // a capture-only key's agent id, which proves its own items, is not to hand while the registry may answer
  | { code: "ITEM_UNATTRIBUTED"; retryable: false; cause: "registry_misconfigured" | "registry_refused" | "registry_unknown" } // …the registry cannot answer until an operator acts, or the server holds no id for the key and no word why (claims.ts's registry_unknown)
  | { code: "ITEM_UNOWNABLE"; retryable: false } // a caller with no agent id at all (a plugin hook's) opening an item for no plugin row: it could never be shown its own
  | { code: "ORIGIN_NOT_FOUND"; retryable: false; thought: string } // the thought an item was to be read from is not in the brain
  | { code: "EVIDENCE_NOT_FOUND"; retryable: false; thought: string } // the thought a proposed close cites is not in the brain
  | { code: "ITEM_SETTLED"; retryable: false; item: string; status: "done" | "dropped" } // a close proposed for an item already done or dropped
  | { code: "PROPOSAL_NOT_FOUND"; retryable: false; proposal: string } // no such proposed close (told to a write key alone)
  | { code: "PROPOSAL_DECIDED"; retryable: false; proposal: string; decision: "accepted" | "rejected" | "moot" } // the proposal is decided, or moot, already
  | { code: "PROPOSAL_YOURS"; retryable: false; proposal: string } // a proposal is accepted by a key other than its proposer
  | { code: "CONFIRM_NOT_YOURS"; retryable: false; item: string } // a capture-only key may dismiss a proposed item, never confirm it
  | { code: "READ_ONLY_KEY"; retryable: false; key: string }       // a key with neither write nor capture scope — 116's refusal, met by the core's own callers alone (the manifest gives a read key no writer)
  // The agenda (123, SMD-3669): holder mine reads work_claims, which a role without the claims group may not.
  | { code: "CLAIMS_UNREADABLE"; retryable: false } // the server's database role lacks the claims group, so it cannot read whose claims are whose
  | { code: "ORDER_UNAVAILABLE"; retryable: false } // order due on a brain before migration 129 (SMD-4192), whose agenda has the priority order alone
  // A read's own priority weights (SMD-4193): the agenda's and search_thoughts'. `rule`: the database refused them by
  // 122's rule (SQLSTATE 22023; the schema refuses a name or a range first, so in practice cap below
  // unblocks_many_at), message its words, naming the weight; `unranked`: search_thoughts given weights with neither
  // priority_weight above 0 nor min_priority, so nothing would read them. `named`: the weights the refusal names.
  | { code: "REFUSED_WEIGHTS"; retryable: false; problem: "rule" | "unranked"; message: string; named: string[] }
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

/** A claim in the way of a claim or a renewal, as a refusal names it: its id, work, holder, times and whether the caller's own key holds it — never its label, another key's free text, nor anything that proves ownership. */
export type HeldClaim = { id: string; issue: string; piece: string | null; holder: string; holderKind: string | null; claimedAt: string; expiresAt: string; ownKey: boolean };
/** What a decision does not take (SMD-3338), as the CLI refuses it: a direction or force on a reject, or a note beginning with the pass's own marker (067). */
export type ReviewArgumentProblem = "direction_on_reject" | "force_on_reject" | "note_marker";

/** Why a thought's evidence list will not take an entry (SMD-2690 PR 3b). */
export type EvidenceProblem = "full" | "not_list" | "metadata_not_object" | "unstamped";
/**
 * append_thought_evidence's bounds (SMD-2690 PR 3b), beside the refusal that
 * names the list's: a label, a source and an excerpt as smart-ingest's
 * vendored append took them, held, and a list a thought's metadata carries in
 * every read; `tries`, how often an append reads the thought before it answers
 * that the thought is busy.
 */
export const EVIDENCE_LIMITS = { label: 200, excerpt: 2_000, source: 200, entries: 100, tries: 10 } as const;

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
  // Which rule; a key that is no subject key is the caller's raw input, and stays in the text.
  REFUSED_THREAD_INPUT: (r) => ({ problem: r.problem }),
  // list_thoughts' (SMD-2995): which way the cursor would not do, and the sort it was made under — never the cursor itself;
  // list_supersession_proposals' (SMD-3249) the filters it was made under.
  REFUSED_CURSOR: (r) => ({ ...(r.reason ? { reason: r.reason } : {}), ...(r.sort ? { sort: r.sort } : {}), ...(r.made ? { made: r.made } : {}) }),
  // The provider's marker word and what was matched: the endpoint and the literals are in the text.
  EMBEDDING_PROVIDER_UNAVAILABLE: (r) => ({ reason: r.reason, matched: r.matched }),
  // The marker word, the provider's status and the setting to check: the endpoint (a reader's alone) and the
  // provider's own words ride the text, as EMBEDDING_PROVIDER_UNAVAILABLE's endpoint does — a URL is no token.
  EMBEDDING_PROVIDER_ERROR: (r) => ({ reason: r.reason, ...(r.status !== undefined ? { status: r.status } : {}), setting: r.setting }),
  REFUSED_SUPERSEDES_SHAPE: none,
  REFUSED_DERIVED_FROM_SHAPE: none,
  // Which rule, and the key, so a client reading values knows what to drop
  // (SMD-2617) — unless the key itself is malformed: a bad key is the
  // caller's raw input, and stays in the text.
  REFUSED_METADATA_SHAPE: (r) => ({ problem: r.problem, ...(r.key !== undefined && r.problem !== "bad_key" ? { key: r.key } : {}) }),
  REFUSED_CLIENT_KEY_SHAPE: none,
  REFUSED_CLIENT_KEY_SCOPE: none,
  REFUSED_SOURCE_RESERVED: (r) => ({ source: r.source }),
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
  REFUSED_THOUGHT_EVIDENCE: (r) => ({ problem: r.problem, ...(r.count !== undefined ? { count: r.count } : {}) }),
  THOUGHT_EVIDENCE_BUSY: none,
  // The claims in the way, as values a client acts on: ids, holders (a key's name, the env's), kinds and times — the
  // piece rides the text, being another key's words (SMD-3598).
  WORK_CLAIMED: (r) => ({ heldBy: r.heldBy.map((c) => ({ id: c.id, holder: c.holder, holderKind: c.holderKind, claimedAt: c.claimedAt, expiresAt: c.expiresAt, ownKey: c.ownKey })) }),
  CLAIM_NOT_FOUND: none,
  CLAIM_NOT_YOURS: (r) => ({ forced: r.forced, ownKey: r.ownKey }),
  CLAIM_RELEASED: (r) => ({ ...(r.releasedAt ? { releasedAt: r.releasedAt } : {}), takenOver: r.takenOver, ticketClosed: r.ticketClosed }),
  REFUSED_CLAIM_INPUT: (r) => ({ problem: r.problem }),
  REFUSED_CLAIM_KEY: none,
  // When the caller's own claim had lapsed (SMD-3705 review pass 1): another claim may cover its work by now.
  CLAIM_UNATTRIBUTED: (r) => ({ cause: r.cause, id: r.id, forced: r.forced, ...(r.lapsedAt ? { lapsedAt: r.lapsedAt } : {}) }),
  // The item as 116 keys it — a uuid or a ticket key, the caller's own input normalised — and which argument named it.
  ITEM_NOT_FOUND: (r) => ({ which: r.which, item: r.item }),
  ITEM_NOT_YOURS: (r) => ({ item: r.item, dueRef: r.dueRef }),
  REFUSED_PRIORITY_INPUT: (r) => ({ problem: r.problem }),
  READ_ONLY_KEY: none,
  PRIORITY_UNATTRIBUTED: (r) => ({ cause: r.cause }),
  // The open items' (SMD-3665 PR 2): ids and the words 117 answers in, never another key's text.
  REFUSED_ITEM_INPUT: (r) => ({ problem: r.problem }),
  ITEM_UNOWNABLE: none,
  ITEM_UNATTRIBUTED: (r) => ({ cause: r.cause }),
  ORIGIN_NOT_FOUND: (r) => ({ thought: r.thought }),
  EVIDENCE_NOT_FOUND: (r) => ({ thought: r.thought }),
  ITEM_SETTLED: (r) => ({ item: r.item, status: r.status }),
  PROPOSAL_NOT_FOUND: (r) => ({ proposal: r.proposal }),
  PROPOSAL_DECIDED: (r) => ({ proposal: r.proposal, decision: r.decision }),
  PROPOSAL_YOURS: (r) => ({ proposal: r.proposal }),
  CONFIRM_NOT_YOURS: (r) => ({ item: r.item }),
  CLAIMS_UNREADABLE: none,
  ORDER_UNAVAILABLE: none,
  // The weights it names, from the known names alone: the database's words ride the text.
  REFUSED_WEIGHTS: (r) => ({ problem: r.problem, named: r.named }),
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