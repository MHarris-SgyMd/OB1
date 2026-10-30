// The MCP layer's words (SMD-2283): each tool's reply rendered from the typed
// answer core/ returns — the same text the tools have always said, with the
// answer beside it as `structuredContent`. Nothing here reads the store, calls a
// model or decides a rule; a sentence that needs a fact gets it from the value
// or the refusal it is handed.
//
// Claude Code, VS Code and Codex hand the model `structuredContent` alone when a
// result carries it (claude-code issue 55677, vscode issue 290063, codex issue
// 10334). So a tool whose text is prose answers `{ ...fields, text }`: its text,
// which every word a thought, a key or a judge wrote reaches the model through,
// cleaned and bounded by the renderer as it always was; and beside it only
// fields that cannot carry such words — ids, timestamps, counts, scores,
// booleans, enum codes (review pass 5: passes 2–5 each found another field the
// value showed more of, or less cleanly, than the text). A refusal or a fault
// answers the same way. A tool whose text is its value's JSON (the ChatGPT
// shapes, the pages, the job records, the worker actions) answers the value
// itself, which says exactly what its text does. The core's values keep
// everything, for the REST core (SMD-2284).

import { displayDate } from "./thoughts.ts";
import { movedWords, typesOf, type Moved } from "./stated-status.ts";
import { cutByCodePoint, LINE_BREAK, oneLine, PASS_SETTLED_PREFIX, REASON_MAX, UNSHOWN } from "./consolidate.ts";
import type { ActorStamp, AuditChange, DryRunClaimResult, LoggedSearchPage, ProposalSide, ProposalWriter, ReleaseLeasesResult, RetryFailedResult, ThoughtHybridMatch, ThoughtIdPage, ThoughtStats } from "./store.ts";
import { TEXT_PAGE } from "./store.ts";
import type { JobHandle, PublicJob } from "./jobs.ts";
import { renderBrainInfo, type BrainInfo } from "./brain-info.ts";
import { INGESTED_NOTICE, ingestedNotice, SAID_BY, TRUST } from "./core/filter.ts";
import { parseListCursor, parseProposalCursor } from "./core/list-cursor.ts";
import { judgeKeyText, PASS_KEY_CHARS } from "./pass-key.ts";
import { failure, META_KEYS_MAX, META_VALUE_MAX, TICKET_META_KEYS_TEXT, ok, refusalValue, type Outcome, type Refusal, type RefusalCode } from "./core/refusal.ts";
import type { ReleaseLeasesCode, RetryFailedCode, RunWorkerCode } from "./core/workers.ts";
import type { ChangesResult, FetchedThought, KeywordResult, ListThoughtsResult, ProposalsResult, QueryVectorFailed, SearchResult, SearchThoughtsResult, WorkerStatusResult } from "./core/reads.ts";
import type { Captured, Deleted, HeadWindow, KeptKey, ProposalReview, ProposalReviewCode, StampReset, StampResetCode, Updated } from "./core/writes.ts";
import type { Reviewer } from "./proposal-review.ts";
import type { PluginOutcome } from "./plugin-sdk.ts";

/** A tool's reply: the text a model reads and the typed answer a program reads (SMD-1978's `structuredContent`, now every tool's). */
export type Reply = { content: { type: "text"; text: string }[]; isError?: true; structuredContent: Record<string, unknown> };

/** A prose tool's safe fields, picked from its value — ids, timestamps, numbers, booleans, enum codes; `guard` holds every string to that. */
type Safe<T> = (v: T) => object;
/** A tool whose text is its value's JSON: the value itself (the spec's structured-plus-serialized shape). */
const AS_JSON = Symbol("the value is the text's JSON");
/** brain_info: its whole record beside the table — the server's and the database's own facts, versions included, so not held to tokens. Its one value from thoughts' metadata, the board-sync watermark, is held to a UTC instant by its read (brain-info.ts's BOARD_SYNC_SQL and boardSyncValue), and the workers' heartbeats, from ob1_config rows a worker role writes, to counts, enums, bounded tokens and the sleep scheduler's held thought ids, each held to a uuid (parseHeartbeats, parseHeld). */
const AS_RECORD = Symbol("the value is the server's own record");

/** An outcome in the tool's words — its value's text, or its refusal's — with the text inside the value, last, so no field can stand in for it. */
function render<T extends object>(o: Outcome<T>, value: (v: T) => string, refusal: (r: Refusal) => string, safe: Safe<T> | typeof AS_JSON | typeof AS_RECORD): Reply {
  if (!o.ok) {
    const text = refusal(o.refusal);
    return { content: [{ type: "text", text }], isError: true, structuredContent: { ...(guard(refusalValue(o.refusal)) as object), text } };
  }
  const text = value(o.value);
  const v = o.value as Record<string, unknown>;
  return { content: [{ type: "text", text }], structuredContent: safe === AS_JSON ? { ...v } : safe === AS_RECORD ? { ...v, text } : { ...(guard(safe(o.value)) as object), text } };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** store.ts's isoTimestamp forms: toISOString (an extended year included) and Postgres's infinities. */
const TIME = /^(?:[+-]?\d{4,6}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}(?::?\d{2})?)?)?|-?infinity)$/;
/** An enum word or code: one token, no space, no punctuation a sentence needs. */
const TOKEN = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/;
/** A field named for a time holds a time; one named for a thought or a row holds a uuid; any other string an enum token. */
const TIME_KEY = /(?:At|_at)$|^(?:since|oldest|newest)$/;
const ID_KEY = /^(?:id|after|cursor|supersedes|supersededBy|supersedesBefore|supersedesAfter|duplicateOf|fingerprintHeldBy|onto|heldKey|byClientKey)$|Id$/;

/**
 * The rule at the chokepoint (review pass 6): every string a picker hands over
 * is held to the shape its field's name promises — a time, a uuid, or one enum
 * token — and any other string becomes null. A picker that lists a field whose
 * type says timestamp but whose source is a thought's metadata (prefer_current's
 * `window.syncedAt`, `max(metadata->>'linear_updated_at')` over the corpus)
 * cannot carry a sentence through: the guard reads the value, not the type.
 */
function guard(v: unknown, key = ""): unknown {
  // list_thoughts' cursor (SMD-2995): not a uuid, but held to its own shape, which carries no sentence.
  // list_supersession_proposals' (SMD-3249) likewise: a tag, its selection's tokens and pass key, a confidence, a
  // timestamp's text and a uuid.
  if (typeof v === "string" && key === "cursor" && v === v.trim() && (parseListCursor(v) || parseProposalCursor(v))) return v;
  // A proposal's pass (SMD-3248): held to pass-key.ts's one rule — one token, no space, so no sentence — the rule the
  // input took it by (review pass 4: a full-shape guard nulled keys the input admitted).
  if (typeof v === "string" && key === "judgeKey") return PASS_KEY_CHARS.test(v) ? v : null;
  if (typeof v === "string") return (TIME_KEY.test(key) ? TIME : ID_KEY.test(key) ? UUID : TOKEN).test(v) ? v : null;
  if (Array.isArray(v)) return v.map((x) => guard(x, key));
  if (v !== null && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, guard(x, k)]));
  return v;
}

/** A refusal a tool's renderer has no sentence for — a code it does not return. Not reached; said rather than thrown. */
const unknownRefusal = (r: Refusal) => `Refused: ${r.code}`;

/**
 * A fault an operation threw — the store down, a missing migration — said as
 * the tool has always said it: `lead` (`Error: `, or update/delete's
 * `<tool> failed: `), the message, and the tool's hint for it when it has one.
 * Beside it the verdict: the fault's own (`failure()`: FAILED, unclassified,
 * no `retryable` until SMD-2461), or one a tool states for itself — capture's
 * STORE_UNAVAILABLE, retryable (SMD-1978). The message and hint ride the text
 * alone. A thrown non-Error (a string, undefined, an object that cannot be
 * printed) is said as itself where it can be, and never throws here.
 */
export function failed(err: unknown, { hint, lead = "Error: ", verdict }: { hint?: (msg: string) => string; lead?: string; verdict?: { code: "STORE_UNAVAILABLE"; retryable: true } } = {}): Reply {
  const { message, ...own } = failure(err);
  const text = `${lead}${message}${hint ? hint(message) : ""}`;
  return { content: [{ type: "text", text }], isError: true, structuredContent: { ...(verdict ?? own), text } };
}

/**
 * A plugin operation's reply (SMD-2310): a tool whose text is its value's JSON,
 * the value itself beside it — the structured content its output schema
 * describes, which the SDK holds it to. A refusal is its code and facts, as
 * the REST core answers them, with its message in the text.
 */
export function renderPlugin(o: PluginOutcome<Record<string, unknown>>): Reply {
  if (!o.ok) {
    const { status: _status, ...facts } = o.refusal;
    const text = `Refused: ${o.refusal.code}${o.refusal.message ? ` — ${o.refusal.message}` : ""}`;
    return { content: [{ type: "text", text }], isError: true, structuredContent: { ...facts, text } };
  }
  return { content: [{ type: "text", text: JSON.stringify(o.value) }], structuredContent: { ...o.value } };
}

/**
 * capture_thought's fault: the store did not answer as itself — down, a
 * missing function, a front returning 401 — a transient the caller keeps and
 * retries (SMD-1978). The session hook keys on this code; it stays retryable
 * until SMD-2461's one classifier reads every fault. The words are failed()'s.
 */
export const storeUnavailable = (err: unknown): Reply => failed(err, { verdict: { code: "STORE_UNAVAILABLE", retryable: true } });

/** An enum the store reads from a constrained column, kept only when it is one of the words it may be. */
const oneOf = <W extends string>(words: readonly W[], v: unknown): W | null => (words as readonly unknown[]).includes(v) ? v as W : null;
/**
 * The reasons prefer_current demotes a row (059): the function's own words,
 * one token each as guard() holds a structured string. 077's reason carries
 * the deciding keys, `references settled work (SMD-1, SMD-2)`; the structured
 * field says `references_settled` and leaves the words and keys to the text.
 */
