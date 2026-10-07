// The write operations (SMD-2283 PR 2): what capture_thought, update_thought
// and delete_thought did inside their MCP closures, as functions of a principal
// and a typed input. Each returns the typed value — the facts its reply is
// built from — or a typed refusal (core/refusal.ts), and throws a fault; the
// MCP registration renders it in the words it always has (render.ts), and the
// REST core (SMD-2284) answers it as JSON.

import type { EmbeddedCapture } from "../embed.ts";
import { extractMetadata, metadataRefused, TAG_KEYS } from "../metadata.ts";
import { captureLineage } from "../lineage.ts";
import { classifyGenre } from "../genre.ts";
import { resolveJevConfig } from "../jev.ts";
import { decideCalls, type EgressSubject } from "../egress.ts";
import { UUID_RE, type Citation, type ThoughtStore } from "../store.ts";
import { canRead, type Principal } from "../auth.ts";
import { citeRows, type Ctx } from "./context.ts";
import { META_KEYS_MAX, META_VALUE_MAX, ok, refuse, type MetadataProblem, type Outcome, type Refusal } from "./refusal.ts";
import type { Input } from "./schemas.ts";

// A caller-set metadata key (SMD-2014): lower-case, starts with a letter, 2-40
// characters — the shape a reader can filter on. The server owns some keys of
// `metadata`, and a caller naming one is refused rather than silently overruled
// by the merge below: `source` (the origin label, set from the `source` arg),
// the extractor's tag set (TAG_KEYS: type, topics, people…), the actor columns
// migration 050 stamps from the key and the trust migration 073 stamps beside
// them (SMD-1724), the embedding model migration 021 records,
// and the extractor's own failure marker. Everything else — `summary_model`,
// which the session hook sets when a local model wrote the summary — is the
// caller's to add.
const META_KEY_RE = /^[a-z][a-z0-9_]{1,39}$/;
const RESERVED_META = new Set<string>([...TAG_KEYS, "source", "actor_kind", "actor_name", "trust", "embedding_model", "metadata_extraction_failed"]);

