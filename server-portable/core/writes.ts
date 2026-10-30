// The write operations (SMD-2283 PR 2): what capture_thought, update_thought
// and delete_thought did inside their MCP closures, as functions of a principal
// and a typed input. Each returns the typed value — the facts its reply is
// built from — or a typed refusal (core/refusal.ts), and throws a fault; the
// MCP registration renders it in the words it always has (render.ts), and the
// REST core (SMD-2284) answers it as JSON.

import { providerDown, type EmbedConfig, type EmbeddedCapture } from "../embed.ts";
import { heardFrom } from "../provider-health.ts";
import { extractMetadata, metadataRefused, metadataUnavailable, TAG_KEYS } from "../metadata.ts";
import { captureLineage } from "../lineage.ts";
import { classifyGenre } from "../genre.ts";
import { requestTimeoutMs, resolveJevConfig, type JevConfig } from "../jev.ts";
import { decideCalls, type EgressSubject } from "../egress.ts";
import { UUID_RE, type ActorStamp, type Citation, type RecaptureLabel, type ThoughtStore } from "../store.ts";
import { canRead, type Principal } from "../auth.ts";
import { citeRows, type Ctx } from "./context.ts";
import { META_KEYS_MAX, META_VALUE_MAX, TICKET_META_KEYS, ok, refuse, type MetadataProblem, type Outcome, type Refusal } from "./refusal.ts";
import type { Input } from "./schemas.ts";
import { PASS_SETTLED_PREFIX } from "../consolidate.ts";
import type { Reviewer } from "../proposal-review.ts";

// A caller-set metadata key (SMD-2014): lower-case, starts with a letter, 2-40
// characters — the shape a reader can filter on. The server owns some keys of
// `metadata`, and a caller naming one is refused rather than silently overruled
// by the merge below: `source` (the origin label, set from the `source` arg),
// the extractor's tag set (TAG_KEYS: type, topics, people…), the actor columns
// migration 050 stamps from the key and the trust migration 073 stamps beside
// them (SMD-1724), the embedding model migration 021 records,
// and the extractor's own failure marker. Everything else — `summary_model`,
// which the session hook sets when a local model wrote the summary — is the
// caller's to add. `client_key` is set only through capture_thought's own
// argument (SMD-3314), and no patch moves it.
//
// A key that cannot read is also refused the ticket keys (TICKET_META_KEYS,
// SMD-2617): 068's ticket head reads them from any row carrying `issue`, so a
// capture-only key could set the status every thought filed under the ticket
// reads; and on a pasted ticket header, with Linear's status, the watermark
// would have board-sync call the ticket unchanged, so Linear's edits to its
// text never reach the brain (changes/smd-2617.md). `ticket` files a thought
// under a ticket and is read ahead of `issue`; a write key's later merge onto
// the key's row kept it, so that writer's thought read another ticket's status
// (SMD-2657). A write key keeps them:
// it can edit any thought through update_thought anyway.
const META_KEY_RE = /^[a-z][a-z0-9_]{1,39}$/;
export const RESERVED_META: ReadonlySet<string> = new Set<string>([...TAG_KEYS, "source", "actor_kind", "actor_name", "trust", "embedding_model", "metadata_extraction_failed", "client_key"]);
const TICKET_META = new Set<string>(TICKET_META_KEYS);