const DEMOTIONS = ["completed", "canceled", "duplicate", "superseded", "references_settled"] as const;
const demotionOf = (d: unknown) => oneOf(DEMOTIONS, typeof d === "string" && /^references settled work \(/.test(d) ? "references_settled" : d);

/** A row's trust (073, SMD-1724): one of the ladder's words, else null — no trust recorded, or a word the stamp never writes. */
const trustOf = (m: Record<string, unknown> | null | undefined): (typeof TRUST)[number] | null => oneOf(TRUST, m?.trust);

/**
 * A hit's moved tickets as a typed field, and the words' input: the key and
 * the status type then and now — each one token (095 reads only known
 * lifecycle types); none when not checked, or from a REST core older than the
 * MCP server rendering its answer.
 */
const movedField = (moved: readonly Moved[] | null | undefined) => typesOf(moved ?? []);

/** search_thoughts: per hit its id, date, scores, the newer thought that supersedes it, why it was demoted, its trust and its moved tickets; the window prefer_current read. */
const safeSearch: Safe<SearchThoughtsResult> = (v) => ({
  preferCurrent: v.preferCurrent,
  // The marker word alone, as a capture's (SMD-2891): the words are in the text.
  ...(v.vectorFailed ? { vectorFailed: v.vectorFailed.reason } : {}),
  // Unknown, not false, when the brain had no row to report the query's facts on (review pass 6).
  literalOnly: v.facts?.literalOnly ?? null,
  window: v.window,
  hits: v.hits.map((h) => ({
    id: h.id, created_at: h.created_at, similarity: h.similarity, score: h.score, fused: h.fused,
    supersededBy: h.supersededBy, demoted: h.demoted.map(demotionOf).filter((d) => d !== null),
    // null when the hit's tickets were not checked — and from a REST core older than this MCP server.
    trust: trustOf(h.metadata), moved: Array.isArray(h.moved) ? movedField(h.moved) : null, movedNotRead: h.movedNotRead ?? 0,
  })),
});
/** search_thoughts_keyword: the page's place in the whole match set, and per hit its id, date, occurrence count and trust. */
const safeKeyword: Safe<KeywordResult> = (v) => ({
  offset: v.offset, total: v.total,
  hits: v.hits.map((h) => ({ id: h.id, created_at: h.created_at, occurrences: h.occurrences, trust: trustOf(h.metadata) })),
});
/** list_thoughts: per thought its id, date, the newer thought that supersedes it, and its trust; the page's sort and the next page's cursor (SMD-2995). */
const safeList: Safe<ListThoughtsResult> = (v) => ({
  thoughts: v.thoughts.map((t) => ({ id: t.id, created_at: t.created_at, supersededBy: t.supersededBy, trust: trustOf(t.metadata) })),
  sort: v.sort,
  cursor: v.cursor,
});
/**
 * list_supersession_proposals: per proposal its ids, verdict, numbers, dates and the pass that judged it — the sides and the
 * reason are in the text. The top-level `judgeKey` is the selection: absent when every pass was listed, the key when one
 * was — always one the guard keeps, since the input took it by the same rule (pass-key.ts's PASS_KEY_CHARS).
 */
const safeProposals: Safe<ProposalsResult> = (v) => ({
  status: v.status, ...(v.lineage === undefined ? {} : { lineage: v.lineage }), ...(v.judgeKey === undefined ? {} : { judgeKey: v.judgeKey }),
  // SMD-3249: the next page's `after` (null once no more follow), how many follow this page, and whether it followed a cursor.
  cursor: v.cursor, remaining: v.remaining, pastCursor: v.pastCursor,
  proposals: v.proposals.map((p) => ({
    id: p.id, status: p.status, verdict: p.verdict, confidence: p.confidence, similarity: p.similarity,
    // SMD-3248: the judge key names a pass and its models — no writer, so SMD-2707's rule (writers' names in the text) does not hold it back.
    judgeKey: p.judgeKey,
    judgedAt: p.judgedAt, reviewedAt: p.reviewedAt, supersedingId: p.supersedingId, lineage: p.lineage,
    older: safeSide(p.older), newer: safeSide(p.newer),
    // SMD-2707: the flags are words and booleans; the writers' names are in the text.
    sameCapturer: p.sameCapturer, writerFlags: standingFlags(p),
  })),
});
/** One side of a proposal in the value: its id, date and edit, and (094) its trust, whose text it is and what supersedes it. */
const safeSide = (s: ProposalSide) => ({
  id: s.id, created_at: s.created_at, edited: s.edited,
  ...(s.writer ? { trust: oneOf(TRUST, s.writer.trust), captureOnly: s.writer.captureOnly } : {}),
  supersededBy: s.supersededBy ?? null, lapses: s.lapses ?? [],
  ...(s.walkCapped ? { walkCapped: true } : {}),
});
/** thought_stats: the totals and the date range — the breakdowns' keys are extracted words, in the text's top ten. */
const safeStats: Safe<ThoughtStats> = (v) => ({ total: v.total, aggregated: v.aggregated, oldest: v.oldest, newest: v.newest });
/** thought_changes: the page's bounds and cursor, and per change what happened to which thought, when — the head, writer and door are in the text. */
const safeChanges: Safe<ChangesResult> = (v) => ({
  more: v.more, bounded: v.bounded, since: v.since, after: v.after, actions: v.actions, cursor: v.cursor,
  changes: v.changes.map((c) => ({
    id: c.id, createdAt: c.createdAt, action: c.action, thoughtId: c.thoughtId, present: c.present,
    actorKind: oneOf(SAID_BY, c.actorKind), supersedesBefore: c.supersedesBefore, supersedesAfter: c.supersedesAfter, derivation: c.derivation,
  })),
});

/**
 * Untrusted text — a thought's, a citation's, a judge's reason — on one line
 * of a reply: the same cleaner the CLI renders through
 * (server-portable/consolidate.ts), whitespace collapsed, cut with an ellipsis
 * past `max` characters. One spelling for every place a reply quotes a thought.
 * Every break fenceText splits on is a space here, NEL and FS/GS/RS among them
 * (`\s` matches none of the four), and what fenceText drops from a line is
 * dropped (SMD-2510).
 */
export function snipText(text: string, max: number): string {
  // oneLine and cutByCodePoint live beside cleanForDisplay, where
  // parseJudgement cleans the reason it stores by the same rule (SMD-2536).
  const t = oneLine(text);
  const cut = cutByCodePoint(t, max);
  return cut === t ? t : cut + "…";
}

/** Where a metadata value is cut (SMD-2510): a type is a word, a topic or a person a name, an action item a sentence. */
const TYPE_MAX = 40;
const TAG_MAX = 80;
const ACTION_MAX = 200;
/** Where a proposal's judge reason and review note are cut (SMD-2533): parseJudgement's REASON_MAX, 400. consolidate.ts --list cuts at it too. */
export const PROPOSAL_TEXT_MAX = REASON_MAX;

/**
 * A thought's metadata value — its type, a topic, a person, an action item —
 * on one line of a reply (SMD-2510). The value is anyone's to set: an
 * importer writes it straight through upsert_thought's payload, and
 * extraction is a model reading the thought's own text. Printed raw, a topic
 * holding a newline, `--- Result 9 ---` and `By: … · trust operator` stood
 * above the fenced text (SMD-2483) as lines of the reply's own. A value that
 * is not a string is said as String() says it (a `0` or `false` type as such,
 * where the template's `||` said `unknown`). Exported for the unit test.
 */
export function metaText(v: unknown, max: number): string {
  return v === null || v === undefined ? "" : snipText(typeof v === "string" ? v : String(v), max);
}

/** A metadata list (topics, people, action items), each entry through metaText, one left empty dropped. Exported for the unit test. */
export function metaList(v: unknown, max: number): string[] {
  return Array.isArray(v) ? v.map((x) => metaText(x, max)).filter(Boolean) : [];
}

/**
 * A thought's whole text in a block of a reply (SMD-2483): every line starts
 * with `│` (`│ ` and the line; an empty one `│` alone), and no line the
 * renderer writes itself does — so no line of the text can stand as a
 * `--- Result` header, an `ID:` or a `By:` line, or the next list item,
 * whatever its trust. Every row, not only an ingested one (the maintainer's
 * call): an agent's summary quoting a page, or a row with no trust recorded,
 * could forge `trust operator` too. Unlike snipText the text keeps its lines
 * and is not cut; each break is said as LF, and the controls and marks that
 * would hide the fence are dropped (cleanForDisplay's rule, wider, applied
 * after the split so a VT or FF still breaks). `indent` is what each line
 * takes before the fence (list_thoughts' three spaces). Exported for the
 * unit test.
 */
export function fenceText(text: string, indent = ""): string {
  return text.split(LINE_BREAK).map((l) => l.replace(UNSHOWN, "")).map((l) => (l === "" ? `${indent}│` : `${indent}│ ${l}`)).join("\n");
}

/**
 * A search the egress gate refused (SMD-1903): the query text would leave for
 * its embedding, and the policy says it may not. The caller's way through is
 * the keyword tool, which makes no model call; the operator's are named.
 */
function refuseQuery(r: Extract<Refusal, { code: "REFUSED_EGRESS" }>): string {
  // The remedy follows the rule that refused (first review pass): under
  // `allow` a deny term matched, and adding an allow term would change
  // nothing; a second opinion is the operator's hook to read.
  const remedy = r.rule === "deny-term"
    ? "or removes the OB1_EGRESS_DENY term the reason names"
    : r.rule === "second-opinion"
      ? "or reads what the second opinion refused"
      : `or allows this key (OB1_EGRESS_ALLOW=actor:${r.actor})`;
  return (
    `Refused: the query text would be sent for its embedding, and ${r.reason}. ` +
    `Use search_thoughts_keyword (exact text, no model call). To allow semantic search here, the operator declares the endpoint local ` +
    `(OB1_LLM_LOCAL=1) when it is, ${remedy}.`
  );
}

/** The refusals the search tools share: the gate's, and a filter's (said as the fault it was, `Error:`). */
function searchRefusal(r: Refusal, hint?: (msg: string) => string): string {
  if (r.code === "REFUSED_EGRESS") return refuseQuery(r);
  if (r.code === "EMBEDDING_PROVIDER_UNAVAILABLE") return providerUnavailable(r);
  if (r.code === "REFUSED_FILTER") return `Error: ${r.message}${hint ? hint(r.message) : ""}`;
  return unknownRefusal(r);
}

/**
 * The `By:` line under a hit — who wrote its current text, from the two keys
 * migration 050 stamps, and what the text is, from the trust 073 stamps beside
 * them (SMD-1724). Absent when the row carries none of the three (a write from
 * outside the server, or a brain whose backfill has not run), as `Captured:`
 * is absent for an undated row. A name with no kind is a key nobody has
 * classified yet (set_agent_kind), and a row with no trust one whose writer
 * supported none (046's rule: an unclassified key's), each said so rather
 * than guessed. The name is the key's — the server's word, not the thought's —
 * and is rendered through the same cleaner every quoted text takes all the
 * same. Exported for the unit test.
 */
export function actorLine(m: Record<string, unknown>): string | null {
  const name = typeof m.actor_name === "string" && m.actor_name.trim() ? snipText(m.actor_name, 80) : null;
  const kind = oneOf(SAID_BY, m.actor_kind);
  const trust = trustOf(m);
  if (!name && !kind && !trust) return null;
  return `By: ${name ?? "an unnamed key"} (${kind ?? "kind not classified"}) · trust ${trust ?? "not recorded"}`;
}

// The notice an ingested row carries (SMD-1724) lives in core/filter.ts beside
// the trust words, where the operator GUI reads it too (SMD-2280).
export { INGESTED_NOTICE, ingestedNotice };

// 074's rank and SMD-2707's WRITER rule live in standing.ts, which the
// decision's guard (proposal-review.ts) reads without this file's imports.
export { standingFlags, trustRank, type StandingFlag } from "./standing.ts";
import { standingFlags, trustRank, type StandingFlag } from "./standing.ts";

/** A WRITER flag in words, on one line: the side as it stood, would stand, or might. */
export function standingFlagText(f: StandingFlag): string {
  const why = [f.captureOnly && (f.sameKey ? "its text is a capture-only key's — the other side's key too, but the accept would take this side from it" : "its text is a capture-only key's"), f.lowerTrust && "its trust is below the other side's"].filter(Boolean).join(" and ");
  const side = f.stands.toUpperCase();
  return f.how === "stood" ? `the ${side} side stands: ${why}` : f.how === "would" ? `an accept would make the ${side} side stand: ${why}` : `with --direction ${f.stands}, an accept would make the ${side} side stand: ${why}`;
}

/**
 * The WRITER line's flags in words, each with the pointers its accept would
 * also clear — a second write the reviewer should not miss past --force
 * (review pass 4). One wording for the reply and --list.
 */
export function writerFlagsText(flags: StandingFlag[], p: { older: { lapses?: unknown[] }; newer: { lapses?: unknown[] } }): string {
  return flags.map((f) => {
    const n = p[f.stands].lapses?.length ?? 0;
    return standingFlagText(f) + (n ? `, and it clears ${n === 1 ? "a capture-only pointer" : `${n} capture-only pointers`} (listed under the ${f.stands.toUpperCase()} side)` : "");
  }).join("; ");
}

/** What a reviewer reads after a pending row's WRITER flags: the accept they need. One wording for the reply and --list. */
export function writerFlagAdvice(flags: StandingFlag[]): string {
  const open = flags.filter((f) => f.how === "if").length;
  return ` — read both writers before accepting; ${open > 1 ? "each direction's accept takes" : open ? "that direction's accept takes" : "the accept takes"} --force`;
}

/**
 * A proposal side's writer (SMD-2707): the read tools' `By:` line (actorLine)
 * and, when its text is a capture-only key's alone, that said beside it.
 */
export function proposalWriterLine(w: ProposalWriter): string {
  const by = actorLine({ actor_name: w.name, actor_kind: w.kind, trust: w.trust }) ?? "By: not recorded";
  return w.captureOnly ? `${by} · a capture-only key's text` : by;
}

/** What supersedes a proposal side (SMD-2707): the first thought, by capture time. */
export function supersededLine(id: string): string {
  return `superseded by ${id}`;
}

/**
 * What an accept making a side stand would lapse (SMD-2707, ob1_accept_lapses):
 * the accept takes the side (092), and 082's lapse clears its capturer's
 * capture-only pointers onto it and up the chain — each pair the pointer's
 * thought and the thought it pointed at, which that one no longer supersedes
 * (review pass 2: "this side reads current again" was false for a pointer
 * onto a row above it, and for a side another thought still supersedes).
 */
export function lapsesLine(lapses: { id: string; onto: string }[], side: string): string {
  const pairs = lapses.map((l) => `${l.id} onto ${l.onto === side ? "this side" : l.onto}`).join(", ");
  return lapses.length === 1
    ? `an accept that makes this side stand clears a capture-only pointer, ${pairs}: it then no longer supersedes what it pointed at`
    : `an accept that makes this side stand clears ${lapses.length} capture-only pointers, ${pairs}: each then no longer supersedes what it pointed at`;
}

/** The rows each way past which the listing leaves a side's takes and lapses unread (107, SMD-3036: ob1_listing_walk_fits). */
export const WALK_CAP = 25;

/**
 * A side the listing left unread (107, SMD-3036): its walks — the chain below
 * the other side, the rows above this one — pass the cap, so what an accept
 * would take and lapse is not shown; the accept guard reads it in full.
 */
export function walkCappedLine(): string {
  return `what an accept that makes this side stand would take and lapse was not read: a chain here passes ${WALK_CAP} rows (the listing's cap, migration 107); an accept (consolidate.ts --accept, review_supersession_proposal) reads it in full`;
}

/** The side an accepted proposal's superseding_id names, in capitals, or null (SMD-2707: an accept may go against the verdict with --direction). */
export function stoodSide(p: { status: string; supersedingId: string | null; older: { id: string }; newer: { id: string } }): string | null {
  return p.status !== "accepted" || !p.supersedingId ? null : p.supersedingId === p.newer.id ? "NEWER" : p.supersedingId === p.older.id ? "OLDER" : null;
}

/** The line a listing from before 094 carries once: it returns no writer to show. */
export const WRITERS_UNREAD = "Writers not shown: this brain's listing is from before migration 094 (db/migrations/094_listing_names_the_writers.sql).";

/**
 * The line under a hit prefer_current demoted (059, SMD-2255): the weight it
 * took and why. The weight is read off the row — score over fused, exact since
 * 0.25 is a power of two — so this file holds no copy of it. Null for a row
 * nothing demoted, which is every row without the flag. Exported for the unit
 * test.
 */
export function demotedLine(t: Pick<ThoughtHybridMatch, "demoted" | "score" | "fused">): string | null {
  if (t.demoted.length === 0) return null;
  const weight = t.fused > 0 ? `×${Number((t.score / t.fused).toFixed(4))}` : "below current thoughts";
  return `↓ Ranked ${weight} — ${t.demoted.join(", ")}`;
}

/**
 * The header note under prefer_current: what the window held — how many rows
 * were demoted, how many carry a lifecycle and the latest sync among them —
 * and, when the window held fewer current rows than asked for and may not be
 * the whole list, that the rows after them are demoted ones and a current
 * match past the window may have been missed. The window is min(100, 4 ×
 * limit), so a larger limit reads more only below 100 rows (first review
 * pass: the note told a caller at 100 to raise it). Null without the flag (no
 * window on the rows). Exported for the unit test.
 */
export function currentNote(rows: Pick<ThoughtHybridMatch, "window" | "demoted">[]): string | null {
  const w = rows[0]?.window;
  if (!w) return null;
  // The latest sync is a thought's own metadata (068: max over linear_updated_at),
  // which any capture key can set, so it is quoted as untrusted text is (review pass 6).
  const lifecycle = `${w.known} carr${w.known === 1 ? "ies" : "y"} a lifecycle${w.syncedAt ? ` (latest sync ${snipText(w.syncedAt, 40)})` : ""}`;
  // A demoted exact hit keeps a quarter of its literal bonus (1/61 per literal
  // it holds), so one can still rank above current rows — on a query of
  // literals only, or holding several literals. Rather than state when (the
  // third and fourth review passes each found the rule wrong for some case),
  // the note counts the returned demoted rows that do sit above a current one.
  const isDemoted = (r: Pick<ThoughtHybridMatch, "demoted">) => (r.demoted?.length ?? 0) > 0;
  const above = rows.filter((r, i) => isDemoted(r) && rows.slice(i + 1).some((x) => !isDemoted(x))).length;
  const exception = above === 0 ? ""
    : ` — ${above} of the demoted, holding the query's literal, still rank${above === 1 ? "s" : ""} above a current one here`;
  const note = `Current first (prefer_current): ${w.demoted} of the top ${w.rows} match${w.rows === 1 ? "" : "es"} ${w.demoted === 1 ? "is" : "are"} settled, superseded or about finished tickets and ranked below the current ones${exception}; ${lifecycle}.`;
  if (w.exact) return note;
  const current = w.rows - w.demoted;
  const held = current === 0 ? `No current match was in the top ${w.rows}, so every row here is a demoted one`
    : `Only ${current} current match${current === 1 ? " was" : "es were"} in the top ${w.rows}, so the rows after ${current === 1 ? "it" : "them"} are demoted ones`;
  // Not exact means the window was full (its size is W = min(100, 4 × the
  // limit the function clamped)), so the window's own size says whether a
  // larger limit reads further — not the limit as sent, which the SQL rounds
  // and clamps (second review pass: 24.6 binds as 25, a window of 100).
  const advice = w.rows < 100 ? " — raise limit to read further" : ` — the window is capped at ${w.rows}`;
  return `${note} ${held}, and a current match past the window may have been missed${advice}.`;
}

/**
 * The hint an error from a min_trust search carries (SMD-1724): the function
 * forms it calls are 074's and 075's, and a brain before them has none — the
 * search without it still answers, so the caller is told so. Read first: a
 * min_trust search with prefer_current misses 075's search_thoughts_current,
 * which currentSearchHint would blame on 059.
 */
export function minTrustHint(msg: string): string {
  return /search_thoughts_(hybrid|current|keyword)/.test(msg) && /does not exist|could not find/i.test(msg)
    ? " — min_trust needs migrations 074 and 075 (db/migrations/074_min_trust.sql, 075_min_trust_hybrid.sql); search without min_trust meanwhile"
    : "";
}

/** The hint a search tool's fault carries, by what it asked for: min_trust's first, then prefer_current's; undefined when it asked for neither. */
export function searchHint(asked: { min_trust?: unknown; prefer_current?: boolean }): ((msg: string) => string) | undefined {
  const hints = [...(asked.min_trust !== undefined ? [minTrustHint] : []), ...(asked.prefer_current ? [currentSearchHint] : [])];
  return hints.length ? (msg) => hints.map((h) => h(msg)).find((t) => t !== "") ?? "" : undefined;
}

/** The hint an error from prefer_current's path carries: the migration or the grant it needs. */
export function currentSearchHint(msg: string): string {
  return /search_thoughts_current/.test(msg) && /does not exist|could not find/i.test(msg)
    ? " — migration 059 (db/migrations/059_search_prefers_current.sql) is not applied; search without prefer_current meanwhile"
    : /permission denied for table ob1_(ticket_head|superseded_by)\b/i.test(msg)
    ? " — prefer_current reads node_state's projection (migration 068), and the server's role needs the capture group's grants on ob1_ticket_head and ob1_superseded_by (db/README.md, Grants for a capturing role; migrate.ts --grant issues them); search without prefer_current meanwhile"
    : /permission denied for table thought_sources/i.test(msg)
    ? " — prefer_current reads node_state; before migration 068, and after it wherever PostgreSQL checks a removed join's tables, the server's role needs SELECT on thought_sources (db/README.md, Grants for a capturing role — the server group, which migrate.ts --grant issues); search without prefer_current meanwhile"
    : "";
}

// ── The read tools ───────────────────────────────────────────────────────────

/**
 * `search` and `fetch`: ChatGPT reads the text as JSON, so the text is the
 * value — its shape, exactly. An ingested row is marked IN it (SMD-1724, the
 * maintainer's call): the shape has no field every ChatGPT surface hands the
 * model but the title and the text, so a title starts `[ingested]` (search's
 * and fetch's, first review pass) and a fetched text starts with the notice. metadata.trust rides fetch's
 * metadata, as every key does. A result naming a ticket that moved since it
 * was written (SMD-2540) says so at the end of its title and carries the
 * typed field search_thoughts' hits do — only that result, so every other
 * keeps the shape exactly (the maintainer's call: title and field).
 */
export const renderSearch = (o: Outcome<SearchResult>): Reply =>
  render(o.ok ? ok({ results: o.value.results.map(({ trust, moved, movedNotRead, ...r }) => {
    const words = movedWords(moved ?? [], movedNotRead ?? 0);
    // A prefix, as `[ingested]`: the title's tail is the thought's own first words, which could forge a label there (review pass 4).
    // A provider that did not answer (SMD-2891): every result is a literal's exact match, and the title is what every surface hands the model.
    const title = `${oneOf(TRUST, trust) === "ingested" ? "[ingested] " : ""}${words ? `[moved since written: ${words}] ` : ""}${o.value.vectorFailed ? "[exact match — semantic search unavailable] " : ""}${r.title}`;
    return words ? { ...r, title, moved, ...(movedNotRead ? { movedNotRead } : {}) } : { ...r, title };
  }),
  // …and the whole answer says so beside the results, for a surface that
  // reads the shape and for an empty answer, which has no title to mark: the
  // marker word, as search_thoughts' typed result carries it, and a note.
  ...(o.value.vectorFailed ? { vectorFailed: o.value.vectorFailed.reason, note: literalOnlyNote(o.value.vectorFailed, "search") } : {}) }) : o,
    (v) => JSON.stringify(v), searchRefusal, AS_JSON);

/**
 * The compat search refused while its provider was down and nothing matched
 * (SMD-2891; review pass 4: an error, as before, since an empty list reads as
 * "nothing stored"): what was matched, and of each literal whether it is
 * absent or too common (review pass 2).
 */
function providerUnavailable(r: Extract<Refusal, { code: "EMBEDDING_PROVIDER_UNAVAILABLE" }>): string {
  const words = [`Found nothing. ${literalOnlyNote(r, "search")}`];
  if (r.needles.length) words.push(`No thought contains: ${r.needles.join(", ")}.`);
  if (r.commonNeedles.length) words.push(`Too common to match exactly (more thoughts contain it than one keyword page returns): ${r.commonNeedles.join(", ")} — the brain's search_thoughts_keyword tool pages through them.`);
  return words.join(" ");
}

/** A count of thoughts in words; a text match's bounded count past its page is "more than" it (SMD-2891, review pass 8). */
const thoughtCount = (n: number) => n > TEXT_PAGE ? `more than ${TEXT_PAGE} thoughts` : `${n} thought${n === 1 ? "" : "s"}`;

/**
 * What a search answered without a vector says (SMD-2891): the provider and
 * what happened there, that the matches are the query's literals only, and
 * the tool that matches any word — search_thoughts_keyword, which the compat
 * `search`'s caller may not have, so it is named there as the brain's.
 */
function literalOnlyNote(f: Pick<QueryVectorFailed, "base" | "detail" | "matched">, tool: "search" | "search_thoughts"): string {
  // Its literals; then, those matching nothing, the query as one text; or nothing could be (review passes 4 and 5).
  const how = f.matched === "text"
    ? "the query was matched by its identifiers and quoted spans, if any, and then as one text, exactly (case aside) — not by meaning"
    : f.matched === "none"
      ? "nothing could be matched: the query holds no identifier or quoted span, and is too short, longer than 64 characters, or only common words to match as one text"
      : "the query was matched only by its identifiers and quoted spans, exactly — not by meaning";
  return `Semantic search is unavailable — the embedding provider at ${f.base} failed: ${f.detail}. So ${how}. ` +
    `${tool === "search" ? "The brain's search_thoughts_keyword tool" : "search_thoughts_keyword"} finds any word or phrase a thought contains; semantic search returns once the provider answers.`;
}

export const renderFetch = (o: Outcome<FetchedThought>): Reply =>
  render(o.ok && ingestedNotice(o.value.metadata) ? ok({ ...o.value, title: `[ingested] ${o.value.title}`, text: `${INGESTED_NOTICE}\n\n${o.value.text}` }) : o,
    (v) => JSON.stringify(v), (r) => (r.code === "NOT_FOUND" ? `Fetch error: no thought with id ${r.id}` : unknownRefusal(r)), AS_JSON);

export function renderSearchThoughts(o: Outcome<SearchThoughtsResult>, askedPreferCurrent: boolean): Reply {
  return render(o, (v) => {
    const { query, hits: data, facts, vectorFailed } = v;
    // The provider did not answer for the query (SMD-2891): first, what the
    // rows are — exact-literal matches only, no similarity behind them.
    const literal = vectorFailed ? literalOnlyNote(vectorFailed, "search_thoughts") : null;
    if (data.length === 0) {
      // Nothing cleared the threshold and no literal matched; the facts
      // (core/reads.ts: the probe's, or without a vector answerWithoutVector's)
      // say why, when there are any.
      const why: string[] = literal ? [literal] : [];
      if (facts) {
        const absent = facts.needles.filter((_, i) => facts.needleCounts[i] === 0);
        if (absent.length) why.push(`No thought contains: ${absent.join(", ")}.`);
        // A literal some thought holds that matched nothing here: the probe is
        // unfiltered and an exact hit clears any threshold, so its thoughts are
        // outside the search's filter, said_by, actor or min_trust. Said only
        // without a vector: with one, a scoped count is SMD-3185's to word, and
        // the provider up changes nothing here (review pass 10).
        const outside = literal ? facts.needles.map((n, i) => [n, facts.needleCounts[i]] as const).filter(([, c]) => c > 0) : [];
        if (outside.length) why.push(`Held only by thoughts outside this search's filter, said_by, actor or min_trust: ${outside.map(([n, c]) => `${n} (in ${thoughtCount(c)})`).join(", ")}.`);
        if (facts.commonNeedles.length) why.push(`Too common to match exactly (more thoughts contain it than one keyword page returns): ${facts.commonNeedles.join(", ")} — use search_thoughts_keyword to page through them.`);
      }
      return `No thoughts found matching "${query}".${why.length ? ` ${why.join(" ")}` : ""}`;
    }

    const results = data.map(
      (t, i) => {
        const m = t.metadata || {};
        // A keyword hit with no vector has no similarity to report; it is
        // here because it contains the literal, and the header says which.
        // Without a query vector (SMD-2891) every hit is one, whether or not it has a vector of its own.
        const match = t.similarity == null ? (literal ? "exact match" : "exact match, no vector") : `${(t.similarity * 100).toFixed(1)}% match`;
        const parts = [
          `--- Result ${i + 1} (${match}) ---`,
          // The id, so update_thought and delete_thought can be aimed at a hit
          // the caller never captured — without it those two tools reach only
          // what capture_thought just returned. In the header group and cased
          // `ID:` to match search_thoughts_keyword, which prints the id the
          // same way for the same block format. SMD-1248.
          `ID: ${t.id}`,
        ];
        // 025: mark a hit a newer thought replaces, and name the replacement,
        // so the reader is not left ranking a superseded version as current.
        if (t.supersededBy) parts.push(`⚠ Superseded by a newer thought — ID ${t.supersededBy}`);
        // 059: a row prefer_current demoted says by what and why.
        const demotion = demotedLine(t);
        if (demotion) parts.push(demotion);
        // SMD-2540: the tickets it names that moved since it was written; a
        // label, so the rank above is unchanged.
        const moved = movedWords(movedField(t.moved), t.movedNotRead ?? 0);
        if (moved) parts.push(`⚠ Moved since written: ${moved}`);
        // SMD-1328: an undated row shows no Captured line rather than a
        // fabricated 1/1/1970; infinity/a no-ISO-form date shows its text.
        const captured = displayDate(t.created_at);
        parts.push(
          ...(captured ? [`Captured: ${captured}`] : []),
          `Type: ${metaText(m.type, TYPE_MAX) || "unknown"}`,
        );
        // SMD-1726: who wrote the current text, from the key (050); its own
        // line, as every field of this block is — nothing parses `ID:`
        // past the id, and nothing should start to.
        const by = actorLine(m);
        if (by) parts.push(by);
        // SMD-1724: outside text says so, in the block, before the text.
        const notice = ingestedNotice(m);
        if (notice) parts.push(notice);
        if (t.matchedNeedles.length) parts.push(`Contains: ${t.matchedNeedles.join(", ")}`);
        // SMD-2510: each metadata value on its one line, as the text is fenced.
        const topics = metaList(m.topics, TAG_MAX), people = metaList(m.people, TAG_MAX), actions = metaList(m.action_items, ACTION_MAX);
        if (topics.length) parts.push(`Topics: ${topics.join(", ")}`);
        if (people.length) parts.push(`People: ${people.join(", ")}`);
        if (actions.length) parts.push(`Actions: ${actions.join("; ")}`);
        // SMD-2483: the text fenced, so no line of it reads as this reply's own.
        parts.push(`\n${fenceText(t.content)}`);
        return parts.join("\n");
      }
    );

    // What the query was taken to mean, from the first row (every row
    // carries the same three): which literals were searched for exactly —
    // and, separately, which of those no thought contains, because
    // `needles` lists every literal that was asked for and a literal with
    // zero hits is asked for too (review pass) — which were too common to
    // use, and whether there was anything to embed.
    const head = facts!;
    const matchedAny = new Set(data.flatMap((t) => t.matchedNeedles));
    // Absent and truncated are different facts, and only the count tells
    // them apart: a literal with hits that all fell outside the limit was
    // once reported as "no thought contains" (review pass).
    const absent = head.needles.filter((n, i) => head.needleCounts[i] === 0);
    const truncated = head.needles.filter((n, i) => head.needleCounts[i] > 0 && !matchedAny.has(n));
    const notes: string[] = literal ? [literal] : [];
    // A text match (review pass 5): no ranking for prefer_current to demote in, and a count past the limit said, as a literal's is.
    const asText = vectorFailed?.matched === "text";
    if (head.needles.length) notes.push(`Searched exactly for: ${head.needles.join(", ")}.`);
    // Past the page the shown are the newest of the first rows the scan met, not of every holder (review pass 9).
    if (asText && head.needleCounts[0] > data.length) notes.push(head.needleCounts[0] > TEXT_PAGE
      ? `It is in ${thoughtCount(head.needleCounts[0])}; these ${data.length} are the newest of the first ${TEXT_PAGE + 1} the scan found, not of all — page with search_thoughts_keyword.`
      : `It is in ${thoughtCount(head.needleCounts[0])}; these are the newest ${data.length} — raise limit or page with search_thoughts_keyword.`);
    if (asText && v.preferCurrent) notes.push("prefer_current does not rank a text match: these are in its order, a superseded one labelled.");
    if (absent.length) notes.push(`No thought contains: ${absent.join(", ")}.`);
    if (truncated.length) notes.push(`Outside the top ${data.length}${v.preferCurrent ? " (or demoted past it)" : ""}: ${truncated.map((n, ) => `${n} (in ${head.needleCounts[head.needles.indexOf(n)]} thought${head.needleCounts[head.needles.indexOf(n)] === 1 ? "" : "s"})`).join(", ")} — raise limit or use search_thoughts_keyword.`);
    if (head.commonNeedles.length) notes.push(`Too common to match exactly (more thoughts contain it than one keyword page returns): ${head.commonNeedles.join(", ")}.`);
    // prefer_current's window rides the value once; the note reads it off the first row.
    const current = currentNote(data.map((t) => ({ demoted: t.demoted, window: v.window ?? undefined })));
    if (current) notes.push(current);
    // Without a vector there is no similarity to rank the rest by (SMD-2891).
    if (head.literalOnly && !literal) {
      notes.push(matchedAny.size
        ? "The query is only literals, so exact matches are ranked first and the rest by similarity."
        : head.commonNeedles.length
          ? `The query is only literals, and too common to match exactly, so these results are by similarity alone${v.preferCurrent ? ", current ones first" : ""}.`
          : `The query is only literals and no thought contains them, so these results are by similarity alone${v.preferCurrent ? ", current ones first" : ""}.`);
    }

    return `Found ${data.length} thought(s):${notes.length ? ` ${notes.join(" ")}` : ""}\n\n${results.join("\n\n")}`;
  }, (r) => searchRefusal(r, askedPreferCurrent ? currentSearchHint : undefined), safeSearch);
}

export function renderSearchThoughtsKeyword(o: Outcome<KeywordResult>): Reply {
  return render(o, ({ query, offset, total, hits: data }) => {
    if (data.length === 0) {
      // Two different nothings, and the difference is actionable: an empty
      // needle is a caller bug, no matches is an answer. Saying "no thoughts
      // found" for the first sends the model looking for different words.
      if (query.trim() === "") return "Empty query — pass the literal text to search for.";
      // The needle is matched exactly as given, whitespace included, because
      // trimming it would silently widen "SMD-944 " into "SMD-944". That is
      // the right trade, but it makes a pasted string with a stray space
      // fail for a reason the caller cannot see — so say it.
      const padded = query !== query.trim();
      return `No thoughts contain "${query}". This is an exact substring match — ` +
        (padded
          ? `note the leading or trailing whitespace in your query, which is matched literally. Try "${query.trim()}", or `
          : `try `) +
        `search_thoughts for a match by meaning, or a shorter fragment of the same string.`;
    }

    const results = data.map((t, i) => {
      const m = t.metadata || {};
      // SMD-1328: as the search block above — absent, not a fake 1970.
      const captured = displayDate(t.created_at);
      const parts = [
        `--- Result ${offset + i + 1} (${t.occurrences} occurrence${t.occurrences === 1 ? "" : "s"}) ---`,
        `ID: ${t.id}`,
        ...(captured ? [`Captured: ${captured}`] : []),
        `Type: ${metaText(m.type, TYPE_MAX) || "unknown"}`,
      ];
      // SMD-1726: who wrote it, the line search_thoughts prints; SMD-1724: the
      // notice an ingested row carries, as there.
      const by = actorLine(m);
      if (by) parts.push(by);
      const notice = ingestedNotice(m);
      if (notice) parts.push(notice);
      const topics = metaList(m.topics, TAG_MAX);
      if (topics.length) parts.push(`Topics: ${topics.join(", ")}`);
      parts.push(`\n${fenceText(t.content)}`);
      return parts.join("\n");
    });

    // The header states the whole match set, not the page. Without it a
    // model that gets ten results cannot tell "these are all of them" from
    // "there are four hundred more", and will not page.
    const shown = `${offset + 1}-${offset + data.length} of ${total}`;
    const more =
      offset + data.length < total! // a non-empty page always carries its total
        ? ` Call again with offset=${offset + data.length} for the next page.`
        : "";

    return `Showing ${shown} thought(s) containing "${query}".${more}\n\n${results.join("\n\n")}`;
  }, (r) => searchRefusal(r), safeKeyword);
}

export function renderListThoughts(o: Outcome<ListThoughtsResult>): Reply {
  return render(o, ({ thoughts: data, sort, cursor }) => {
    if (!data.length) return "No thoughts found.";
    const results = data.map(
      (t, i) => {
        const m = t.metadata || {};
        // SMD-2510: the type and tags on the header's one line.
        const tags = metaList(m.topics, TAG_MAX).join(", ");
        // An `ID:` line, the same label the two search tools print — it is what
        // update_thought and delete_thought take. This compact format has no
        // header group, so it trails the content. SMD-1248.
        const mark = t.supersededBy ? `\n   ⚠ Superseded by a newer thought — ID ${t.supersededBy}` : "";
        // SMD-1726: who wrote it, AFTER the id line, indented as the block
        // is — the content-then-ID adjacency stays, which this repo's own
        // e2e suite ([8]) matched on and a client may too.
        const by = actorLine(m);
        const who = by ? `\n   ${by}` : "";
        // SMD-1724: an ingested row's notice goes BEFORE its text, the one
        // place in this format a reader meets it first; the content-then-ID
        // adjacency stays.
        const notice = ingestedNotice(m);
        const warn = notice ? `\n   ${notice}` : "";
        // SMD-1328: the date bracket is structural here, so an undated row
        // reads `[undated]` (never `[1/1/1970]`); a sentinel shows its text.
        // SMD-2483: the text fenced and indented as the block is, every line
        // of it — no blank line inside an item, and no line of the text a
        // next item or an `ID:` line.
        return `${i + 1}. [${displayDate(t.created_at) ?? "undated"}] (${metaText(m.type, TYPE_MAX) || "??"}${tags ? " - " + tags : ""})${warn}\n${fenceText(t.content, "   ")}\n   ID: ${t.id}${who}${mark}`;
      }
    );
    // SMD-2995: the next page's cursor, last, when more follow — what a caller passes as `after`.
    const more = cursor ? `\n\nMore follow. Cursor: ${cursor} — pass it as \`after\`${sort === "oldest" ? " with `sort: oldest` and" : " with"} the same filters for the next page.` : "";
    // Newest first keeps main's header, which the old SvelteKit dashboard's parser read until SMD-3310 retired it;
    // oldest first says its order, since a page deep in the walk is not the oldest (review pass 3).
    return `${data.length} ${sort === "oldest" ? "thought(s), oldest first" : "recent thought(s)"}:\n\n${results.join("\n\n")}${more}`;
  }, (r) => r.code === "REFUSED_CURSOR"
    ? r.reason === "sort"
      ? `Refused: that cursor was made with \`sort: ${r.sort}\` — pass the same sort with it, or leave out \`after\` to start the list again.`
      : "Refused: `after` is not a list_thoughts cursor — pass the `cursor` a previous page ended with, as it was given, or leave it out for the first page."
    : unknownRefusal(r), safeList);
}

export function renderSupersessionProposals(o: Outcome<ProposalsResult>): Reply {
  return render(o, ({ status, lineage, judgeKey, proposals: data, cursor, remaining, pastCursor }) => {
    // SMD-3248: the pass selected (109) is said with the rest of the selection.
    const onLineage = (lineage === true ? " on a lineage pair" : lineage === false ? " not on a lineage pair" : "") + (judgeKey === undefined ? "" : ` judged by ${judgeKeyText(judgeKey)}`);
    // SMD-3249: how many more follow, and the cursor that lists them.
    const next = cursor ? `\n\n${remaining} more follow${remaining === 1 ? "s" : ""} — pass after: ${cursor} (with the same filters) for the next page.` : "";
    if (!data.length) {
      // Review pass 1: a page whose rows all went between the listing and the writers' read still carries
      // the cursor past them; and an empty page after a cursor is the walk's end, not an empty queue — a pass to run
      // or a key to check was the wrong advice there.
      if (cursor) return `No ${status === "all" ? "" : status + " "}supersession proposals${onLineage} on this page: the ones it listed went before they were read.${next}`;
      if (pastCursor) return `No more ${status === "all" ? "" : status + " "}supersession proposals${onLineage} past this cursor — the listing ends here.`;
      // A lineage pair is never proposed since 066, so an empty lineage
      // selection is not the pass's to fill (maintainer read, third pass).
      // SMD-3248 review pass 1: under judge_key, no row is no pass of exactly that key in this status — a typo, or an older
      // pass's key, which no run will fill — so the advice is the key's, not the pass's.
      // Review pass 2: the key may be right and the status or lineage filter what emptied it.
      if (judgeKey !== undefined) return `No ${status === "all" ? "" : status + " "}supersession proposals${onLineage}. Either that pass has none in this selection, or no pass has exactly this key: the match is exact, each proposal names the key that judged it (judged by consolidate:…), and \`cd db && bun consolidate.ts --url $DATABASE_URL --status\` counts the pending by pass.`;
      return `No ${status === "all" ? "" : status + " "}supersession proposals${onLineage}.${lineage === true ? "" : " The consolidation pass proposes them: cd db && bun consolidate.ts --url $DATABASE_URL (after db/extract-entities.ts, which it pairs thoughts by)."}`;
    }
    // SMD-1803: through displayDate, never new Date() on a raw column — an
    // undated thought reads "undated", an infinity/BC one its own text, not
    // a fabricated 12/31/1969 or "Invalid Date". (older/newer.created_at are
    // string | null now; judgedAt/reviewedAt are non-null where rendered.)
    const day = (d: string | null) => displayDate(d) ?? "undated";
    // Thought content and the judge's reason are untrusted text; snipText
    // is the one cleaner every reply quotes a thought through.
    const snip = (c: string) => snipText(c, 200);
    const phrase = (v: string) =>
      v === "newer_supersedes_older" ? "the NEWER thought supersedes the older"
      : v === "older_supersedes_newer" ? "the OLDER thought supersedes the newer"
      : "one is out of date, which not stated — accepting needs --direction newer or older";
    // SMD-2707: each side under its text — the ID line first, as before, then
    // who wrote it (094) and what supersedes it. An ingested side's notice
    // goes before its text (SMD-1724's rule), the text then behind a label
    // of its own, so no line of it is an `ID:` line.
    const side = (label: "newer" | "older", s: ProposalSide) => {
      const notice = s.writer ? ingestedNotice({ trust: s.writer.trust }) : null;
      const head = `   ${label} [${day(s.created_at)}]${s.edited ? " (edited since judged)" : ""}`;
      return `\n${notice ? `${head} ${notice}\n      text: ${snip(s.content)}` : `${head}: ${snip(s.content)}`}\n      ID: ${s.id}` +
        (s.writer ? `\n      ${proposalWriterLine(s.writer)}` : "") +
        (s.supersededBy ? `\n      ${supersededLine(s.supersededBy)}` : "") +
        (s.lapses?.length ? `\n      ${lapsesLine(s.lapses, s.id)}` : "") +
        (s.walkCapped ? `\n      ${walkCappedLine()}` : "");
    };
    const results = data.map((p, i) => {
      const edited = p.older.edited || p.newer.edited;
      const flags = standingFlags(p);
      const dir = p.verdict === "conflict_undirected" ? " --direction <newer|older>" : "";
      // SMD-2533: the judge's reason and the review note on one line each, the
      // reason behind its label — a reason reading `ID: <uuid>` (a judge reads
      // both thoughts' text, which can steer it) starts no line a reader takes
      // as a thought's id, and a NEL in either breaks none. The queue's row
      // keeps both whole (the value carries neither, safeProposals).
      const reason = p.reason === null ? "" : snipText(p.reason, PROPOSAL_TEXT_MAX);
      const note = p.reviewNote === null ? "" : snipText(p.reviewNote, PROPOSAL_TEXT_MAX);
      // 070: the CLI refuses an accept on a lineage pair without --force;
      // SMD-2707: and on a WRITER flag.
      // An undirected verdict a flag splits: each direction its own accept,
      // --force on the one that needs it (review pass 1).
      const force = (d?: "newer" | "older") => (edited || p.lineage || flags.some((f) => !d || f.stands === d) ? " --force" : "");
      const accept = p.verdict === "conflict_undirected" && flags.length
        ? `--accept ${p.id} --direction newer${force("newer")}   or … --accept ${p.id} --direction older${force("older")}`
        : `--accept ${p.id}${dir}${force()}`;
      const review = p.status === "pending"
        ? `   accept: cd db && bun consolidate.ts --url $DATABASE_URL ${accept}   reject: … --reject ${p.id}` +
          (edited ? "\n   (a thought was edited after the pair was judged, so the verdict is about an earlier text; --force accepts it anyway)" : "")
        : `   ${p.status}${p.reviewedAt ? ` on ${day(p.reviewedAt)}` : ""}${stoodSide(p) ? ` — the ${stoodSide(p)} side stands` : ""}${note ? `: ${note}` : ""}`;
      // 070 (SMD-2313): a lineage pair — one side derived from the other
      // — is never proposed since 066; a row standing on one is the
      // reviewer's to reject, said with the command while it is theirs.
      const lineageLine = p.lineage
        ? `\n   LINEAGE PAIR: one side's derived_from names the other (a derivation and its input) — never proposed since migration 066${p.status === "pending" || p.status === "stale" ? `; reject it: cd db && bun consolidate.ts --url $DATABASE_URL --reject ${p.id} --note "lineage pair (066)"` : p.status === "accepted" ? `; accepted while the derivation names its input — cd db && bun consolidate.ts --url $DATABASE_URL --reject ${p.id} clears the pointer (029)` : ""}`
        : "";
      // SMD-2707: the side to stand is a capture-only key's text or of lower
      // trust — the reviewer reads both writers before an accept.
      const writerLine = flags.length
        ? `\n   WRITER: ${writerFlagsText(flags, p)}${p.status === "pending" ? writerFlagAdvice(flags) : ""}`
        : "";
      return `${i + 1}. [confidence ${p.confidence.toFixed(2)}] ${phrase(p.verdict)}${p.lineage ? "  LINEAGE PAIR" : ""}${flags.length ? "  WRITER" : ""}${reason ? `\n   Reason: ${reason}` : ""}${lineageLine}${writerLine}` +
        side("newer", p.newer) + side("older", p.older) +
        // A recorded key whole when it is a pass key, else quoted and escaped (pass-key.ts: a newline forged an `ID:` line
        // in review pass 2, spaces passed for the line's own words in 3, stripped look-alikes for the real key in 4).
        `\n   proposal ${p.id} — judged by ${judgeKeyText(p.judgeKey)} on ${day(p.judgedAt)}\n${review}`;
    });
    const unread = data.some((p) => !p.older.writer || !p.newer.writer) ? ` ${WRITERS_UNREAD}` : "";
    // Review pass 1: a page after a cursor says so — its rows are not the selection's first.
    return `${data.length} ${status === "all" ? "" : status + " "}supersession proposal(s)${onLineage}${pastCursor ? " past the cursor" : ""}, most confident first. The pass proposes; nothing is written to a thought until a proposal is accepted — with review_supersession_proposal (a write key; a flag a pending row's CLI line names is the argument of that name, force as true), or that line.${unread}\n\n${results.join("\n\n")}${next}`;
  }, (r) => r.code === "REFUSED_CURSOR"
    ? r.reason === "filters" && r.made
      // Review pass 1: the filters it was made under, so the caller passes them again (a status and lineage token, a pass key).
      ? `Refused: that cursor was made with \`status: ${r.made.status}\`${r.made.lineage === null ? "" : `, \`lineage: ${r.made.lineage}\``}${r.made.judgeKey === null ? "" : `, \`judge_key: ${judgeKeyText(r.made.judgeKey)}\``}${r.made.lineage === null && r.made.judgeKey === null ? " and no other filter" : ""} — pass the same filters with it, or leave out \`after\` to start the list again.`
      : "Refused: `after` is not a list_supersession_proposals cursor — pass the `cursor` a previous page ended with, as it was given, with the same filters, or leave it out for the first page."
    : unknownRefusal(r), safeProposals);
}