/** The refusal for a bad `metadata` argument, or null when it is clean (or absent). Checked before the model calls, as the other shape refusals are. */
function metadataProblem(metadata: Record<string, unknown> | undefined): Refusal | null {
  if (metadata === undefined) return null;
  const at = (problem: MetadataProblem, rest: { key?: string; count?: number; length?: number } = {}): Refusal => ({ code: "REFUSED_METADATA_SHAPE", retryable: false, problem, ...rest });
  const keys = Object.keys(metadata);
  if (keys.length > META_KEYS_MAX) return at("too_many_keys", { count: keys.length });
  for (const k of keys) {
    if (!META_KEY_RE.test(k)) return at("bad_key", { key: k });
    if (RESERVED_META.has(k)) return at("reserved_key", { key: k });
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
};

export async function capture(ctx: Ctx, principal: Principal, { content, derived_from, supersedes, source, trust, metadata: clientMetadata }: Input<"capture_thought">): Promise<Outcome<Captured>> {
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
    const badMetadata = metadataProblem(clientMetadata);
    if (badMetadata) return refuse(badMetadata);
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
    // capture audit row (008/010) carrying this key's agent id, and the
    // thought still standing. A pointer that is not provably so is dropped
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
      try {
        // Both reads for every target, so no cell is a query shorter.
        const store = await ctx.store();
        [writer, present] = await Promise.all([store.captureActorOf(supersedes), liveIn(store, [supersedes]).then((live) => live(supersedes))]);
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
        // Bun's SQL puts the SQLSTATE, as agents.ts reads it; `code` for a
        // PostgREST error); a dropped connection or a timeout gets the store's
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
      const own = present && writer !== null && writer.agentId !== null && writer.agentId === principal.agentId;
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
    const [embedded, metadata, genre] = await Promise.all([
      gate.embeddings.allowed ? ctx.embedder.embedCapture(content, subject) : Promise.resolve(undefined),
      gate.chat.allowed ? extractMetadata(content, subject, cfg) : Promise.resolve(metadataRefused()),
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
    const payload = { metadata: { ...clientMetadata, ...metadata, source: origin, genre: genre.genre } };

    // Atomicity is the store's problem now: the SQL path writes content,
    // metadata and vector in one statement, while the PostgREST path keeps the
    // 3-arg RPC with its two-step fallback. Either way a row committed without
    // its embedding is reported, never silently accepted.
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
      payload,
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
      },
      // NULL when the gate refused the embedding call: the row lands with
      // its text and fingerprint and no vector, as the reply says.
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
    for (;;) {
      try {
        captured = await store.captureThought({ ...captureArgs, supersedes: pointer, derivedFrom });
        break;
      } catch (e) {
        if (reader) throw e;
        const msg = String((e as Error)?.message ?? e);
        if (pointer !== undefined && /thoughts_supersedes_fkey/.test(msg)) pointer = undefined;
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
    // "fresh" on the one schema where the pointer's fate is unknown). The
    // vector attaching or not does not change what was written.
    if (captured.existed === false) {
      await ctx.logActions(principal, citeRows("capture_thought", { derived_from: derivedFrom, supersedes: pointer }));
    }

    if (captured.embeddingFailed) return refuse({ code: "EMBEDDING_NOT_ATTACHED", retryable: true, id: captured.id, detail: captured.embeddingFailed });

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

/** What an edit did, as its reply states it. */
export type Updated = {
  id: string;
  updatedAt?: string;
  /** The text: moved and re-embedded, moved without a vector (the gate refused the call), or left alone. */
  contentChange: "reembedded" | "no_vector" | null;
  metadataMerged: boolean;
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

export async function updateThought(ctx: Ctx, principal: Principal, { id, content, metadata_patch, if_unchanged_since, supersedes }: Input<"update_thought">): Promise<Outcome<Updated>> {
  if (content === undefined && metadata_patch === undefined && supersedes === undefined) return refuse({ code: "REFUSED_NOTHING_TO_UPDATE", retryable: false });
  // The shape here, as the two named refusals are; the function would raise on
  // it, and a raised message reads as a failure rather than a refusal. The
  // string "null" is not a clear — clearing is JSON null, and a client that
  // sends the word meant an id.
  if (typeof supersedes === "string" && !UUID_RE.test(supersedes)) return refuse({ code: "REFUSED_SUPERSEDES_SHAPE", retryable: false, value: supersedes, orNull: true });

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
  const embedded = content !== undefined && gate?.embeddings.allowed ? await ctx.embedder.embedCapture(content, subject) : undefined;

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
    ...(result.updatedAt !== undefined ? { updatedAt: result.updatedAt } : {}),
    contentChange: content === undefined ? null : gate?.embeddings.allowed ? "reembedded" : "no_vector",
    metadataMerged: metadata_patch !== undefined,
    ...(supersedes !== undefined ? { supersedes } : {}),
    contextFailures: embedded?.contextFailures ?? 0,
    ...(result.duplicateOf ? { duplicateOf: result.duplicateOf } : {}),
    ...(result.fingerprintHeldBy ? { fingerprintHeldBy: result.fingerprintHeldBy } : {}),
    headWindow: headWindowOf(embedded),
    ...(gate && !gate.embeddings.allowed ? { noVectorReason: gate.embeddings.reason } : {}),
  });
}

/** What a delete did (042): the citations it detached (only when asked) and the expired or superseded ones it marked. */
export type Deleted = { id: string; detached?: number; inactive?: number };

export async function deleteThought(ctx: Ctx, principal: Principal, { id, detach_citations }: Input<"delete_thought">): Promise<Outcome<Deleted>> {
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
    ...(result.detached ? { detached: result.detached } : {}),
    ...(result.inactive ? { inactive: result.inactive } : {}),
  });
}