/** The refusal for a bad `metadata` argument, or null when it is clean (or absent). Checked before the model calls, as the other shape refusals are. */
function metadataProblem(metadata: Record<string, unknown> | undefined, reader: boolean): Refusal | null {
  if (metadata === undefined) return null;
  const at = (problem: MetadataProblem, rest: { key?: string; count?: number; length?: number } = {}): Refusal => ({ code: "REFUSED_METADATA_SHAPE", retryable: false, problem, ...rest });
  const keys = Object.keys(metadata);
  if (keys.length > META_KEYS_MAX) return at("too_many_keys", { count: keys.length });
  for (const k of keys) {
    if (!META_KEY_RE.test(k)) return at("bad_key", { key: k });
    if (RESERVED_META.has(k)) return at("reserved_key", { key: k });
    if (!reader && TICKET_META.has(k)) return at("ticket_key", { key: k });
    const v = metadata[k];
    if (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") return at("bad_value", { key: k });
    if (typeof v === "string" && v.length > META_VALUE_MAX) return at("value_too_long", { key: k, length: v.length });
  }
  return null;
}

/** Whether an id of `ids` names a thought: the store's answer, read once, cased as Postgres hands ids back. */
async function liveIn(store: ThoughtStore, ids: string[]): Promise<(id: string) => boolean> {
  const have = await store.existingIds(ids);
  return (id) => have.has(id.toLowerCase());
}

/**
 * The ids in `ids` that name a thought, or undefined when none does — the one
 * rule for trimming a capture-only key's `derived_from` before the write and
 * again on the retry (thirteenth review pass: it was spelled twice).
 */
async function liveSubset(store: ThoughtStore, ids: string[]): Promise<string[] | undefined> {
  const live = await liveIn(store, ids);
  const kept = ids.filter(live);
  return kept.length ? kept : undefined;
}

/**
 * The audit trail's actor for a write through this core (SMD-1730): the key's
 * name — what the agent was CALLED when it wrote, which a later rename would
 * otherwise erase — the stable id migration 010 resolved it to (absent when
 * the registry could not answer; see agents.ts), the door (046's origin), and
 * who carried it when it was forwarded (SMD-2284, `act`). One place, so a
 * field added to the actor reaches every write.
 */
const actorOf = (ctx: Ctx, principal: Principal) => ({ name: principal.name, agentId: principal.agentId, via: ctx.door, ...(principal.act ? { act: principal.act } : {}) });

/** A whole-content embedding that fell back to the head window (embed.ts): what an edit or a capture reply says about it. */
export type HeadWindow = { fellBack: boolean; refused: boolean; error?: string };
const headWindowOf = (e: EmbeddedCapture | undefined): HeadWindow | null =>
  e ? { fellBack: e.wholeContentFellBack === true, refused: e.wholeContentRefused === true, ...(e.wholeContentError ? { error: e.wholeContentError } : {}) } : null;

/** One egress decision as a reply states it (SMD-1903). */
export type GateCall = { allowed: boolean; reason: string };

/**
 * What a capture did, as its reply states it. `existed` and the re-capture's
 * pointers are the reader's only: a key that cannot read is not told whether
 * the text was already a thought, nor what it points at (SMD-1298, the
 * existence-oracle rule).
 */
export type Captured = {
  id: string;
  /** Whether the text was already a thought (035); absent for a key that cannot read, or a database before 035. */
  existed?: boolean;
  /** Whether the caller can read — what a note may say about the row. */
  reader: boolean;
  /** The extractor's tags (or the refusal marker), as stored. */
  tags: Record<string, unknown>;
  embeddings: GateCall;
  chat: GateCall & { base: string };
  chunks: number;
  contextFailures: number;
  headWindow: HeadWindow | null;
  /** A re-capture that named pointers it could not write (035): what was named, and what stands. Reader only. */
  recapture: { derivedNamed: boolean; given?: string; current: string | null } | null;
  /** What the re-capture did to a capture-only key's label (090, SMD-2898). Reader only, on a re-capture; absent before 090. */
  label?: RecaptureLabel;
  /**
   * The embedding call was made and the provider did not answer (SMD-2888):
   * providerDown's word and words, and the endpoint dialled. The thought
   * landed without its vector, as a refused call's does. Absent otherwise.
   */
  vectorFailed?: { reason: string; detail: string; base: string };
  /**
   * What became of a `client_key` (SMD-3314): `matched` — a thought already
   * had it as its id or its key, and is returned with nothing written;
   * `recaptured` — that thought holds this very text, so this was a
   * re-capture of it, merged as any is (080), the key not sent again;
   * `recorded` — the row keeps it; `held` — the text's row keeps another key
   * (`heldKey`) and keeps it, so this one names nothing. Absent without a key.
   */
  keyed?: "matched" | "recaptured" | "recorded" | "held";
  heldKey?: string;
};

/**
 * A keyed capture whose key names a thought already (SMD-3314): that thought,
 * as a re-capture that wrote nothing and made no model call.
 */
function keyMatched(id: string, chatBase: string): Captured {
  const reason = "the client_key names a thought already, so nothing was written";
  return {
    id, existed: true, reader: true, tags: {},
    embeddings: { allowed: false, reason }, chat: { allowed: false, reason, base: chatBase },
    chunks: 0, contextFailures: 0, headWindow: null, recapture: null, keyed: "matched",
  };
}

/**
 * The longest a capture's model calls may run under these settings, in
 * seconds (SMD-2768): the embedding, the metadata extraction and the genre
 * tier run at once (capture's Promise.all), each provider call bounded by
 * OB1_LLM_TIMEOUT and the tier's by its own deadline. With OB1_CHUNK_CONTEXT
 * on, a long text's windows are blurbed before they are embedded: two rounds.
 * What a webhook's delivery-id lease is sized from (plugin-sdk.ts's onceById).
 */
export function captureCallSeconds(cfg: Pick<EmbedConfig, "timeoutMs" | "chunkContext">, jev: Pick<JevConfig, "timeoutMs"> | null): number {
  const rounds = cfg.chunkContext ? 2 : 1;
  return Math.max(rounds * cfg.timeoutMs, jev ? requestTimeoutMs(jev, 1) : 0) / 1000;
}

export async function capture(ctx: Ctx, principal: Principal, { content, derived_from, supersedes, source, trust, metadata: clientMetadata, client_key }: Input<"capture_thought">): Promise<Outcome<Captured>> {
  // What a key that cannot read is told and allowed — decided once here
  // and read below, in the catch too (fifth review pass: six scattered
  // canRead tests; sixth: one survived in the catch).
  const reader = canRead(principal);
  try {
    // The row's origin label: the caller's, else the one every capture
    // through this tool carried before `source` existed (SMD-1298).
    const origin = source ?? "mcp";
    // The shape before the two model calls, in the tool's words — as
    // update_thought's `supersedes` is refused (032). upsert_thought would
    // raise on it after the embedding and the metadata were already paid for.
    if (supersedes !== undefined && !UUID_RE.test(supersedes)) return refuse({ code: "REFUSED_SUPERSEDES_SHAPE", retryable: false, value: supersedes, orNull: false });
    // derived_from's SHAPE likewise (fourth review pass): a non-id element
    // paid both model calls before validate_derived_from refused it.
    // Existence stays the write's.
    const badDerived = derived_from?.find((d) => !UUID_RE.test(d));
    if (badDerived !== undefined) return refuse({ code: "REFUSED_DERIVED_FROM_SHAPE", retryable: false, value: badDerived });
    // A caller `metadata` key that names a server-owned one, or a bad shape,
    // is refused BEFORE the two model calls are paid for (SMD-2014), as the
    // pointer shapes above are.
    const badMetadata = metadataProblem(clientMetadata, reader);
    if (badMetadata) return refuse(badMetadata);
    // The client's idempotency key (SMD-3314): a key that can read only, as
    // the reply to a key that names a thought already would tell a
    // capture-only key whether an id exists (SMD-1298's rule).
    let clientKey: string | undefined;
    if (client_key !== undefined) {
      if (!reader) return refuse({ code: "REFUSED_CLIENT_KEY_SCOPE", retryable: false });
      if (!UUID_RE.test(client_key)) return refuse({ code: "REFUSED_CLIENT_KEY_SHAPE", retryable: false, value: client_key });
      clientKey = client_key.toLowerCase();
    }
    // A reader's names resolve on this brain (SMD-3314): the thought with
    // that id, else the one keeping it as its client_key — so a write copied
    // from another brain names its thoughts as that brain did. One read for
    // the key and every pointer, before the model calls are paid for; a name
    // that resolves to nothing goes on as given, to be refused as before.
    // A key naming a thought that holds this very text is a re-capture of it:
    // it goes on as one, without the key, so the copy takes what the first
    // brain's re-capture merged (080) rather than nothing (review pass 1).
    let recaptureOfKeyed = false;
    if (reader && (clientKey !== undefined || supersedes !== undefined || derived_from?.length)) {
      const store = await ctx.store();
      const named = await store.thoughtsNamed([...(clientKey ? [clientKey] : []), ...(supersedes !== undefined ? [supersedes] : []), ...(derived_from ?? [])]);
      const matched = clientKey !== undefined ? named.get(clientKey) : undefined;
      if (matched) {
        if ((await store.keyAtText(content))?.id !== matched) return ok(keyMatched(matched, ctx.embedConfig().chat.base));
        recaptureOfKeyed = true;
      }
      if (supersedes !== undefined) supersedes = named.get(supersedes.toLowerCase()) ?? supersedes;
      if (derived_from) derived_from = derived_from.map((d) => named.get(d.toLowerCase()) ?? d);
    }
    // A capture-only key's provenance is trimmed to the ids that exist
    // BEFORE the write, and the reply says nothing of it — not which
    // (third review pass: positions were an existence oracle on a key that
    // cannot read) and not how many (eighth: with one id sent, the count
    // was the answer). A reader is refused with positions and ids, and can
    // look. A summary with its live sources beats a refusal over one
    // deleted thought; the row's derived_from says what was recorded.
    let derivedFrom = derived_from;
    if (derivedFrom?.length && !reader) derivedFrom = await liveSubset(await ctx.store(), derivedFrom);
    // A capture-only key may replace only what it captured itself (SMD-1298,
    // first review pass): `supersedes` marks the target superseded in every
    // search result — an alteration of a thought the key did not write, the
    // one thing the scope promises it cannot do. Ownership is the target's
    // capture audit row (008/010) carrying this key's agent id, the thought
    // still standing, and no other key or board-sync having taken it since
    // (migration 082, SMD-2638). A pointer that is not provably so is dropped
    // before the write, and the reply says nothing of it, as derived_from's
    // trim above (SMD-2473): any answer that differed by target told a key
    // that cannot read something it may not know — whether an id exists,
    // was deleted, or is another key's, and, through a re-capture's id,
    // whether a text was already in the brain. The row's supersedes says
    // what was recorded. No ownership by name: a row written without an id
    // (the registry away at the write) could be claimed by a later key
    // minted under the same name. (An attributed row follows the name the
    // registry's way — 010 maps a known label with a new digest to the same
    // agent, a rotation — which is that design's, not this check's.)
    let pointer = supersedes;
    if (supersedes !== undefined && !reader && principal.agentId === undefined) {
      // This key's id is not to hand, so no pointer of its is provable. Asked
      // before the target is read, so the answer is the same for every target:
      // a retry while the registry may answer, else the pointer goes.
      if (principal.agentUnresolved === "unreachable") return refuse({ code: "SUPERSEDES_UNJUDGED", retryable: true, cause: "registry_away" });
      pointer = undefined;
    } else if (supersedes !== undefined && !reader) {
      let writer: Awaited<ReturnType<ThoughtStore["captureActorOf"]>>;
      let present: boolean;
      let taken: boolean;
      try {
        // All three reads for every target, so no cell is a query shorter.
        const store = await ctx.store();
        const target = supersedes;
        [writer, present, taken] = await Promise.all([
          store.captureActorOf(target),
          liveIn(store, [target]).then((live) => live(target)),
          store.takenFromCapturer(target),
        ]);
      } catch (e) {
        // The reads need SELECT on thought_audit and thoughts — the `server` grant group,
        // soft like the rest of it (second review pass: the capture group
        // holds INSERT alone). Refuse THIS pointer, name the grant, and let
        // the capture proceed without it on the caller's retry.
        // An ERROR of the server's, not a refusal of the request as shaped:
        // a caller keeps the pointer and tries again once the grant is
        // there (fifth review pass: "Refused:" made the hook drop it, and
        // the hook told the two apart by the sentence's wording).
        const why = String((e as Error).message ?? e).slice(0, 120);
        // The grant remedy only for a privilege error (42501, on `errno` where
        // Bun's SQL puts the SQLSTATE, as agents.ts reads it; `code` where an
        // error carries it there); a dropped connection or a timeout gets the store's
        // own words, since `--grant` would change nothing there (sixth review pass).
        const { errno, code } = e as { errno?: unknown; code?: unknown };
        const noPrivilege = String(errno ?? code ?? "") === "42501" || /permission denied/i.test(why);
        return refuse({ code: "SUPERSEDES_UNJUDGED", retryable: true, cause: "check_failed", detail: why, noPrivilege });
      }
      // The audit row outlives a delete: a deleted thought of this key's
      // passes on it, and `present` drops it like the rest (SMD-2473 case 2;
      // it reached the self-FK and answered as no other target did).
      // Spelled whole, not leaning on the branch above for principal.agentId:
      // a row with no capture audit row, or one without an id, is never owned.
      // Nor is one another key or board-sync has since taken (SMD-2638): a
      // write key's capture of the same text lands on the row, and board-sync
      // adopts it in place, so capturing a text first does not keep it this
      // key's; nor does one a reviewer's accept or another key's pointer put
      // over a thought this key did not capture, through any number of
      // links (092, SMD-2708). takenFromCapturer reads 082's log and 092's
      // chain, and the lapse clears a pointer this key wrote before the
      // taking.
      const own = present && writer !== null && writer.agentId !== null && writer.agentId === principal.agentId && !taken;
      if (!own) pointer = undefined;
    }
    // What may leave the box (SMD-1903): asked once, for both calls, and
    // only the allowed ones are made — a refused capture costs no request
    // and lands all the same, without the vector or the tags the refused
    // call would have produced, with the decision on its audit row.
    const cfg = ctx.embedConfig();
    // Gated on `actor` (the key, proven) and `marker` (the text), NOT
    // `source`: a capture's `source` is the caller's claim, so the subject
    // carries none and no `source:` term can match this call — re-adding it
    // here reopens the dodge (SMD-1941; egress.ts EGRESS_UNITS). The row
    // still RECORDS the label below, for the passes and the per-source weight.
    const subject: EgressSubject = { kind: "capture", actor: principal.name, content };
    const gate = decideCalls(subject, cfg, cfg.egress);
    // Independent of each other, so they overlap. The genre classifier reads
    // the caller's metadata (a `source:linear`/arXiv pre-signal) and, only
    // when the tier is configured, the content — never the extractor's tags,
    // so it need not wait for extractMetadata (SMD-2323). Its own egress is
    // the tier's, so it runs regardless of the capture's chat gate; a tier
    // outage falls back to `other` inside the classifier, never here.
    // A provider that did not answer the embedding call (refused, timed out,
    // 5xx) lands the thought without its vector, as a refused call does,
    // rather than losing it: the capture is the one write whose text may
    // exist nowhere else (SMD-2888). Any other failure — a 4xx, a width
    // mismatch — still fails the capture, so a misconfigured brain says so.
    let vectorFailed: { reason: string; detail: string } | undefined;
    // The provider's state, as every embedding call tells it (SMD-2890).
    const embedStarted = performance.now();
    const [embedded, metadata, genre] = await Promise.all([
      gate.embeddings.allowed
        ? ctx.embedder.embedCapture(content, subject).then((v) => {
            heardFrom(ctx.providerHealth, embedStarted);
            return v;
          }, (e: unknown) => {
            const down = providerDown(e);
            if (!down) { heardFrom(ctx.providerHealth, embedStarted, e); throw e; }
            console.error(`capture: the embedding provider at ${cfg.embeddings.base} was unavailable: ${down.detail}; saved without a vector`);
            heardFrom(ctx.providerHealth, embedStarted, e);
            vectorFailed = down;
            return undefined;
          })
        : Promise.resolve(undefined),
      // A chat provider that did not answer at the socket (extractMetadata
      // throws the runtime's error, so board-sync retries the item) is the
      // marker alone here: with one provider down, this call fails beside the
      // embedding's, and the capture lands all the same (SMD-2888).
      gate.chat.allowed
        ? extractMetadata(content, subject, cfg).catch((e: unknown) => {
            const down = providerDown(e);
            if (!down) throw e;
            console.error(`capture: the chat provider at ${cfg.chat.base} was unavailable: ${down.detail}`);
            return metadataUnavailable(down.reason);
          })
        : Promise.resolve(metadataRefused()),
      // The genre classifier (SMD-2323): a deterministic pre-signal over the
      // metadata first, then the typed-decision tier when OB1_JEV_BASE_URL names
      // one — opt-in and null-by-default, so a capture pays nothing for it unless
      // the tier is configured.
      classifyGenre(content, { ...clientMetadata, source: origin }, resolveJevConfig(ctx.env()), subject),
    ]);
    const chunks = embedded?.chunks ?? [];
    const contextFailures = embedded?.contextFailures ?? 0;

    // The caller's keys UNDER the server's: the extractor's tags and the
    // origin label win over anything a caller sent by the same name (the
    // shape check above has already refused a reserved key outright, so this
    // only orders the rest), and `summary_model` and its like survive
    // (SMD-2014).
    // `genre` last, over both spreads: the classifier already honours a valid
    // caller-supplied genre (its pre-signal returns it), so placing the
    // classified value here lets that one round-trip while a bogus one is
    // overwritten by the classification (SMD-2323).
    // The key, on the row this capture lands on (SMD-3314): a text already
    // captured is merged into its row (080), and a row keeping another key
    // keeps it — two brains' ids for one text cannot both name it, and the
    // first stands — so this one is not sent, and the reply says so.
    let keyed: "recorded" | "held" | "recaptured" | undefined;
    let heldKey: string | undefined;
    if (recaptureOfKeyed) keyed = "recaptured";
    else if (clientKey !== undefined) {
      const row = await (await ctx.store()).keyAtText(content);
      // A key a caller's metadata set before 112 reserved it may be any text:
      // said only when it is a key's shape.
      if (row?.clientKey && row.clientKey.toLowerCase() !== clientKey) { keyed = "held"; if (UUID_RE.test(row.clientKey)) heldKey = row.clientKey.toLowerCase(); }
      else keyed = "recorded";
    }
    // Built per attempt: a retry below may go without the key.
    const payloadOf = () => ({ metadata: { ...clientMetadata, ...metadata, source: origin, genre: genre.genre, ...(keyed === "recorded" ? { client_key: clientKey } : {}) } });

    // Atomicity is the store's: it writes content, metadata and vector in one
    // statement, so a row is never committed without the embedding it was
    // given.
    // A source deleted between the trim above and this write — the one path
    // left to 025's refusal for a key that cannot read — is met by trimming
    // once more and writing again, so the summary keeps its live sources;
    // the refusal that reaches such a key names no position, and the hook
    // could only drop the whole list (twelfth review pass). A reader is
    // refused as before, with positions, and decides. The same for the
    // pointer: its own thought deleted between the check and the write meets
    // the self-FK, and the write goes again without it, so the race answers
    // as the check would have (SMD-2473).
    const store = await ctx.store();
    const captureArgs = {
      content,
      chunks,
      // 061: what this capture derived and how — the windows' split and
      // the extractor's model, prompt version and hash — recorded with
      // the write (SMD-1731). Nothing when it made no windows and the
      // extraction failed or was refused: a caller's tags are not a
      // derivation.
      lineage: captureLineage(cfg, embedded, metadata),
      // The audit trail's actor (actorOf); the row's source is its own
      // metadata.source, "mcp" above, which the trigger reads itself (SMD-1730).
      actor: {
        ...actorOf(ctx, principal),
        // The gate's decisions for this write, on the audit row (SMD-1903);
        // absent when both endpoints are declared local and nothing was judged.
        ...(gate.record ? { egress: gate.record } : {}),
        // Why an allowed embedding call left no vector (SMD-2888): beside
        // the gate's record, so the audit row says which of the two it was.
        ...(vectorFailed ? { vectorFailed: vectorFailed.reason } : {}),
        // A key that cannot read, said on its capture row: 082's lapse clears
        // a pointer such a key wrote once another key takes the thought it
        // points at; a write key's pointer it leaves (SMD-2638).
        ...(reader ? {} : { scope: "capture" as const }),
      },
      // NULL when the gate refused the embedding call, or the provider did
      // not answer it: the row lands with its text and fingerprint and no
      // vector, as the reply says.
      embedding: embedded?.embedding ?? null,
      // The model this vector came from, recorded on the row (021) — the
      // one the embedder used, not the one ob1_config records: they differ
      // exactly while a re-embed to another model is under way.
      embeddingModel: embedded?.model,
      // 025's provenance — derived_from and supersedes, if the caller named
      // any — is added per attempt below. upsert_thought validates derived_from
      // and refuses a bad reference, so a malformed value fails the capture
      // with a clear message rather than storing a lie.
      // SMD-1724: the content's trust as this write declares it — the event's
      // (046), which 073 clamps to the key's kind: a lowering stands, a raise
      // is filed as a claim on the audit row. Absent: the key's trust.
      ...(trust !== undefined ? { event: { trust } } : {}),
      // A capture-only key alters no thought it did not write (SMD-1298), and
      // a re-capture of text already in the brain lands on that thought's row:
      // "keep" has 080's upsert_thought leave it — no metadata, no source, no
      // event, no updated_at — save a vector the row lacks (SMD-2539). Its own
      // text too: one rule, no ownership read. A write key keeps the merge;
      // it holds update_thought, so the merge grants it nothing.
      ...(reader ? {} : { recapture: "keep" as const }),
    };
    let captured;
    // One mend per pointer kind: the pointer's ends itself (it is gone), and
    // derived_from's is counted on its own — a shared cap spent on two source
    // races let the third attempt meet the self-FK and answer UNKNOWN to a key
    // that cannot read (review pass 1).
    let derivedMended = false;
    // One retry for a keyed capture whose read of the row was overtaken (SMD-3314, review pass 2).
    let keyRaced = false;
    for (;;) {
      try {
        captured = await store.captureThought({ ...captureArgs, payload: payloadOf(), supersedes: pointer, derivedFrom });
        break;
      } catch (e) {
        const msg = String((e as Error)?.message ?? e);
        // Another capture with this key landed between the read above and
        // this write (112's unique index): that thought, as a match. It holds
        // other text — copies of one text serialise on 033's fingerprint lock
        // and land on one row, never meeting the index. Its holder gone again
        // by the re-read, the write goes once more as read (review pass 2).
        if (clientKey !== undefined && keyed === "recorded" && !keyRaced && /thoughts_client_key_unique/.test(msg)) {
          keyRaced = true;
          const held = (await store.thoughtsNamed([clientKey])).get(clientKey);
          if (held) return ok(keyMatched(held, cfg.chat.base));
          continue;
        }
        // The text's row took another key between the read and this write
        // (112's set-once trigger refused the merge, and its event with it):
        // the capture goes again without the key, as the read would have
        // answered — held, naming the row's key (review pass 2).
        if (clientKey !== undefined && keyed === "recorded" && !keyRaced && /client_key is set once/.test(msg)) {
          keyRaced = true;
          const row = await store.keyAtText(content);
          keyed = "held";
          heldKey = row?.clientKey && UUID_RE.test(row.clientKey) ? row.clientKey.toLowerCase() : undefined;
          continue;
        }
        if (reader) throw e;
        // The pointer's target gone mid-write (the self-FK), or no longer this
        // key's alone by the time the write ran — 082's check at the write,
        // which waits for a taking the reads above could not see (SMD-2638):
        // either way the capture lands without it, as the reads would have.
        if (pointer !== undefined && /thoughts_supersedes_fkey|ob1_check_capture_pointer/.test(msg)) pointer = undefined;
        else if (!derivedMended && derivedFrom?.length && /derived_from references a thought that does not exist/.test(msg)) { derivedMended = true; derivedFrom = await liveSubset(store, derivedFrom); }
        else throw e;
      }
    }

    // Memory utilization (SMD-1719, over 034's log): a capture that names a
    // returned id as its source — `derived_from`, or `supersedes` — is the
    // caller USING a search result in a write, the signal MERIT calls memory
    // utilization and this fork's fetch/edit/delete rows cannot carry (they
    // say the caller looked, not that the fact reached a write). A cite row
    // is a pointer the database ACCEPTED: on a fresh row upsert_thought
    // validated every id (a ghost or a loop threw, and nothing reaches
    // here); on a re-capture (`existed`) 035 wrote no pointer and validated
    // none, so nothing is logged — the note below sends the caller to
    // update_thought, which logs the cite when it writes the pointer. The
    // store says `existed: false` only when 035's function answered; a
    // brain without 035 reports nothing, and nothing is logged there
    // either (second review pass: `!== true` had read an absent flag as
    // "fresh" on the one schema where the pointer's fate is unknown).
    if (captured.existed === false) {
      await ctx.logActions(principal, citeRows("capture_thought", { derived_from: derivedFrom, supersedes: pointer }));
    }

    // What a key that cannot read may be told about the row: not whether
    // the text was already a thought, nor what it points at (first review
    // pass — an existence oracle on a capture-only key). The id is returned
    // either way; a hook needs it to supersede its own earlier summary.
    const existed = reader ? captured.existed : undefined;
    // So a capture key's reply is a fresh capture's even where its re-capture
    // wrote nothing (080's 'keep', SMD-2539): the chunk count and the notes
    // below speak of what a capture computed, not of what landed.
    // Migration 035 (SMD-1453): a re-capture writes no provenance, so what was
    // named here and what stands — the row's pointer the store returned beside
    // `existed` — are what the note says.
    const derivedNamed = derivedFrom !== undefined && derivedFrom.length > 0;
    const recapture = existed === true && (derivedNamed || supersedes !== undefined)
      ? { derivedNamed, ...(supersedes !== undefined ? { given: supersedes } : {}), current: captured.supersedes ?? null }
      : null;
    return ok({
      id: captured.id,
      ...(existed === undefined ? {} : { existed }),
      reader,
      tags: metadata as Record<string, unknown>,
      embeddings: { allowed: gate.embeddings.allowed, reason: gate.embeddings.reason },
      chat: { allowed: gate.chat.allowed, reason: gate.chat.reason, base: cfg.chat.base },
      chunks: chunks.length,
      contextFailures,
      headWindow: headWindowOf(embedded),
      recapture,
      // 090 (SMD-2898): the label's fate, under the existence-oracle rule —
      // the stores weigh only a reader's re-capture, and `existed` above is
      // a reader's alone.
      ...(existed === true && captured.label ? { label: captured.label } : {}),
      ...(vectorFailed ? { vectorFailed: { ...vectorFailed, base: cfg.embeddings.base } } : {}),
      ...(keyed ? { keyed } : {}),
      ...(heldKey ? { heldKey } : {}),
    });
  } catch (err: unknown) {
    const msg = (err as Error)?.message ?? "";
    // 025's self-FK is what refuses a reader's first capture whose supersedes
    // names no thought (a key that cannot read has the pointer mended above,
    // and a re-capture writes no pointer, so it never fires there —
    // migration 035). Said as update_thought says it, not as Postgres does
    // (fourth review pass).
    if (/thoughts_supersedes_fkey/.test(msg)) return refuse({ code: "REFUSED_SUPERSEDES_UNKNOWN", retryable: false });
    // Its sibling: validate_derived_from's existence refusal (032), the
    // one provenance refusal that still reached the caller as a raw error
    // (fifth review pass).
    if (/derived_from references a thought that does not exist/.test(msg)) {
      // WHICH ones (second review pass): 025 names the whole list, so the
      // store is asked which exist and the reply names the POSITIONS that
      // do not — what a caller needs to drop exactly those and try again,
      // and nothing it did not send — with the ids beside them for a key
      // that can read. A capture key's list was trimmed before the write
      // (third review pass), so it reaches here only when a source was
      // deleted between the check and the write — and is told no position
      // even then (eighth review pass: the race was the one path that still
      // named one to a key that cannot read).
      const sent = derived_from ?? [];
      let missingAt: number[] = [];
      if (reader) { // a non-reader is told no position, so the store is not asked (tenth review pass)
        try {
          const live = await liveIn(await ctx.store(), sent);
          missingAt = sent.map((d, i) => (live(d) ? -1 : i)).filter((i) => i >= 0);
        } catch { /* the store could not say: the list alone, then */ }
      }
      // The positions are named only to a caller allowed to know a source
      // exists (the existence-oracle rule); a capture key gets the code with
      // none, and so no `positions` beside it (SMD-1978).
      const named = reader && missingAt.length ? missingAt : [];
      return refuse({ code: "DERIVED_FROM_MISSING", retryable: false, named: named.map((i) => ({ position: i, id: sent[i] })) });
    }
    // The store did not answer as itself — down, a missing function, a front
    // returning 401: the MCP layer says STORE_UNAVAILABLE (SMD-1978).
    throw err;
  }
}

/** The keys of a thought's stamp, which the server writes and a caller's metadata cannot (050, 073). */
export const STAMP_KEYS = ["actor_kind", "actor_name", "trust"] as const;
/**
 * A stamp key a patch named and the row kept: the key; the value the row
 * holds when it is a string; and whether it holds one at all (a JSON null
 * is none), so a value that is there but not a string (a raw writer's) is
 * not said to be unset.
 */
export type KeptKey = { key: (typeof STAMP_KEYS)[number]; value: string | null; present: boolean };

/**
 * The stamp keys a metadata patch named whose value the row did not take
 * (SMD-2744): the patch against the stamp update_thought answers it wrote
 * (088), read inside the write — no read after it, so no other write, pass
 * or clock stands between (the read-back this replaced met each of those in
 * turn). Undefined when the patch named none, or the database answered no
 * stamp (one before 088), so nothing is claimed; else the list — empty when
 * every named key matches the row (an echo, or a lower trust a change of
 * text declared).
 */
export function keptStampKeys(stamp: Record<string, unknown> | undefined, patch: Record<string, unknown> | undefined): KeptKey[] | undefined {
  const named = patch ? STAMP_KEYS.filter((k) => Object.hasOwn(patch, k)) : [];
  if (!named.length || !patch || !stamp) return undefined;
  const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  return named.filter((k) => !same(stamp[k], patch[k]))
    .map((k) => ({ key: k, value: typeof stamp[k] === "string" ? (stamp[k] as string) : null, present: stamp[k] !== undefined && stamp[k] !== null }));
}

/** What an edit did, as its reply states it. */
export type Updated = {
  id: string;
  /** The client_key the edit named its thought by, when no thought had it as its id (SMD-3314). */
  byClientKey?: string;
  updatedAt?: string;
  /** The text: moved and re-embedded, moved without a vector (the gate refused the call), or left alone. */
  contentChange: "reembedded" | "no_vector" | null;
  /** Whether the patch merged anything (088's answer): a key the server does not set changed, or a change of text took its trust — not a stamp key the row kept, nor one that echoed it. */
  metadataMerged: boolean;
  /** The stamp keys the patch named whose value the row did not take, with the value it holds (SMD-2744); absent when none. */
  kept?: KeptKey[];
  /** The patch merged nothing and kept nothing: it named what the thought already held (SMD-2744). */
  metadataEcho?: true;
  /** Whether the text counts as the one the thought held, by 003's fingerprint (088); absent when the database does not say. */
  sameText?: boolean;
  /** The row's metadata is SQL NULL (a raw writer's), which merges no patch, and the patch named a key the server does not set (088). */
  patchDropped?: true;
  /** The trust the patch sent, when the row did not take it: the word, or null for a null or a non-string. */
  trustSent?: string | null;
  /** Why a change of text left no trust, when the stamp says (review pass 7): the key has no kind, or the metadata is not an object (a raw writer's), which takes no stamp. */
  stampGap?: "no_kind" | "not_object";
  /** The pointer as the caller set it: an id, null for cleared, absent when left alone. */
  supersedes?: string | null;
  contextFailures: number;
  /** 018's pair: the edit's text is also another thought's, or another's stale fingerprint blocks this one's. */
  duplicateOf?: string;
  fingerprintHeldBy?: string;
  headWindow: HeadWindow | null;
  /** The gate's reason when it refused the embedding call (SMD-1903). */
  noVectorReason?: string;
};

/** A store's refusal of an edit or a delete (018, 032, 042) as a typed refusal. */
function storeRefusal(r: { error: string; currentUpdatedAt?: string; citedBy?: number; citations?: Citation[] }, id: string): Refusal {
  switch (r.error) {
    case "NOT_FOUND": return { code: "NOT_FOUND", retryable: false, id };
    case "STALE_READ": return { code: "REFUSED_STALE_READ", retryable: false, id, ...(r.currentUpdatedAt ? { currentUpdatedAt: r.currentUpdatedAt } : {}) };
    case "DUPLICATE_CONTENT": return { code: "REFUSED_DUPLICATE_CONTENT", retryable: false };
    case "SUPERSEDES_NOT_FOUND": return { code: "REFUSED_SUPERSEDES_UNKNOWN", retryable: false };
    case "WOULD_CYCLE": return { code: "REFUSED_WOULD_CYCLE", retryable: false, id };
    case "CITED": return { code: "REFUSED_CITED", retryable: false, id, ...(r.citedBy !== undefined ? { citedBy: r.citedBy } : {}), ...(r.citations ? { citations: r.citations } : {}) };
    default: return { code: "REFUSED", retryable: false, error: r.error };
  }
}

/**
 * The thought a write names (SMD-3314): the one with that id, else the one
 * keeping it as its client_key — for a key that can read; a capture-only key
 * names by id alone. `byClientKey` is the name when it was a key, so the
 * reply can say which thought it reached.
 */
async function targetNamed(ctx: Ctx, principal: Principal, name: string): Promise<{ id: string; byClientKey?: string }> {
  if (!canRead(principal) || !UUID_RE.test(name)) return { id: name };
  const id = (await (await ctx.store()).thoughtsNamed([name])).get(name.toLowerCase());
  return id && id !== name.toLowerCase() ? { id, byClientKey: name.toLowerCase() } : { id: name };
}

export async function updateThought(ctx: Ctx, principal: Principal, { id: name, content, metadata_patch, if_unchanged_since, supersedes }: Input<"update_thought">): Promise<Outcome<Updated>> {
  if (content === undefined && metadata_patch === undefined && supersedes === undefined) return refuse({ code: "REFUSED_NOTHING_TO_UPDATE", retryable: false });
  // The shape here, as the two named refusals are; the function would raise on
  // it, and a raised message reads as a failure rather than a refusal. The
  // string "null" is not a clear — clearing is JSON null, and a client that
  // sends the word meant an id.
  if (typeof supersedes === "string" && !UUID_RE.test(supersedes)) return refuse({ code: "REFUSED_SUPERSEDES_SHAPE", retryable: false, value: supersedes, orNull: true });
  // A name that is no uuid names no thought, by id or by key: the function's
  // cast would raise it as a fault (review pass 2), as reset_capture_stamp's does.
  if (!UUID_RE.test(name)) return refuse({ code: "NOT_FOUND", retryable: false, id: name.slice(0, 80) });
  // The key is capture_thought's to set, once (SMD-3314): a patch moving it
  // would let one thought take another's name on every brain.
  if (metadata_patch !== undefined && Object.hasOwn(metadata_patch, "client_key")) return refuse({ code: "REFUSED_METADATA_SHAPE", retryable: false, problem: "reserved_key", key: "client_key" });
  // The thought and the pointer, each by id else by client_key (SMD-3314).
  const { id, byClientKey } = await targetNamed(ctx, principal, name);
  if (typeof supersedes === "string") supersedes = (await targetNamed(ctx, principal, supersedes)).id;

  // Only re-embed when the text actually changed. A metadata-only edit
  // must not spend two model calls, nor risk replacing a good vector.
  // The gate as at capture (SMD-1903), asked only when the text moves:
  // refused, the new text is stored and the stale vector cleared with it
  // (update_thought's rule: content and no vector is NULL), and the
  // reply says so.
  // The subject is the ROW — its own source, type and topics, which a
  // capture cannot know but an edit can: one read, only when the text
  // moves (first review pass: an edit judged under the capture's bare
  // {source: "mcp"} let a row a type: or source: term names slip past).
  // A row that is not there is judged as bare and refused by the write.
  // Here a `source:` term DOES gate: the label is the row's, written by
  // the server at its capture, not a claim on this call — the opposite of
  // capture_thought, which keeps its caller-claimed `source` off the
  // subject so it cannot gate (SMD-1941).
  const cfg = ctx.embedConfig();
  const existing = content !== undefined ? await (await ctx.store()).getThought(id) : null;
  const subject: EgressSubject = { kind: "edit", actor: principal.name, metadata: existing?.metadata ?? { source: "mcp" }, content };
  const gate = content !== undefined ? decideCalls(subject, cfg, cfg.egress) : undefined;
  // An edit whose provider does not answer is still refused whole; the provider's state hears it either way (SMD-2890, review pass 1).
  const embedStarted = performance.now();
  const embedded = content !== undefined && gate?.embeddings.allowed
    ? await ctx.embedder.embedCapture(content, subject).then((v) => { heardFrom(ctx.providerHealth, embedStarted); return v; }, (e: unknown) => { heardFrom(ctx.providerHealth, embedStarted, e); throw e; })
    : undefined;

  const result = await (await ctx.store()).updateThought({
    id,
    content,
    metadataPatch: metadata_patch,
    embedding: embedded?.embedding,
    chunks: embedded?.chunks,
    ifUnchangedSince: if_unchanged_since,
    actor: { ...actorOf(ctx, principal), ...(gate?.record ? { egress: gate.record } : {}) },
    // Read by update_thought only with content, when the vector moves (021).
    embeddingModel: embedded?.model,
    // 061: the windows' recipe when the new text made windows; the patch
    // is the caller's, so no tag recipe (SMD-1731).
    lineage: captureLineage(cfg, embedded, undefined),
    // 032: only the key the caller named reaches the envelope — absent
    // must stay absent, since null means CLEAR at the function.
    provenance: supersedes !== undefined ? { supersedes } : undefined,
  });

  if (!result.ok) return refuse(storeRefusal(result, id));

  // SMD-2744 PR 2: the three stamp keys are the server's (050, 073) — the
  // key's that wrote the current text, and the trust that write declared —
  // so a patch naming one is merged in name only, and the reply said
  // "metadata merged" while the row kept its own (SMD-2664's review pass 5).
  // update_thought answers, from inside the write (088), the stamp it left,
  // whether the patch merged anything, and whether the text counts as the
  // same; the reply names each named key the row did not take. A database
  // before 088 answers none of these, and the reply says what it said; one
  // that answers a stamp and no boolean verdict is read as not merged — a
  // null was read as merged (review pass 6).
  const kept = keptStampKeys(result.stamp, metadata_patch);
  const merged = metadata_patch !== undefined && (result.metadataMerged ?? result.stamp === undefined);

  // Click-through relevance (034): the caller edited this id after a
  // search. Only on a written edit, not a refusal. SMD-1719: an edit that
  // sets `supersedes` also names a returned id as this thought's source —
  // the same act as a capture's pointer, and the path capture_thought's
  // re-capture note sends the caller down. The function accepted the
  // pointer (a ghost or a loop was refused above), so it is a cite of the
  // SUPERSEDED id; the edited id stays "opened". One batch, one round trip.
  await ctx.logActions(principal, [
    { tool: "update_thought", targetId: id },
    ...(typeof supersedes === "string" ? citeRows("update_thought", { supersedes }) : []),
  ]);

  return ok({
    id,
    ...(byClientKey ? { byClientKey } : {}),
    ...(result.updatedAt !== undefined ? { updatedAt: result.updatedAt } : {}),
    contentChange: content === undefined ? null : gate?.embeddings.allowed ? "reembedded" : "no_vector",
    metadataMerged: merged,
    // "It already held what the patch named" only where the text counts as
    // the same: on a change of text the stamp moved to the editor even when
    // it matches the patch (review pass 5).
    ...(metadata_patch !== undefined && !merged && !kept?.length && result.sameText !== false && !result.patchDropped ? { metadataEcho: true } : {}),
    ...(result.patchDropped ? { patchDropped: true } : {}),
    // The trust the patch sent, when it named one and the row did not take
    // it: the hint's reason on a change of text turns on it (review pass 5).
    ...(kept?.some((k) => k.key === "trust") && metadata_patch ? { trustSent: typeof metadata_patch.trust === "string" ? metadata_patch.trust : null } : {}),
    // A change of text writes actor_name onto any object metadata, so a
    // stamp without it is metadata that is not an object, and one without
    // actor_kind is a key with no kind (review pass 7: "your key has no
    // kind" was said of an array row's classified key).
    ...(result.sameText === false && kept?.some((k) => k.key === "trust" && !k.present) && result.stamp
      ? typeof result.stamp.actor_name !== "string" ? { stampGap: "not_object" as const }
        : typeof result.stamp.actor_kind !== "string" ? { stampGap: "no_kind" as const } : {}
      : {}),
    ...(kept?.length ? { kept } : {}),
    ...(result.sameText !== undefined ? { sameText: result.sameText } : {}),
    ...(supersedes !== undefined ? { supersedes } : {}),
    contextFailures: embedded?.contextFailures ?? 0,
    ...(result.duplicateOf ? { duplicateOf: result.duplicateOf } : {}),
    ...(result.fingerprintHeldBy ? { fingerprintHeldBy: result.fingerprintHeldBy } : {}),
    headWindow: headWindowOf(embedded),
    ...(gate && !gate.embeddings.allowed ? { noVectorReason: gate.embeddings.reason } : {}),
  });
}

/** What a delete did (042): the citations it detached (only when asked) and the expired or superseded ones it marked. */
export type Deleted = { id: string; byClientKey?: string; detached?: number; inactive?: number };

export async function deleteThought(ctx: Ctx, principal: Principal, { id: name, detach_citations }: Input<"delete_thought">): Promise<Outcome<Deleted>> {
  // A name that is no uuid names no thought (review pass 2); else the thought by id, else by client_key (SMD-3314).
  if (!UUID_RE.test(name)) return refuse({ code: "NOT_FOUND", retryable: false, id: name.slice(0, 80) });
  const { id, byClientKey } = await targetNamed(ctx, principal, name);
  const result = await (await ctx.store()).deleteThought({
    id,
    actor: actorOf(ctx, principal),
    // 042: the refusal is the default; the way through is named here.
    detach: detach_citations === true,
  });
  if (!result.ok) return refuse(storeRefusal(result, id));

  // Click-through relevance (034): the caller deleted this id after a
  // search — a strong signal it was the one they meant. Only on success.
  await ctx.logActions(principal, [{ tool: "delete_thought", targetId: id }]);

  return ok({
    id,
    ...(byClientKey ? { byClientKey } : {}),
    ...(result.detached ? { detached: result.detached } : {}),
    ...(result.inactive ? { inactive: result.inactive } : {}),
  });
}

/** What the operator's reset did (086, SMD-2744): whether anything had settled the label, whether a moved label was put back, the declines that no longer count, and the label the row is left with. */
export type StampReset = { id: string; reset: boolean; restored: boolean; movedBy: string | null; declines: number; declinedBy: string[]; stamp: ActorStamp; caller: string };
export type StampResetCode = "NOT_FOUND" | "REFUSED_NOT_OPERATOR" | "REFUSED_NOT_CAPTURE_STAMP";

export async function resetCaptureStamp(ctx: Ctx, principal: Principal, { id }: Input<"reset_capture_stamp">): Promise<Outcome<StampReset, StampResetCode>> {
  // A string that is no uuid names no thought; the function's cast would
  // raise it as a fault.
  if (!UUID_RE.test(id)) return refuse({ code: "NOT_FOUND", retryable: false, id });
  // Who may is the database's to say: the key's registry kind, which the
  // server does not hold — the function refuses any key not classified
  // operator, and names the caller in the event it appends.
  const result = await (await ctx.store()).resetCaptureStamp({ id, actor: actorOf(ctx, principal) });
  if (!result.ok) {
    switch (result.error) {
      case "NOT_FOUND": return refuse({ code: "NOT_FOUND", retryable: false, id });
      case "NOT_OPERATOR": return refuse({ code: "REFUSED_NOT_OPERATOR", retryable: false, key: principal.name, kind: result.kind ?? null });
      case "NOT_CAPTURE_STAMP": return refuse({ code: "REFUSED_NOT_CAPTURE_STAMP", retryable: false, id });
    }
  }
  // No action-log row: 034's log is click-through relevance, and a reset is
  // a ruling on a label, not a sign the caller found what it searched for.
  return ok({ id, reset: result.reset, restored: result.restored, movedBy: result.movedBy, declines: result.declines, declinedBy: result.declinedBy, stamp: result.stamp, caller: principal.name });
}

/**
 * A proposal's decision (SMD-3338): what it wrote or cleared, the pointers its
 * lapse cleared (082), and who the row records as deciding it (114) — null
 * where it records none, `reviewerRecorded` false on a brain short of 114.
 * `writersUnread`: an unforced accept on a brain short of 094, whose WRITER
 * check did not run.
 */
export type ProposalReview = {
  id: string; decision: "accept" | "reject"; status: "accepted" | "rejected"; forced: boolean;
  supersedingId: string | null; supersededId: string | null;
  /** An accept: whether it wrote the pointer (false: the pointer already held that value). */
  written: boolean | null;
  /** A reject: whether it cleared the pointer this proposal had written. */
  cleared: boolean | null;
  lapsed: { id: string; onto: string }[];
  reviewer: Reviewer | null; reviewerRecorded: boolean; writersUnread: boolean; caller: string;
};
export type ProposalReviewCode = "NOT_FOUND" | "REFUSED_EDITED_SINCE" | "REFUSED_LINEAGE_PAIR" | "REFUSED_WRITER" | "REFUSED_REVIEW_ARGUMENT" | "REFUSED_DIRECTION_REQUIRED"
  | "REFUSED_ALREADY_ACCEPTED" | "REFUSED_ALREADY_SUPERSEDES" | "REFUSED_PROPOSAL_WOULD_CYCLE" | "REFUSED_SUPERSEDED_GONE" | "REFUSED";

/**
 * Accept or reject a supersession proposal (SMD-3338): the CLI's
 * --accept/--reject over the contract, open to any write key, agents
 * included (the maintainer's call, 2026-10-26) — the row records who decided
 * (114). Its checks are the CLI's, each refused by name, and `force` waives
 * on an accept what --force waives: a text edited since judged (a stale row's
 * is one), a lineage pair, a WRITER flag.
 */
export async function reviewSupersessionProposal(ctx: Ctx, principal: Principal, { id, decision, direction, note, force }: Input<"review_supersession_proposal">): Promise<Outcome<ProposalReview, ProposalReviewCode>> {
  // The CLI's argument rules (reviewProblem): a reject takes neither a
  // direction nor force, and a note may not begin with the pass's marker —
  // rebuild_derived reads a rejection carrying it as the pass's own and sets
  // it stale again when a text moves (067).
  if (decision === "reject" && direction !== undefined) return refuse({ code: "REFUSED_REVIEW_ARGUMENT", retryable: false, problem: "direction_on_reject" });
  if (decision === "reject" && force === true) return refuse({ code: "REFUSED_REVIEW_ARGUMENT", retryable: false, problem: "force_on_reject" });
  if (note !== undefined && note.trimStart().startsWith(PASS_SETTLED_PREFIX)) return refuse({ code: "REFUSED_REVIEW_ARGUMENT", retryable: false, problem: "note_marker" });
  // A string that is no uuid names no proposal; the function's cast would raise it as a fault.
  if (!UUID_RE.test(id)) return refuse({ code: "NOT_FOUND", retryable: false, id });
  const r = await (await ctx.store()).reviewProposal({ id, decision, note, direction, force, actor: actorOf(ctx, principal) });
  if (!r.ok) {
    const w = r.writers && r.writers !== "no-094" ? r.writers : null;
    switch (r.error) {
      case "NOT_FOUND": return refuse({ code: "NOT_FOUND", retryable: false, id });
      case "EDITED_SINCE": return refuse({ code: "REFUSED_EDITED_SINCE", retryable: false, id, olderEdited: r.older_edited === true, newerEdited: r.newer_edited === true });
      case "LINEAGE_PAIR": return refuse({ code: "REFUSED_LINEAGE_PAIR", retryable: false, id, status: w?.status ?? null, flags: w?.flags ?? [] });
      case "WRITER": return refuse({ code: "REFUSED_WRITER", retryable: false, id, status: w?.status ?? "pending", flags: r.flags ?? [], edited: w?.edited === true,
        lapses: { older: w?.sides.older.lapses.length ?? 0, newer: w?.sides.newer.lapses.length ?? 0 } });
      case "DIRECTION_REQUIRED": return refuse({ code: "REFUSED_DIRECTION_REQUIRED", retryable: false, id, verdict: String(r.verdict) });
      case "ALREADY_ACCEPTED": return refuse({ code: "REFUSED_ALREADY_ACCEPTED", retryable: false, id, supersedingId: String(r.superseding_id) });
      case "ALREADY_SUPERSEDES": return refuse({ code: "REFUSED_ALREADY_SUPERSEDES", retryable: false, id, supersedingId: String(r.superseding_id), currentId: String(r.current) });
      // 032: update_thought's answers, passed on by 029 with the pair added.
      case "WOULD_CYCLE": return refuse({ code: "REFUSED_PROPOSAL_WOULD_CYCLE", retryable: false, id, supersedingId: String(r.superseding_id), supersededId: String(r.superseded_id) });
      case "SUPERSEDES_NOT_FOUND": return refuse({ code: "REFUSED_SUPERSEDED_GONE", retryable: false, id, supersededId: String(r.superseded_id) });
      default: return refuse({ code: "REFUSED", retryable: false, error: String(r.error) });
    }
  }
  return ok({
    id, decision, status: decision === "accept" ? "accepted" : "rejected", forced: force === true,
    supersedingId: r.superseding_id ?? null, supersededId: r.superseded_id ?? null,
    written: decision === "accept" ? r.written === true : null,
    cleared: decision === "reject" ? r.cleared === true : null,
    lapsed: r.lapsed ?? [],
    reviewer: r.reviewer === "no-114" ? null : r.reviewer ?? null, reviewerRecorded: r.reviewer !== "no-114",
    writersUnread: r.writers === "no-094", caller: principal.name,
  });
}