/**
 * The hint a listing error carries. 070 (SMD-2313), 109 (SMD-3248), then 110
 * (SMD-3249): the store calls the seven-argument form, so a brain short of 110 — or of 029,
 * whose queue the listing reads — fails naming that form (`p_lineage` was
 * PostgREST's word for it, before SMD-3152); the driver's message is the same
 * either way, so one hint names both files (cold read, first and fourth review
 * passes).
 */
export const proposalsHint = (msg: string): string =>
  /list_supersession_proposals|supersession_proposals|p_lineage/.test(msg)
    ? " — the migrations through 110 are not applied (029, db/migrations/029_supersession_proposals.sql, creates the queue; 110, db/migrations/110_listing_pages.sql, its current listing)"
    : "";

export function renderThoughtStats(o: Outcome<ThoughtStats>): Reply {
  return render(o, ({ total, oldest, newest, types, topics, people, aggregated }) => {
    const sort = (obj: Record<string, number>): [string, number][] =>
      Object.entries(obj)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10);

    const lines: string[] = [
      `Total thoughts: ${total}`,
      `Date range: ${
        // SMD-1328: min/max already skip NULLs (024), so a real range here
        // is two real dates; displayDate keeps an infinity edge legible.
        newest && oldest
          ? `${displayDate(oldest)} → ${displayDate(newest)}`
          : "N/A"
      }`,
    ];

    // Never report aggregates as corpus-wide when they are not. The store
    // covers the whole corpus (aggregated === total), so this does not fire;
    // it stays for the contract's field (the capped walk that could stop
    // short was the PostgREST store's, retired in SMD-3152).
    if (aggregated < total) {
      lines.push(
        `Note: breakdowns below cover the ${aggregated.toLocaleString()} most recent thoughts, ` +
          `not all ${total.toLocaleString()}.`
      );
    }

    // SMD-2510: a type, topic or person is a metadata value, on its one line.
    lines.push("", "Types:", ...sort(types).map(([k, v]) => `  ${metaText(k, TYPE_MAX)}: ${v}`));

    if (Object.keys(topics).length) {
      lines.push("", "Top topics:");
      for (const [k, v] of sort(topics)) lines.push(`  ${metaText(k, TAG_MAX)}: ${v}`);
    }

    if (Object.keys(people).length) {
      lines.push("", "People mentioned:");
      for (const [k, v] of sort(people)) lines.push(`  ${metaText(k, TAG_MAX)}: ${v}`);
    }

    return lines.join("\n");
  }, unknownRefusal, safeStats);
}

/** The metadata keys the stamp owns: the writer's kind and name (050, SMD-1726) and the content's trust (073, SMD-1724), stamped as the content moves. */
const ACTOR_MARKS: ReadonlySet<string> = new Set(["actor_kind", "actor_name", "trust"]);

/**
 * One change as a client reads it: when, what and who on the first line with
 * the thought's `ID:` (the label every read tool prints, SMD-1248, so fetch and
 * update_thought can reach what the line names); then what moved, bounded;
 * then the supersedes pointer, because "X now replaces Y" is the change a
 * resuming agent most needs. Untrusted text — a head, a metadata key — goes
 * through snipText, the one cleaner every reply quotes a thought through.
 */
function renderChange(c: AuditChange, n: number): string {
  // The full ISO form — the one spelling the header's `since` echoes, so a
  // client that checkpoints on a line's time re-reads nothing it need not.
  const when = c.createdAt;
  // Name and door are untrusted text (a writer sets its own envelope; a raw
  // INSERT sets either column), so both go through snipText: one line, and no
  // forged entry or Cursor line in a feed agents act on. No key but a door is
  // a worker that names itself alone — 050's backfill_thought_actors — and
  // reads by its door rather than as an anonymous edit.
  const who = c.actorName !== null ? `by ${snipText(c.actorName, 80)}${c.actorKind ? ` (${c.actorKind})` : ""}`
    : c.origin !== null ? `by ${snipText(c.origin, 80)} (no key)`
    : "from outside the server";
  // 050's stamp is not an edit (it holds the updated_at trigger): a row whose
  // only change is the marks — 050's two, 073's trust — is "marked", the
  // backfill's row above all.
  const marksOnly = c.action === "update" && c.changed.length === 1 && c.changed[0] === "metadata" && c.metadataKeys.length > 0 && c.metadataKeys.every((k) => ACTOR_MARKS.has(k));
  // 085's two events (SMD-2664): a key that can read re-captured a capture-only
  // key's text and was weighed against its label — moved to it, or kept.
  const restamped = c.action === "update" && c.changed.includes("restamped");
  const declined = c.action === "update" && c.changed.includes("restamp_declined");
  // 086's (SMD-2744): the operator reset such a label.
  const reset = c.action === "update" && c.changed.includes("restamp_reset");
  const verb = c.action === "capture" ? "captured" : c.action === "update" ? (reset ? "reset" : restamped || declined ? "re-captured" : marksOnly ? "marked" : "edited") : "deleted";
  const gone = c.action !== "delete" && !c.present ? " (deleted since)" : "";
  const lines = [`${n}. ${when} — ${verb} ${who} — ID: ${c.thoughtId}${gone}`];
  const text = c.head === null ? null : snipText(c.head, 200);
  // A capture row carries no text of its own (008's capture diff is the
  // metadata), so the head is the thought's CURRENT text — say so, since an edit
  // since would otherwise read as what was captured; a deleted thought's text
  // is in its delete row, not gone (both caught: cold-read, pass 1).
  if (c.action === "capture") lines.push(text === null ? "   (the text is in its delete row)" : `   now: "${text}"`);
  if (c.action === "delete" && text !== null) lines.push(`   was: "${text}"`);
  if (reset) {
    const keys = c.metadataKeys.filter((k) => ACTOR_MARKS.has(k));
    lines.push(`   the capture-only key's label ${keys.length ? `restored (metadata: ${keys.join(", ")})` : "unsettled"}: the next re-capture by a classified key that can read is weighed again`);
  } else if (restamped) {
    const keys = c.metadataKeys.filter((k) => ACTOR_MARKS.has(k));
    lines.push(`   the capture-only key's label moved to this key${keys.length ? ` (metadata: ${keys.join(", ")})` : ""}`);
  } else if (declined) {
    lines.push("   the capture-only key's label kept: the trust this re-capture was weighed at is not higher, and no other key's re-capture will move it (an operator key's reset_capture_stamp can reopen it while the text stands)");
  } else if (c.action === "update") {
    const parts: string[] = [];
    if (c.changed.includes("content")) parts.push(text === null ? "content" : `content → "${text}"`);
    // 050 stamps the two marks into metadata whenever the content moves under
    // another key: the first line already says who, so beside a content change
    // they are not listed as keys the editor touched (a pre-050 row whose
    // caller wrote a mark of its own loses it the same way — the row cannot
    // tell the two apart; the raw diff stays reachable by the audit id). Alone
    // — the backfill's row — they are the whole change and stay. A side that is
    // not an object has no keys to name and still says "metadata".
    const keys = c.changed.includes("content") ? c.metadataKeys.filter((k) => !ACTOR_MARKS.has(k)) : c.metadataKeys;
    const bare = c.metadataKeys.length === 0;
    if (c.changed.includes("metadata") && (keys.length || bare)) parts.push(bare ? "metadata" : `metadata: ${keys.map((k) => snipText(k, 40)).join(", ")}`);
    if (c.changed.includes("embedding_present")) parts.push("embedding");
    if (parts.length) lines.push(`   ${parts.join("; ")}`);
    // 046: an unchanged edit that declared a stance, cites or a window is an
    // event with an empty diff — say so rather than print a bare header.
    else if (!c.changed.some((k) => k === "supersedes" || k === "derived_from")) lines.push("   restated — no field changed");
  }
  if (c.action === "capture" && c.supersedesAfter) lines.push(`   supersedes ${c.supersedesAfter}`);
  if (c.action === "update") {
    if (c.supersedesAfter) lines.push(`   now supersedes ${c.supersedesAfter}${c.supersedesBefore ? ` (was ${c.supersedesBefore})` : ""}`);
    else if (c.supersedesBefore) lines.push(`   no longer supersedes ${c.supersedesBefore} (pointer cleared)`);
  }
  // A point-in-time record: whether the superseded thought is current again
  // depends on what happened to it since, which this row cannot know.
  if (c.action === "delete" && c.supersedesBefore) lines.push(`   it superseded ${c.supersedesBefore}`);
  if (c.derivation) lines.push(c.action === "capture" ? "   captured with sources (derived_from)" : "   sources (derived_from) changed");
  return lines.join("\n");
}

export function renderThoughtChanges(o: Outcome<ChangesResult>): Reply {
  return render(o, (v) => {
    // Both filters name themselves in the header, so `agent` set to the
    // caller's own key beside others_only reads as the empty set it is
    // (caught: cold-read, pass 1).
    // A name that cleans to nothing (all control characters) still names
    // itself in the header, as its JSON.
    const named = v.agent ? ` by ${snipText(v.agent, 80) || JSON.stringify(v.agent)}` : "";
    const who = named && v.notAgent ? `${named} but not ${v.notAgent}` : v.notAgent ? ` by everyone but ${v.notAgent}` : named;
    const what = v.actions ? `${v.actions.join("/")} change(s)` : "change(s)";
    const where = v.after ? "after the cursor" : v.since ? `since ${v.since}` : "recorded yet";
    const shown = v.changes;
    if (shown.length === 0) return `No ${what}${who} ${where}.${v.after ? " Keep the cursor." : ""}`;
    const head = v.bounded ? `${shown.length} ${what}${who} ${where}, oldest first:` : `The ${shown.length} most recent ${what}${who}, oldest first:`;
    const onward = !v.more ? "" : v.bounded ? " More changes follow." : " Older changes exist — pass a time before the first entry above as `since` to read them.";
    const tail = `Cursor: ${v.cursor} — pass it as \`since\` to continue from here.${onward}`;
    return `${head}\n\n${shown.map((c, i) => renderChange(c, i + 1)).join("\n\n")}\n\n${tail}`;
  }, (r) => (r.code === "REFUSED_SINCE"
    ? `Refused: \`since\` must be an ISO-8601 time with its zone (2026-09-22T08:00:00Z), a date (2026-09-22), or the cursor a previous call ended with, not "${snipText(r.value, 40)}".`
    : unknownRefusal(r)), safeChanges);
}

export const changesHint = (msg: string): string =>
  /thought_changes/.test(msg) && /does not exist|could not find/i.test(msg)
    ? " — migration 052 (db/migrations/052_thought_changes.sql) is not applied"
    : /permission denied for table thought_audit/i.test(msg)
    ? " — the server's role needs SELECT on thought_audit (db/README.md, Grants for a capturing role — the server group, which migrate.ts --grant issues)"
    : "";

/** list_thought_ids: the page itself is the text, a JSON object a script reads. */
export const renderThoughtIds = (o: Outcome<ThoughtIdPage>): Reply =>
  render(o, (v) => JSON.stringify(v), (r) => (r.code === "REFUSED_CURSOR" ? "Error: `after` must be a thought id (a uuid) — pass the previous page's `cursor`." : unknownRefusal(r)), AS_JSON);

/** list_logged_searches: the page itself is the text. */
export const renderLoggedSearches = (o: Outcome<LoggedSearchPage>): Reply =>
  render(o, (v) => JSON.stringify(v), (r) => (r.code === "REFUSED_SINCE" ? "Error: `since` must be an ISO-8601 time with its zone (e.g. 2026-09-24T00:00:00Z) or a date (2026-09-24); a clock with no Z or offset is refused." : unknownRefusal(r)), AS_JSON);

export const loggedSearchesHint = (msg: string): string =>
  /query_log/.test(msg) && /does not exist|could not find/i.test(msg)
    ? " — migration 034 (db/migrations/034_query_log.sql) is not applied"
    : "";

/** worker_status: the text is the bare array it has always been; the value keys it (a result is an object). */
export const renderWorkerStatus = (o: Outcome<WorkerStatusResult>): Reply => render(o, (v) => JSON.stringify(v.pools), unknownRefusal, AS_JSON);

/** job_status: the job record is the text; NOT_FOUND covers an unknown id, another key's job and a pruned one alike. */
export const renderJobStatus = (o: Outcome<PublicJob>): Reply =>
  render(o, (v) => JSON.stringify(v), (r) => (r.code === "NOT_FOUND" ? `No job ${JSON.stringify(r.id)} for this key — an unknown id, another key's job, or one pruned from the registry.` : unknownRefusal(r)), AS_JSON);

/** brain_info: the short table (brain-info.ts), and the record the keyed /health body answers as JSON beside it — whole: it holds the server's and the database's own facts, no word a thought, a key or a judge wrote. */
export const renderBrainInfoReply = (info: BrainInfo): Reply => render(ok(info), renderBrainInfo, unknownRefusal, AS_RECORD);

/** scan_thoughts: the handle is the text. */
export const renderJobHandle = (o: Outcome<JobHandle>): Reply => render(o, (v) => JSON.stringify(v), unknownRefusal, AS_JSON);

// ── The write tools (SMD-2283 PR 2) ──────────────────────────────────────────

/**
 * What a re-capture did to a capture-only key's label (090, SMD-2898): that the
 * text landed on an existing thought, whether its label moved to the caller or
 * was kept, and whether the row is now settled — what only thought_changes
 * said before. Where a label moved or was kept, the operator's reset is named
 * as the way to weigh it afresh. No label (a new text, a key that cannot read, a row that is
 * not a capture-only key's, a database before 090) says nothing.
 */
function explainRecaptureLabel(v: Captured): string {
  const l = v.label;
  if (!l) return "";
  // Not 035's "already captured as" opening: both notes can fire on one reply.
  const head = `\n\nNote: this re-capture landed on ${v.id}, which already held the text`;
  // What the reset does by what is there: a move it puts back, a decline it
  // only clears (086) — "puts it back" over a kept label had nothing to put
  // back (review pass 1).
  const putBack = " An operator key's reset_capture_stamp puts the capture-only key's label back, to be weighed afresh, while the text stands.";
  const reopen = " An operator key's reset_capture_stamp reopens it, to be weighed afresh, while the text stands.";
  switch (l.outcome) {
    case "moved": {
      // Into or out of `ingested`: what fetch and min_trust now do with it,
      // as the reset's reply says it (review passes 1 and 2).
      const before = oneOf(TRUST, l.before.trust), after = oneOf(TRUST, l.stamp.trust);
      const notice = before === "ingested" && after !== "ingested" && after !== null
        ? ` The outside-text notice goes, and min_trust searches up to ${after} include it.`
        : before !== "ingested" && after === "ingested"
          ? " It now shows under fetch's outside-text notice, and min_trust searches find it at ingested and leave it out above."
          : "";
      return `${head} under a capture-only key's label (${stampText(l.before)}). Its label moved to your key: ${stampText(l.stamp)}.${notice} No later re-capture moves it.${putBack}`;
    }
    case "kept":
      return `${head} under a capture-only key's label (${stampText(l.stamp)}), and the label was kept: the trust your key was weighed at (${oneOf(TRUST, l.weighed) ?? "none"}) does not rank above it. ` +
        // 085 weighs a key's own later landing again only by its agent id:
        // a name-only decline settles the row for every caller (review passes 1 and 2).
        `The row is now settled against ${l.own ? "every other key (your own key's later re-capture is still weighed)" : "every key, yours included"}.${reopen}`;
    case "settled": {
      if (l.by === "decline") {
        // The decliner's own later re-capture is still weighed when its
        // decline names its agent id (review pass 2: the operator was told the
        // row was fixed, and the decliner moved it after).
        const who = l.decliner !== null ? snipText(l.decliner, 80) : null;
        // A weighed decliner with no name is still weighed (review pass 3).
        return !l.declinerWeighed
          ? `${head}, and an earlier re-capture settled it against every key, leaving the capture-only key's label (${stampText(l.stamp)}). This re-capture moved nothing.${reopen}`
          : who !== null
            ? `${head}, and an earlier re-capture by ${who} settled it, leaving the capture-only key's label (${stampText(l.stamp)}): no other key's re-capture moves it, though ${who}'s own later re-capture is still weighed. This re-capture moved nothing.${reopen}`
            : `${head}, and an earlier re-capture settled it against every key but its decliner's own, leaving the capture-only key's label (${stampText(l.stamp)}). This re-capture moved nothing.${reopen}`;
      }
      return l.mine
        ? `${head}; its label is already your key's (${stampText(l.stamp)}), from an earlier re-capture. A label moves once, so this re-capture moved nothing.${putBack}`
        : `${head}, and an earlier re-capture by another key moved its label to that key: ${stampText(l.stamp)}. This re-capture moved nothing.${putBack}`;
    }
    case "unweighed":
      return `${head} under a capture-only key's label (${stampText(l.stamp)}), which was kept: your key has no kind, so its re-capture was not weighed and settled nothing (the operator classifies keys in SQL with set_agent_kind; db/README.md).`;
  }
}

/**
 * What a capture or an edit reply says when the whole-content vector could
 * not be had for a reason that says nothing about the next attempt — a 429, a
 * 5xx, a lost connection, OB1_LLM_TIMEOUT. The head window stands in, which is
 * a legitimate state and a silent one, and unlike the re-embed there is no
 * claim row here to record it. A provider that REFUSED the length stays silent,
 * as change 27 decided: that is the vector every long capture gets there.
 * `recaptures`: whether this caller's re-capture writes onto a row that holds
 * the text. A capture-only key's does not (080, SMD-2539) and is not told
 * whether the text was new, so its note says what each case got and names the
 * re-embed pass alone (review pass 2: "stored" claimed a write a 'keep'
 * re-capture never made). It is also whether the provider's words are said:
 * they name its endpoint, which a key that cannot read is not told (SMD-2888).
 */
function explainHeadWindow(e: HeadWindow | null, recaptures = true): string {
  if (!e?.fellBack || e.refused) return "";
  // The provider's words name its endpoint, which a key that cannot read is
  // not told (rest/app.ts capturedFor; SMD-2888 review pass 2).
  const head = `\n\nNote: the whole content could not be embedded in one call${recaptures ? ` (${e.error ?? "no detail"})` : ""}; the head window's vector stands in for it. `;
  return recaptures
    ? `${head}The thought is stored and searchable, and every search chunk has its vector; re-capture, or a re-embed pass, gives it the whole-content vector once the provider answers.`
    : `${head}A new thought is stored with it and every search chunk's vector; text already captured keeps its own vector, or takes this one if it had none, and gets none of these chunks. A re-embed pass gives a head window's vector the whole-content one once the provider answers.`;
}

/**
 * A `supersedes` that is not a thought id, refused at the tool before any model
 * call or database write (032) — both tools, one sentence; `orNull` is the
 * edit tool's clause, since only it takes null.
 */
const supersedesShape = (value: string, orNull: boolean): string =>
  `Refused: \`supersedes\` must be a thought id (the ID: line of a search result)${orNull ? " or null to clear it" : ""}, not "${value.slice(0, 40)}".`;

/** A caller's `metadata` refused at the boundary (SMD-2014), checked before the model calls. */
function metadataShape(r: Extract<Refusal, { code: "REFUSED_METADATA_SHAPE" }>): string {
  const k = r.key ?? "";
  switch (r.problem) {
    case "too_many_keys": return `Refused: \`metadata\` carries ${r.count} keys — at most ${META_KEYS_MAX}.`;
    case "bad_key": return `Refused: the \`metadata\` key "${k.slice(0, 40)}" must be lower-case letters, digits and underscores, 2–40 characters, starting with a letter.`;
    case "reserved_key": return k === "client_key"
      ? "Refused: `client_key` is set once, by capture_thought's own `client_key` argument — not through `metadata`, and no patch moves it."
      : `Refused: \`metadata.${k}\` is set by the server, not the caller — use the \`source\` argument for the origin label; drop the rest.`;
    case "ticket_key": return `Refused: \`metadata.${k}\` is one of the keys a ticket's lifecycle is read from, which a capture-only key may not set (${TICKET_META_KEYS_TEXT}) — drop it, or capture with a key that can write.`;
    case "bad_value": return `Refused: \`metadata.${k}\` must be a string, number or boolean.`;
    case "value_too_long": return `Refused: \`metadata.${k}\` is ${r.length} characters — at most ${META_VALUE_MAX}.`;
  }
}

/** capture_thought's refusals, in the words the session hook has always read (SMD-1978). */
function captureRefusal(r: Refusal): string {
  switch (r.code) {
    case "REFUSED_SUPERSEDES_SHAPE": return supersedesShape(r.value, r.orNull);
    case "REFUSED_DERIVED_FROM_SHAPE": return `Refused: every \`derived_from\` entry must be a thought id (the ID: line of a search result), not "${r.value.slice(0, 40)}".`;
    case "REFUSED_METADATA_SHAPE": return metadataShape(r);
    case "REFUSED_CLIENT_KEY_SHAPE": return `Refused: \`client_key\` must be a UUID — by convention the thought's id on the brain the write was first made on — not "${r.value.slice(0, 40)}".`;
    case "REFUSED_CLIENT_KEY_SCOPE": return "Refused: `client_key` needs a key that can read — a capture-only key cannot send one. Capture without it.";
    case "SUPERSEDES_UNJUDGED":
      return r.cause === "check_failed"
        ? `Error: this key's \`supersedes\` could not be checked against the target's capture record (${r.detail})${r.noPrivilege ? " — the server role needs SELECT on thought_audit and thoughts: cd db && bun migrate.ts --grant <role> --url $DATABASE_URL" : ""}.`
        : "Error: this key's `supersedes` could not be attributed while the agent registry is unavailable — retry when resolve_agent answers.";
    // 025's self-FK, said as update_thought says it, not as Postgres does (fourth review pass).
    case "REFUSED_SUPERSEDES_UNKNOWN": return "Refused: no thought with the id given as supersedes. Pass the id of an existing thought — the ID: line of a search result.";
    case "DERIVED_FROM_MISSING": {
      // The verb agrees with what is SAID: the plural leaked the count to a
      // non-reader through the placeholder (ninth review pass).
      const where = r.named.length
        ? r.named.map((n) => `derived_from[${n.position}] (${n.id})`).join(", ")
        : "a `derived_from` id";
      return `Refused: ${where} name${r.named.length > 1 ? "" : "s"} no thought. Each entry must be an existing thought id (the ID: line of a search result).`;
    }
    default: return unknownRefusal(r);
  }
}

/** capture_thought's value: the id, what the text was (a reader's only), and whether the vector's call was made. */
const safeCapture: Safe<Captured> = (v) => ({
  id: v.id, ...(v.existed === undefined ? {} : { existed: v.existed }),
  embeddingCall: v.embeddings.allowed, chunks: v.chunks, contextFailures: v.contextFailures,
  // The call was made and the provider did not answer (SMD-2888): its word
  // alone — not the endpoint, which a key that cannot read is not told.
  ...(v.vectorFailed ? { vectorFailed: v.vectorFailed.reason } : {}),
  // The outcome, and for a settle by a restamp whether the label is the
  // caller's — "settled" alone cannot say (review pass 1).
  ...(v.label ? { label: v.label.outcome, ...(v.label.outcome === "settled" && v.label.by === "restamp" ? { labelMine: v.label.mine } : {}) } : {}),
  // What became of a client_key (SMD-3314): a reader's alone, as only a reader may send one.
  ...(v.keyed ? { keyed: v.keyed, ...(v.heldKey ? { heldKey: v.heldKey } : {}) } : {}),
});

export function renderCapture(o: Outcome<Captured>): Reply {
  return render(o, (v) => {
    // A key that names a thought already (SMD-3314): that thought, nothing written.
    // Its text is another than the one sent: one holding this very text is a re-capture (`recaptured`), so a client
    // copying writes can tell a copy that diverged (review pass 2).
    if (v.keyed === "matched") return `Already captured — id ${v.id}: a thought there already has the \`client_key\` given as its id or its key, and holds other text than the one sent, so nothing was written and no model was called.`;
    const meta = v.tags;
    const { existed, reader, embeddings, chat, chunks, contextFailures } = v;
    // The id, because update_thought and delete_thought take one. Without it
    // an agent that captures a typo has to search for its own thought to fix
    // it, and the two new tools are only usable against things it did not
    // just write.
    // SMD-2510: the extracted tags on the one line, so a topic the model wrote
    // cannot start a `Captured as … id` line of its own.
    let confirmation = `Captured as ${metaText(meta.type, TYPE_MAX) || "thought"} — id ${v.id}`;
    const topics = metaList(meta.topics, TAG_MAX), people = metaList(meta.people, TAG_MAX), actions = metaList(meta.action_items, ACTION_MAX);
    if (topics.length) confirmation += ` — ${topics.join(", ")}`;
    if (people.length) confirmation += ` | People: ${people.join(", ")}`;
    if (actions.length) confirmation += ` | Actions: ${actions.join("; ")}`;

    // The gate's refusal first among the notes (SMD-1903): a thought
    // without its vector is the one fact a caller must not miss. Not an
    // error — the policy did what it says — but said in full. On a
    // RE-CAPTURE the row keeps the vector it had (upsert_thought
    // coalesces), so the note says that instead of "no vector" (first
    // review pass). A database from before 035 does not say which this was — and the coalesce holds
    // there too (033), so the note hedges rather than tell the fresh-row
    // story of a row that may be keeping its vector (second review pass).
    if (!embeddings.allowed) {
      confirmation += existed === true
        ? `\n\nNote: the embedding call for this capture was not made — ${embeddings.reason}. This text was already a thought, and it keeps the vector it had, if it had one.`
        : existed === false
          ? `\n\nNote: saved WITHOUT a vector — ${embeddings.reason}. ` +
            `It is findable by exact text (search_thoughts_keyword), and joins semantic search once the egress policy allows the call ` +
            `(a changed policy takes effect when the server restarts): the server then embeds it by itself (SMD-2889).`
          : `\n\nNote: the embedding call for this capture was not made — ${embeddings.reason}. A new thought has no vector — findable by exact text ` +
            `(search_thoughts_keyword), embedded by the server itself once the egress policy allows the call (a changed policy takes effect when the server restarts); text already captured keeps the vector it had. ` +
            // A key that cannot read is not told which (SMD-1298); a database
            // from before 035 cannot say.
            (reader ? `This database does not say which this was.` : `This reply does not say which.`);
    }
    // The call was allowed and made, and the provider did not answer
    // (SMD-2888): saved all the same, as a refused call's capture is, with
    // the endpoint and what happened there — to a reader. A key that cannot
    // read is not told the provider's address (rest/app.ts capturedFor), nor
    // whether the text was new.
    if (v.vectorFailed) {
      const { detail, base } = v.vectorFailed;
      const where = reader ? `the embedding provider at ${base} was unavailable (${detail})` : `the embedding provider was unavailable`;
      // The servers' vector mender embeds it once the provider answers (SMD-2889).
      const later = `the server embeds it by itself once the provider answers`;
      confirmation += existed === true
        ? `\n\nNote: no vector was made for this capture — ${where}. This text was already a thought, and it keeps the vector it had, if it had one.`
        : existed === false
          ? `\n\nNote: saved WITHOUT a vector — ${where}. It is findable by exact text (search_thoughts_keyword) now, and joins semantic search once it is embedded: ${later}.`
          : `\n\nNote: no vector was made for this capture — ${where}. A new thought has no vector — findable by exact text (search_thoughts_keyword) until it is embedded: ${later}; text already captured keeps the vector it had. ` +
            (reader ? `This database does not say which this was.` : `This reply does not say which.`);
    }

    confirmation += explainRecaptureLabel(v);
    // The text's row keeps another key (SMD-3314): this one names nothing here.
    if (v.keyed === "held") confirmation += `\n\nNote: this text was already a thought keeping a \`client_key\` of its own${v.heldKey ? ` (${v.heldKey})` : ""}, which it keeps; the key given here was not recorded, so it names no thought on this brain — name this one by its id, ${v.id}.`;

    // A chunk whose situating blurb could not be generated is embedded bare
    // and stored with a NULL context, which is a legitimate state and a
    // silent one. Saying so here is half of what keeps it from being silent
    // — preflight, which counts both kinds across the whole corpus, is the
    // other half.
    if (contextFailures > 0) {
      confirmation += chat.allowed
        ? `\n\nNote: ${contextFailures} of ${chunks} search chunks were embedded without ` +
          `their situating context — the call failed, or returned a blurb too long to be one. ` +
          // A capture-only key's re-capture writes no windows (080, SMD-2539),
          // and it is not told whether the text was new.
          // The endpoint to a reader only (SMD-2888 review pass 2).
          (reader ? `They are stored and searchable; re-capture to regenerate, or check the model at ${chat.base}.` : `A new thought stores them so, searchable; text already captured gets none of them. The operator can check the chat model.`)
        // The blurbs are chat calls, and the gate refused the chat endpoint
        // (SMD-1903): not a model to check, and the reason is the one the
        // tagging note below carries.
        : `\n\nNote: the ${chunks} search chunks were embedded without their situating context — ` +
          `the blurb calls were not made: ${chat.reason}. ${reader ? "They are stored and searchable." : "A new thought stores them so, searchable; text already captured gets none of them."}`;
    }
    confirmation += explainHeadWindow(v.headWindow, reader);

    // Migration 035 (SMD-1453): a re-capture writes no provenance. The text
    // was already a thought, so the derived_from / supersedes named here
    // were not written; say so and name the edit that records it, since
    // otherwise nothing would — the trace would show nothing and no
    // error would say why.
    if (v.recapture) {
      const { derivedNamed, current } = v.recapture;
      const named = [derivedNamed ? "`derived_from`" : null, v.recapture.given !== undefined ? "`supersedes`" : null].filter(Boolean);
      // Postgres hands ids back lower-case; the shape check admits either
      // case, so compare — and print — the caller's in lower case (third
      // review pass: an upper-case self-pointer slipped past to an edit
      // update_thought refuses). What stands is the row's pointer the store
      // returned beside `existed` (035), not the caller's inputs alone (second
      // review pass).
      const given = v.recapture.given?.toLowerCase();
      const advice = given === undefined ? ""
        : given === v.id ? ` The \`supersedes\` given names the thought itself; a thought cannot supersede itself.`
        : current === given ? ` It already supersedes ${given}; there is nothing to record.`
        : current !== null ? ` It currently supersedes ${current}; to replace that pointer with ${given}, call update_thought with id ${v.id} and \`supersedes\` ${given}; it records the pointer if that thought exists and closes no loop.`
        : ` To record that it supersedes ${given}, call update_thought with id ${v.id} and \`supersedes\` ${given}; it records the pointer if that thought exists and closes no loop.`;
      confirmation +=
        `\n\nNote: this text was already captured as ${v.id}, so the ${named.join(" and ")} given here ${named.length > 1 ? "were" : "was"} not written — ` +
        `a re-capture leaves an existing thought's provenance as it is.` + advice +
        (derivedNamed ? ` \`derived_from\` cannot be set on an existing thought through these tools.` : "");
    }

    // Tell the user when tags are placeholders rather than real extraction,
    // so a broken credential does not look like a successful capture. The
    // remedy names the endpoint the tagging call dialled — the chat one,
    // which since SMD-1902 need not be where the embedding went.
    if (meta.metadata_extraction_failed === "egress_denied") {
      // Not a failure to check the endpoint for: the call was not made.
      // The reason is the decision made here; providerCall's own refusal
      // (the belt) reaching this branch would mean the two disagreed,
      // which the shared function makes impossible — but say so rather
      // than print an "allowed" sentence under a refusal.
      const why = chat.allowed ? "the egress gate refused the tagging call" : chat.reason;
      confirmation += existed === true
        ? `\n\nNote: the tagging call for this capture was not made — ${why}. The existing thought keeps its tags; its metadata now carries the refusal marker.`
        : existed === false
          ? `\n\nNote: no topics, people or type were extracted — ${why}.`
          // `existed` unsaid: a key that cannot read, whose re-capture merges
          // nothing (080, SMD-2539), or a database before 035, which merges.
          : `\n\nNote: the tagging call for this capture was not made — ${why}. A new thought has no topics or type; text already captured keeps its tags${reader ? ", with the refusal marker merged in" : ""}.`;
    } else if (typeof meta.metadata_extraction_failed === "string" && meta.topics === undefined && meta.type === undefined) {
      // The marker alone: the chat provider did not answer (metadataUnavailable,
      // SMD-2888), so no tags were made — none, not placeholders, so a
      // re-capture during the outage leaves an existing thought's tags as they
      // were. The endpoint to a reader only, as the vector's note.
      const word = metaText(meta.metadata_extraction_failed, TYPE_MAX);
      const why = reader ? `the chat provider at ${chat.base} was unavailable (${word})` : `the chat provider was unavailable (${word})`;
      confirmation += existed === true
        ? `\n\nNote: no tags were extracted for this capture — ${why}. The existing thought keeps its tags; its metadata now carries the marker.`
        : existed === false
          ? `\n\nNote: no topics, people or type were extracted — ${why}.`
          : `\n\nNote: no tags were extracted for this capture — ${why}. A new thought has no topics or type; text already captured keeps its tags${reader ? ", with the marker merged in" : ""}.`;
    } else if (typeof meta.metadata_extraction_failed === "string") {
      confirmation +=
        // A key that cannot read is not told whether the text was new, and
        // its re-capture saves nothing onto an existing thought (080,
        // SMD-2539), so its note says the capture's tagging failed, not that
        // a thought was saved (review pass 3).
        `\n\nNote: ${reader ? "the thought was saved, but automatic tagging failed" : "automatic tagging failed for this capture"} ` +
        // The marker is the server's reason code (extractMetadata keeps a
        // model's own out of the tags), on the one line all the same (SMD-2510).
        `(${metaText(meta.metadata_extraction_failed, TYPE_MAX)}) — ${reader ? "topics and people are placeholders" : "a new thought's topics and people are placeholders; text already captured keeps its tags"}. ` +
        // The endpoint to a reader only: a key that cannot read is not told
        // the provider's address (rest/app.ts capturedFor; SMD-2888 review pass 1).
        (reader ? `Check the chat endpoint (${chat.base}), its credential, and the server logs.` : `The operator can check the chat endpoint, its credential, and the server logs.`);
    }
    return confirmation;
  }, captureRefusal, safeCapture);
}

/**
 * Turn an edit's or a delete's refusal into something the caller can act on.
 * A stale read is not a fault — it is a race the caller can resolve by
 * refetching — so the message says what to do rather than only what went wrong.
 */
function mutationRefusalText(r: Refusal): string {
  switch (r.code) {
    case "REFUSED_NOTHING_TO_UPDATE": return "Provide `content`, `metadata_patch`, `supersedes`, or any of them — an update with none would do nothing.";
    case "REFUSED_METADATA_SHAPE": return metadataShape(r);
    case "REFUSED_SUPERSEDES_SHAPE": return supersedesShape(r.value, r.orNull);
    case "NOT_FOUND":
      return `No thought with id ${r.id}. It may already have been deleted — check the audit trail, which keeps the previous content.`;
    case "REFUSED_STALE_READ":
      return `Refused: ${r.id} changed after the if_unchanged_since you passed${
        r.currentUpdatedAt ? ` (it is now ${r.currentUpdatedAt})` : ""
      }. Re-read the thought and retry, so you amend the current text rather than overwrite someone else's edit.`;
    case "REFUSED_DUPLICATE_CONTENT":
      return `Refused: that text already exists as another thought, and two identical thoughts would break deduplication. Edit one of them, or delete the other first.`;
    // Migration 032: the provenance envelope.
    case "REFUSED_SUPERSEDES_UNKNOWN":
      return `Refused: no thought with the id given as supersedes. Pass the id of an existing thought — the ID: line of a search result — or null to clear the pointer.`;
    case "REFUSED_WOULD_CYCLE":
      return `Refused: that supersedes pointer would close a loop — the thought named already supersedes ${r.id}, directly or through a chain (or is ${r.id} itself). A version chain runs one way; point the newer thought at the older, or clear the older's pointer first.`;
    // Migration 042: statements in other thoughts rest on this one. The rows
    // are the function's sample (ten, newest first); the count is the whole.
    case "REFUSED_CITED": {
      const id = r.id;
      const rows = (r.citations ?? []).map((c) => `  - ${c.thoughtId} (${c.stance}): ${snipText(c.text, 120)}`);
      const total = r.citedBy ?? rows.length;
      const more = total - rows.length;
      // One subject, one way through, three shapes: the number and its grammar
      // spelled once (seventh review pass).
      const one = total === 1;
      const subject = `${total} citation${one ? "" : "s"} on other thoughts rest${one ? "s" : ""} on ${id} as ${one ? "its" : "their"} source`;
      const through = `To delete anyway, pass detach_citations: true`;
      const reread = `re-read the thought (fetch takes the id) before deciding. ${through}.`;
      // The count and rows come from the guard's own refusal (042 carries them
      // in the error), so a CITED envelope with neither is one the function did
      // not write — a proxy, a truncated body. Say so rather than "0 citations".
      if (total <= 0) return `Refused: other thoughts cite ${id} as their source, but the reply carried no count and no citing rows — ${reread}`;
      // A count with no rows (a proxy that dropped the array): no list, no
      // dangling colon, the same advice.
      if (rows.length === 0) return `Refused: ${subject}, but the citing rows were not returned — ${reread}`;
      return `Refused: ${subject} — deleting it would leave ${one ? "that statement" : "those statements"} resting on nothing:\n${rows.join("\n")}${more > 0 ? `\n  …and ${more} more` : ""}\nRead the citing thoughts first (fetch takes the id). ${through} — each citation keeps its text and stance, loses its source, and records ${id} and the time as the deleted source.`;
    }
    case "REFUSED": return `Refused: ${r.error}`;
    default: return unknownRefusal(r);
  }
}

/**
 * The two things migration 018 reports on a successful edit that the caller
 * should hear about: the edit's unchanged text is also another thought's, or
 * another thought's stale fingerprint blocks this one's. Neither says which
 * row is older — a capture merged around a legacy row produces the same pair —
 * so neither tells the caller which to delete.
 */
function explainPair(r: { duplicateOf?: string; fingerprintHeldBy?: string }): string {
  if (r.duplicateOf) {
    return `\nNote: this thought holds the same text as ${r.duplicateOf}. Deduplication could not see this one because it had no fingerprint, so the edit was kept and no fingerprint was written. Read both before deciding whether they should be one thought; delete_thought keeps the removed text in the audit trail.`;
  }
  if (r.fingerprintHeldBy) {
    return `\nNote: ${r.fingerprintHeldBy} carries a stale fingerprint for this text under different content, so this thought could not take its own. Re-saving that thought's text corrects it.`;
  }
  return "";
}

/** update_thought's value: what moved, and the pointers and pair it reports — ids, flags and counts. */
const safeUpdate: Safe<Updated> = (v) => ({
  id: v.id, ...(v.byClientKey ? { byClientKey: v.byClientKey } : {}), updatedAt: v.updatedAt ?? null, contentChange: v.contentChange, metadataMerged: v.metadataMerged,
  // The keys alone: the values are the row's, a name not a token.
  ...(v.kept?.length ? { kept: v.kept.map((k) => k.key) } : {}),
  ...(v.supersedes !== undefined ? { supersedes: v.supersedes } : {}),
  contextFailures: v.contextFailures,
  ...(v.duplicateOf ? { duplicateOf: v.duplicateOf } : {}),
  ...(v.fingerprintHeldBy ? { fingerprintHeldBy: v.fingerprintHeldBy } : {}),
});

/**
 * The stamp keys a patch named and the row kept (SMD-2744): which, at what,
 * and why — so a `trust` patch on an unchanged text no longer reads as merged
 * — and the ways the label does move. The values are the row's, which a raw
 * writer may plant: the kind and the trust held to their word lists, the
 * name through snipText.
 */
function explainKept(v: Updated): string {
  if (!v.kept?.length) return "";
  const shown = (k: KeptKey): string => {
    if (!k.present) return `${k.key} is unset`;
    const val = k.key === "actor_kind" ? oneOf(SAID_BY, k.value) : k.key === "trust" ? oneOf(TRUST, k.value) : k.value === null ? null : snipText(k.value, 80);
    return `${k.key} is ${val || "not a recognised value"}`;
  };
  const trustKept = v.kept.some((k) => k.key === "trust");
  return `\n\nNote: not taken from the patch — ${v.kept.map(shown).join("; ")}. A thought's actor_kind and actor_name are those of the key that wrote its current text (or re-captured it over a capture-only key's), set by the server, and its trust the one that write declared, else the key's kind: at most the key's kind (a key with no kind supports only ingested; the operator classifies keys with set_agent_kind). An edit that leaves the text — letter case and runs of whitespace aside — keeps all three.`
    // How a trust is set, to the caller as it stands (review passes 2-7):
    // one who sent no text is told the way; one whose text counts as the
    // same (088's verdict) that it does; one whose text changed why the word
    // it sent was not taken — no stamp, no kind, above the kind, no word.
    + (!trustKept ? ""
      : v.contentChange === null ? " To set the trust — no higher than your key's kind — send it with a change of the text; your key then becomes the thought's writer, its actor_kind and actor_name."
      : v.sameText !== false ? " The text you sent counts as the same — letter case and runs of whitespace aside — so the thought keeps its trust: change the text to set one, no higher than your key's kind."
      : v.stampGap === "not_object" ? " The thought's metadata is not an object (a raw writer's), so the change of text wrote no stamp."
      : v.stampGap === "no_kind" ? " Your key has no kind: it supports only a declared ingested, so the thought keeps no trust (the operator classifies keys with set_agent_kind)."
      : oneOf(TRUST, v.trustSent) !== null ? " A trust above your key's kind is held to it."
      : typeof v.trustSent === "string" ? ` "${snipText(v.trustSent, 40)}" is not a trust (ingested, agent or operator), so the change of text took your key's own.`
      : " A null or a non-string trust declares nothing, so the change of text took your key's own.")
    // A change of text makes the caller the writer: no capture's label left
    // to reset (review pass 7).
    + (v.sameText === false ? "" : " If a capture-only key captured this text and another key's re-capture settled or moved its label, an operator key's reset_capture_stamp puts it back.");
}

/** The keys a patch named that a NULL metadata dropped, and how they merge. */
function droppedText(v: Updated): string {
  const others = Boolean(v.kept?.length || v.metadataMerged);
  return `${v.metadataMerged ? "trust taken; " : ""}${others ? "the patch's other keys" : "the patch"} not merged: the thought's metadata was SQL NULL, a raw writer's — ${
    v.sameText === false ? `the change of text gave it metadata, so send ${others ? "those keys" : "the patch"} again` : "a change of the text gives it metadata, after which the patch merges"}`;
}

export function renderUpdate(o: Outcome<Updated>): Reply {
  return render(o, (v) => {
    const what = [
      v.contentChange === "reembedded" ? "content re-embedded" : v.contentChange === "no_vector" ? "content saved without a vector" : null,
      // Of the patch, not the row: a change of text restamps the row even
      // when the patch's stamp keys were not taken (review pass 1 of PR 2).
      v.patchDropped ? null : v.metadataMerged ? "metadata merged" : v.metadataEcho ? "metadata unchanged: it already held what the patch named" : null,
      v.kept?.length ? `${v.kept.map((k) => k.key).join(", ")} not taken` : null,
      // A row whose metadata was SQL NULL (a raw writer's) merges no patch; a
      // change of text writes the stamp over it, a trust the patch declared
      // taken (review pass 6), after which the same keys merge — said last,
      // its clause its own (review pass 7: "cannot merge into" read as never).
      v.patchDropped ? droppedText(v) : null,
      v.supersedes === null ? "supersedes cleared" : v.supersedes !== undefined ? `now supersedes ${v.supersedes}` : null,
      // An edit replaces every chunk, so a failure here leaves the SAME
      // half-contextualized state a capture can, and is worth the same
      // sentence rather than a silent partial rewrite.
      v.contextFailures ? `${v.contextFailures} chunks without context` : null,
    ].filter(Boolean).join(", ");
    return `Updated ${v.id}${v.byClientKey ? `, named by its client_key ${v.byClientKey}` : ""} (${what}).\nupdated_at: ${v.updatedAt}\nPass that value as if_unchanged_since on your next edit.${explainPair(v)}${explainHeadWindow(v.headWindow)}${explainKept(v)}${
      v.noVectorReason !== undefined
        ? `\n\nNote: saved WITHOUT a vector — ${v.noVectorReason}. It is findable by exact text, and joins semantic search once the egress policy allows the call (a changed policy takes effect when the server restarts): the server then embeds it by itself (SMD-2889).`
        : ""}`;
  }, mutationRefusalText, safeUpdate);
}

/**
 * What a successful delete did to the citations that named the thought
 * (migration 042): the active ones it detached — only when asked — and the
 * expired or superseded ones it marked in either mode. Silent when neither.
 */
function explainDetached(r: Deleted): string {
  const parts: string[] = [];
  if (r.detached) parts.push(`${r.detached} citation${r.detached === 1 ? "" : "s"} on other thoughts rested on it and ${r.detached === 1 ? "was" : "were"} detached: each keeps its text and stance and records ${r.id} as its deleted source.`);
  if (r.inactive) parts.push(`${r.inactive} expired or superseded citation${r.inactive === 1 ? "" : "s"} that named it ${r.inactive === 1 ? "was" : "were"} marked with the deletion.`);
  return parts.length ? ` ${parts.join(" ")}` : "";
}

export function renderDelete(o: Outcome<Deleted>): Reply {
  return render(o, (v) => `Deleted ${v.id}${v.byClientKey ? `, named by its client_key ${v.byClientKey}` : ""}. Its previous content is preserved in the audit trail.${explainDetached(v)}`,
    mutationRefusalText, (v) => ({ id: v.id, ...(v.byClientKey ? { byClientKey: v.byClientKey } : {}), detached: v.detached ?? 0, inactive: v.inactive ?? 0 }));
}

/**
 * A row's three stamp keys as one phrase: name, kind and trust, a key it
 * lacks said so. The row's metadata is a raw writer's to plant, so the kind
 * and the trust are held to their word lists, as every reply holds them
 * (review pass 1), and the name goes through snipText.
 */
const stampText = (s: ActorStamp): string =>
  `${s.actorName !== null ? snipText(s.actorName, 80) : "no key"} — kind ${oneOf(SAID_BY, s.actorKind) ?? "not classified"}, trust ${oneOf(TRUST, s.trust) ?? "none"}`;

/**
 * reset_capture_stamp's reply (086, SMD-2744): what the reset cleared and the
 * label it left, then the step it exists for — the caller's re-capture, which
 * the next key to land would otherwise be weighed in place of. Both outcomes
 * of that re-capture are named, and the text it must carry: fetch shows an
 * outside text under the notice line, and a re-capture of that line and the
 * text is a new thought, not this one (walkthrough, review pass 1).
 */
export function renderResetCaptureStamp(o: Outcome<StampReset, StampResetCode>): Reply {
  return render(o, (v) => {
    if (!v.reset) return `Nothing to reset on ${v.id}: no re-capture has settled or moved its label since its capture or its last reset (a re-capture is weighed only while the text is the one captured). Its label: ${stampText(v.stamp)}.`;
    // The caller's own move or keep said so (review pass 3: a client cannot
    // tell its own key's name from another's).
    const mine = (n: string) => n.trim() === v.caller.trim();
    const whose = (n: string) => (mine(n) ? `yours (${snipText(n, 80)})` : snipText(n, 80));
    const mover = v.movedBy === null ? "a" : mine(v.movedBy) ? `your key's (${snipText(v.movedBy, 80)})` : `${snipText(v.movedBy, 80)}'s`;
    const what = [
      v.restored ? `the label ${mover} re-capture moved is back to the capture-only key's` : null,
      v.declines ? `${v.declines} decline${v.declines === 1 ? "" : "s"}${v.declinedBy.length ? ` (by ${v.declinedBy.map(whose).join(", ")})` : ""} no longer count${v.declines === 1 ? "s" : ""}` : null,
    ].filter(Boolean).join(", and ");
    const keptByCaller = v.declinedBy.some(mine);
    // The ways on, by the trust the row is left at: 085 moves the label only
    // to a classified re-capture whose trust ranks strictly above it, and
    // records any other as a decline that settles the row against every
    // other key — the same key's own later re-capture is still weighed
    // (review passes 2 and 3: one wording for every label was false at the
    // ends of the ladder, and "settled" overclaimed for the operator's own).
    const trust = oneOf(TRUST, v.stamp.trust);
    const head = `Reset ${v.id}: ${what}. Its label: ${stampText(v.stamp)}.`;
    if (trust === "operator")
      return `${head}\nNo re-capture can move this label: no key's trust outranks operator. A text edit (update_thought) is what stamps the thought as yours.`;
    const ways = trust === null
      ? ["- the label has no trust, so a re-capture by any classified key moves it: plainly, to your key at trust operator;",
         "- with trust \"ingested\": to your key at trust ingested, kept outside text. Either settles the row."]
      : [`- plainly: the label moves to your key at trust operator${trust === "ingested" ? " — the outside-text notice goes, and min_trust searches include it" : ""}.`,
         trust === "ingested"
           ? "- with trust \"ingested\": the label stays as it is, outside text, and the row is settled against every other key — the way to keep outside text another key lifted labelled as outside text (your own key's later plain re-capture still moves it)."
           : `- with trust "ingested": the label stays at ${trust} and the row is settled against every other key (it does not mark the text as outside text; your own key's later plain re-capture still moves it).`];
    // fetch shows an ingested row under the outside-text notice, which is not
    // the stored text; other rows it shows as stored.
    const asStored = trust === "ingested"
      ? "exactly as stored — fetch shows this outside text under a notice line that is not part of it (REST GET /v1/thoughts/{id} gives the content alone)"
      : "exactly as stored (fetch's text)";
    return `${head}\n`
      + (keptByCaller ? "This undid your own key's keep: re-capture with trust \"ingested\" to keep it again.\n" : "")
      + `Re-capture the text with your key now, ${asStored}:\n${ways.join("\n")}\n`
      + "Until you do, the next classified key that can read to re-capture it is the one weighed. fetch's label, or thought_changes, shows which way it went.";
  }, (r) => {
    switch (r.code) {
      case "REFUSED_NOT_OPERATOR": {
        // The fix depends on what the key is (review pass 2): an unclassified
        // key may be the operator's, and its line is given; a key classified
        // otherwise is someone else's, and classifying it operator would
        // raise the trust of everything it writes.
        const key = snipText(r.key, 80);
        const lead = "Refused: only a key the operator classified `operator` may reset a label, and not a capture-only key.";
        if (r.kind === "capture-only") return `${lead} This key, ${key}, is capture-only.`;
        // The line only for a name set_agent_kind takes as written — no
        // control character, nothing it trims — or the line would classify
        // another label (review pass 3: a mangled name created an operator row).
        const exact = /^[^\u0000-\u001f\u007f\s](?:[^\u0000-\u001f\u007f]*[^\u0000-\u001f\u007f\s])?$/.test(r.key);
        if (r.kind === null) return `${lead} This key, ${key}, is unclassified. If it is the operator's own, classify it${exact ? `: SELECT set_agent_kind('${r.key.replace(/'/g, "''")}', 'operator')` : " with set_agent_kind and the key's exact name"} (db/README.md).`;
        return `${lead} This key, ${key}, is classified ${oneOf(SAID_BY, r.kind) ?? "otherwise"}: use the operator's own key — classifying this one operator would raise the trust of everything it writes.`;
      }
      case "REFUSED_NOT_CAPTURE_STAMP": return `Refused: ${r.id}'s label is not one a reset can put back — a capture-only key did not capture it (or captured it before the server marked such captures), or its text was changed since. Its label is its writer's: a text edit restamps it.`;
      default: return mutationRefusalText(r);
    }
  }, (v) => ({ id: v.id, reset: v.reset, restored: v.restored, declines: v.declines, actorKind: oneOf(SAID_BY, v.stamp.actorKind), trust: oneOf(TRUST, v.stamp.trust) }));
}

/** reset_capture_stamp's fault: a database before 086 has no such function. */
export const resetHint = (msg: string): string =>
  /ob1_reset_capture_stamp/.test(msg) && /does not exist|could not find/i.test(msg)
    ? " — migration 086 (db/migrations/086_capture_stamp_reset.sql) is not applied"
    : "";

// ── review_supersession_proposal (SMD-3338) ──────────────────────────────────

/**
 * Who the row records as deciding it (114, SMD-2608): the key's name and its
 * kind — the kind it had when it decided, else the registry's now, said so —
 * a decision with no agent id said so, none recorded said so. The name
 * through the replies' cleaner, on one line; yours said so.
 */
export function reviewerText(r: Reviewer | null, caller?: string): string {
  if (!r || (!r.name && !r.agentId)) return "not recorded — no actor named the decision";
  const kind = r.kind ?? (r.kindNow ? `${r.kindNow} — classified after it decided` : "a key the registry has not classified");
  const name = r.name ? `${snipText(r.name, 80)}${caller !== undefined && r.name.trim() === caller.trim() ? " (your key)" : ""}` : null;
  return name && r.agentId ? `${name}, ${kind}` : name ? `${name}, no agent id recorded (the key did not resolve in the registry)` : `agent ${r.agentId}, ${kind}, no name`;
}

/**
 * review_supersession_proposal's reply (SMD-3338): what the decision wrote or
 * cleared, a second write the caller did not ask for — a capture-only
 * pointer the accept's lapse cleared (082) — each named, and who the row
 * records as deciding it. A refusal names its check, what waives it, and the
 * decision expected instead, in the CLI's words with the tool's arguments.
 */
export function renderReviewProposal(o: Outcome<ProposalReview, ProposalReviewCode>): Reply {
  return render(o, (v) => {
    // A reject says what it undid of an accept, and what it did not — the
    // pointer the accept found there, one changed since, a capture-only
    // pointer its lapse cleared — and that it replaced an earlier reject
    // (review pass 2: each read "Rejected proposal X." alone).
    const pair = `${v.supersedingId} no longer supersedes ${v.supersededId}`;
    const head = v.decision === "accept"
      ? `Accepted proposal ${v.id}: ${v.supersedingId} now supersedes ${v.supersededId}${v.written ? "" : " (the pointer already held that value, and a reject will leave it)"}.`
      : v.previousStatus === "accepted"
        ? v.cleared
          ? `Rejected proposal ${v.id}, which was accepted: the supersedes pointer its accept wrote is cleared (${pair}). A capture-only pointer that accept cleared stays cleared.`
          : v.previousPointerWritten === false
            ? `Rejected proposal ${v.id}, which was accepted: ${v.supersedingId}'s pointer onto ${v.supersededId} was there before the accept, so it stays — update_thought's supersedes: null clears it if it is wrong.`
            : `Rejected proposal ${v.id}, which was accepted: ${v.supersedingId}'s pointer was changed since, so there was nothing of the accept's to clear.`
        : v.previousStatus === "rejected"
          ? `Rejected proposal ${v.id} again: this decision, its note and its reviewer replace the earlier reject's.`
          : `Rejected proposal ${v.id}.`;
    const lapsed = v.lapsed.map((l) => `Lapsed: ${l.id} no longer supersedes ${l.onto} — its capturer's capture-only pointer, cleared by this accept; a reject of this proposal does not restore it.`);
    const unread = v.writersUnread ? ["The WRITER check did not run: this brain is short of migration 094 (cd db && bun migrate.ts --url <url>)."] : [];
    const by = v.reviewerRecorded ? `Decided by: ${reviewerText(v.reviewer, v.caller)}.` : "The row records no reviewer: this brain is short of migration 114 (cd db && bun migrate.ts --url <url>); the audit trail names the key of an accept's write.";
    return [head, ...lapsed, ...unread, by].join("\n");
  }, (r) => {
    const force = "pass force: true if the accept still holds";
    switch (r.code) {
      // The id quoted, bounded, on one line: a non-uuid one is the caller's own text (review pass 1).
      case "NOT_FOUND": return `No proposal with id ${JSON.stringify(snipText(r.id, 80))}, or a thought it names is gone — list_supersession_proposals gives the proposal ids (not the thoughts').`;
      case "REFUSED_EDITED_SINCE":
        return `Refused: the ${r.olderEdited && r.newerEdited ? "older and newer thoughts have" : r.olderEdited ? "older thought has" : "newer thought has"} been edited since the pair was judged (a stale proposal's has), so the verdict is about a text that is gone. Read both (fetch takes their ids) and ${force}, or reject it.`;
      // Force is no remedy here, only a choice to write the harm (review pass 2): said so.
      case "REFUSED_LINEAGE_PAIR":
        return `Refused: one side's derived_from names the other — a derivation and its input, a pair the pass never proposes since 066; accepting archives the input while the derivation still names it. ${r.status === "rejected" ? "Left as it is, it stays rejected, the expected decision" : "Rejecting it is the expected decision"}. force: true writes the pointer anyway, and the derivation then names an input search treats as superseded — only if that is what you mean (with a direction on an undirected verdict)${r.flags.length ? `; it also accepts over its WRITER flag: ${r.flags.map(standingFlagText).join("; ")}` : ""}.`;
      case "REFUSED_WRITER": {
        const lapses = { older: { lapses: Array(r.lapses.older) }, newer: { lapses: Array(r.lapses.newer) } };
        return `Refused: ${writerFlagsText(r.flags, lapses).replaceAll("--direction", "direction")}. Read both writers (list_supersession_proposals with status ${r.status}) and ${force}${r.edited ? " (force also accepts over a text edited since judged)" : ""}${r.status === "rejected" ? "; left as it is, it stays rejected" : ", or reject it"}.`;
      }
      case "REFUSED_REVIEW_ARGUMENT":
        return r.problem === "direction_on_reject" ? "Refused: direction goes with an accept — it picks the side that stands; a reject takes none."
          : r.problem === "force_on_reject" ? "Refused: force goes with an accept — it waives an accept's checks; a reject has none to waive."
          : `Refused: a note may not begin with "${PASS_SETTLED_PREFIX}" — that marker is the consolidation pass's own (migration 067), and a rejection carrying it is read as the pass's and set stale again when a text moves.`;
      case "REFUSED_DIRECTION_REQUIRED": return `Refused: the judge did not say which is current (${r.verdict}); pass direction: "newer" or "older".`;
      case "REFUSED_ALREADY_ACCEPTED": return `Refused: proposal ${r.id} is already accepted (its pointer is ${r.supersedingId}'s). A reject first clears that pointer if it still holds this proposal's value — not one that was there before the accept, nor a capture-only pointer the accept cleared — and the proposal can then be accepted again.`;
      case "REFUSED_ALREADY_SUPERSEDES": return `Refused: ${r.supersedingId} already supersedes a third thought, ${r.currentId}; the column holds one predecessor, so decide which — edit that thought (update_thought's supersedes), or reject this proposal.`;
      case "REFUSED_PROPOSAL_WOULD_CYCLE": return r.chainTooLong
        ? `Refused: the supersedes chain below ${r.supersededId} is longer than update_thought walks (1000 thoughts), so whether ${r.supersedingId}'s pointer would close a loop cannot be told. Reject this proposal, or shorten the chain first.`
        : `Refused: writing ${r.supersedingId}'s pointer onto ${r.supersededId} would close a loop — ${r.supersededId} already supersedes it, directly or through a chain. Reject this proposal, or clear the other pointer first.`;
      case "REFUSED_SUPERSEDED_GONE": return `Refused: ${r.supersededId} no longer exists, so there is nothing to supersede; reject this proposal.`;
      default: return mutationRefusalText(r);
    }
  }, (v) => ({
    id: v.id, decision: v.decision, status: v.status, previousStatus: v.previousStatus, previousPointerWritten: v.previousPointerWritten, forced: v.forced, supersedingId: v.supersedingId, supersededId: v.supersededId,
    written: v.written, cleared: v.cleared, lapsed: v.lapsed,
    reviewer: v.reviewer ? { agentId: v.reviewer.agentId, kind: oneOf(SAID_BY, v.reviewer.kind), kindNow: oneOf(SAID_BY, v.reviewer.kindNow) } : null,
    reviewerRecorded: v.reviewerRecorded, writersUnread: v.writersUnread,
  }));
}

/**
 * review_supersession_proposal's fault: the review function runs as the
 * caller (029, SECURITY INVOKER), so a server role without UPDATE on
 * supersession_proposals — the server group's since SMD-3338 — is refused the
 * decision; a database before 029 has no queue.
 */
export const reviewHint = (msg: string): string =>
  /permission denied for (table|relation) supersession_proposals/.test(msg)
    ? " — this server's database role may not decide a proposal: add the server group to its grants (cd db && bun migrate.ts --url <the owner's connection> --grant <role> --groups server), which holds UPDATE on supersession_proposals since SMD-3338"
    : /review_supersession_proposal|supersession_proposals/.test(msg) && /does not exist|could not find/i.test(msg)
      ? " — migration 029 (db/migrations/029_supersession_proposals.sql) is not applied"
      : "";

// ── The worker actions (SMD-2283 PR 3) ───────────────────────────────────────
// Each answers its result as JSON, the value itself beside it; a refusal its
// sentence, the code and `retryable` beside it, as it always did. Each table
// words every code its action refuses with (core/workers.ts), and no other.

/** A worker action's reply: its JSON, the value beside it; a refusal in the table's words, which take their codes from the outcome's own. */
const renderWorker = <T extends object, C extends RefusalCode>(o: Outcome<T, C>, words: Record<NoInfer<C>, string>): Reply =>
  render(o, (v) => JSON.stringify(v), (r) => words[r.code as C] ?? unknownRefusal(r), AS_JSON);

export const renderRetryFailed = (o: Outcome<RetryFailedResult, RetryFailedCode>): Reply => renderWorker(o, {
  REFUSED_EMPTY_WORK_TYPE: "Refused: work_type is required — pass the exact `workType` worker_status reports for the pool to retry.",
});

export const renderReleaseStaleLeases = (o: Outcome<ReleaseLeasesResult, ReleaseLeasesCode>): Reply => renderWorker(o, {
  REFUSED_EMPTY_WORK_TYPE: "Refused: work_type was given but blank — omit it to reap across all pools, or pass a real `workType`.",
  REFUSED_LIVE_LEASE_NEEDS_WORKER: "Refused: include_live releases a lease that has not lapsed, which risks the holder double-processing — name the worker_id whose live lease to release (worker_status reports the holder).",
});

export const renderRunWorker = (o: Outcome<DryRunClaimResult, RunWorkerCode>): Reply => renderWorker(o, {
  REFUSED_EMPTY_WORK_TYPE: "Refused: work_type is required — pass the exact `workType` worker_status reports for the pool to drain.",
  RUN_WORKER_DRAIN_NOT_AVAILABLE: "Refused: the executing drain is not yet available — the server does not run the bulk LLM passes, and the drain will land on a callable worker core (SMD-2304). Call with dry_run: true to preview what a pass would claim.",
});
