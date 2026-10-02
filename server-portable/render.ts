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
// shapes, the pages, the job records) answers the value itself, which says
// exactly what its text does. The core's values keep everything, for the REST
// core (SMD-2284).

import { displayDate } from "./thoughts.ts";
import { cleanForDisplay } from "./consolidate.ts";
import type { AuditChange, LoggedSearchPage, ThoughtHybridMatch, ThoughtIdPage, ThoughtStats } from "./store.ts";
import type { JobHandle, PublicJob } from "./jobs.ts";
import { renderBrainInfo, type BrainInfo } from "./brain-info.ts";
import { SAID_BY } from "./core/filter.ts";
import { failure, ok, type Outcome, type Refusal } from "./core/refusal.ts";
import type { ChangesResult, FetchedThought, KeywordResult, ListThoughtsResult, ProposalsResult, SearchResult, SearchThoughtsResult, WorkerStatusResult } from "./core/reads.ts";

/** A tool's reply: the text a model reads and the typed answer a program reads (SMD-1978's `structuredContent`, now every tool's). */
export type Reply = { content: { type: "text"; text: string }[]; isError?: true; structuredContent: Record<string, unknown> };

/** A prose tool's safe fields, picked from its value — ids, timestamps, numbers, booleans, enum codes; `guard` holds every string to that. */
type Safe<T> = (v: T) => object;
/** A tool whose text is its value's JSON: the value itself (the spec's structured-plus-serialized shape). */
const AS_JSON = Symbol("the value is the text's JSON");
/** brain_info: its whole record beside the table — the server's and the database's own facts, versions included, so not held to tokens. */
const AS_RECORD = Symbol("the value is the server's own record");

/** An outcome in the tool's words — its value's text, or its refusal's — with the text inside the value, last, so no field can stand in for it. */
function render<T extends object>(o: Outcome<T>, value: (v: T) => string, refusal: (r: Refusal) => string, safe: Safe<T> | typeof AS_JSON | typeof AS_RECORD): Reply {
  if (!o.ok) {
    const text = refusal(o.refusal);
    return { content: [{ type: "text", text }], isError: true, structuredContent: { ...(guard(safeRefusal(o.refusal)) as object), text } };
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
const ID_KEY = /^(?:id|after|cursor|supersededBy|supersedesBefore|supersedesAfter)$|Id$/;

/**
 * The rule at the chokepoint (review pass 6): every string a picker hands over
 * is held to the shape its field's name promises — a time, a uuid, or one enum
 * token — and any other string becomes null. A picker that lists a field whose
 * type says timestamp but whose source is a thought's metadata (prefer_current's
 * `window.syncedAt`, `max(metadata->>'linear_updated_at')` over the corpus)
 * cannot carry a sentence through: the guard reads the value, not the type.
 */
function guard(v: unknown, key = ""): unknown {
  if (typeof v === "string") return (TIME_KEY.test(key) ? TIME : ID_KEY.test(key) ? UUID : TOKEN).test(v) ? v : null;
  if (Array.isArray(v)) return v.map((x) => guard(x, key));
  if (v !== null && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, guard(x, k)]));
  return v;
}

/**
 * A refusal's safe fields: its code, whether a retry can help, and the egress
 * rule's token. The facts a sentence was built from — a caller's own `since`
 * or id, a filter's message, the gate's reason — are in the text, bounded.
 */
function safeRefusal(r: Refusal): object {
  return { code: r.code, retryable: r.retryable, ...(r.code === "REFUSED_EGRESS" ? { rule: r.rule } : {}) };
}

/** A refusal a tool's renderer has no sentence for — a code it does not return. Not reached; said rather than thrown. */
const unknownRefusal = (r: Refusal) => `Refused: ${r.code}`;

/**
 * A fault an operation threw — the store down, a missing migration — as every
 * tool has always said it, `Error: <message>`, with the tool's hint for the
 * message when it has one; FAILED beside it, unclassified (core/refusal.ts says
 * why; SMD-2461 classifies), the message and hint in the text alone. A thrown
 * non-Error (a string, undefined, an object that cannot be printed) is said as
 * itself where it can be, and never throws here.
 */
export function failed(err: unknown, hint?: (msg: string) => string): Reply {
  const f = failure(err);
  const text = `Error: ${f.message}${hint ? hint(f.message) : ""}`;
  return { content: [{ type: "text", text }], isError: true, structuredContent: { code: f.code, text } };
}

/** An enum the store reads from a constrained column, kept only when it is one of the words it may be. */
const oneOf = <W extends string>(words: readonly W[], v: unknown): W | null => (words as readonly unknown[]).includes(v) ? v as W : null;
/** The reasons prefer_current demotes a row (059): the function's own words. */
const DEMOTIONS = ["completed", "canceled", "superseded"] as const;

/** search_thoughts: per hit its id, date, scores, the newer thought that supersedes it, and why it was demoted; the window prefer_current read. */
const safeSearch: Safe<SearchThoughtsResult> = (v) => ({
  preferCurrent: v.preferCurrent,
  // Unknown, not false, when the brain had no row to report the query's facts on (review pass 6).
  literalOnly: v.facts?.literalOnly ?? null,
  window: v.window,
  hits: v.hits.map((h) => ({
    id: h.id, created_at: h.created_at, similarity: h.similarity, score: h.score, fused: h.fused,
    supersededBy: h.supersededBy, demoted: h.demoted.map((d) => oneOf(DEMOTIONS, d)).filter((d) => d !== null),
  })),
});
/** search_thoughts_keyword: the page's place in the whole match set, and per hit its id, date and occurrence count. */
const safeKeyword: Safe<KeywordResult> = (v) => ({
  offset: v.offset, total: v.total,
  hits: v.hits.map((h) => ({ id: h.id, created_at: h.created_at, occurrences: h.occurrences })),
});
/** list_thoughts: per thought its id, date and the newer thought that supersedes it. */
const safeList: Safe<ListThoughtsResult> = (v) => ({
  thoughts: v.thoughts.map((t) => ({ id: t.id, created_at: t.created_at, supersededBy: t.supersededBy })),
});
/** list_supersession_proposals: per proposal its ids, verdict, numbers and dates — the sides, the reason and the judge are in the text. */
const safeProposals: Safe<ProposalsResult> = (v) => ({
  status: v.status, ...(v.lineage === undefined ? {} : { lineage: v.lineage }),
  proposals: v.proposals.map((p) => ({
    id: p.id, status: p.status, verdict: p.verdict, confidence: p.confidence, similarity: p.similarity,
    judgedAt: p.judgedAt, reviewedAt: p.reviewedAt, supersedingId: p.supersedingId, lineage: p.lineage,
    older: { id: p.older.id, created_at: p.older.created_at, edited: p.older.edited },
    newer: { id: p.newer.id, created_at: p.newer.created_at, edited: p.newer.edited },
  })),
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
 */
export function snipText(text: string, max: number): string {
  const t = cleanForDisplay(text).replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max) + "…" : t;
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
  if (r.code === "REFUSED_FILTER") return `Error: ${r.message}${hint ? hint(r.message) : ""}`;
  return unknownRefusal(r);
}

/**
 * The `By:` line under a hit — who wrote its current text, from the two keys
 * migration 050 stamps. Absent when the row carries neither (a write from
 * outside the server, or a brain whose backfill has not run), as `Captured:`
 * is absent for an undated row. A name with no kind is a key nobody has
 * classified yet (set_agent_kind), said so rather than guessed. The name is
 * the key's — the server's word, not the thought's — and is rendered through
 * the same cleaner every quoted text takes all the same. Exported for the
 * unit test.
 */
export function actorLine(m: Record<string, unknown>): string | null {
  const name = typeof m.actor_name === "string" && m.actor_name.trim() ? snipText(m.actor_name, 80) : null;
  const kind = oneOf(SAID_BY, m.actor_kind);
  if (!name && !kind) return null;
  return `By: ${name ?? "an unnamed key"} (${kind ?? "kind not classified"})`;
}

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
  const note = `Current first (prefer_current): ${w.demoted} of the top ${w.rows} match${w.rows === 1 ? "" : "es"} ${w.demoted === 1 ? "is" : "are"} settled or superseded and ranked below the current ones${exception}; ${lifecycle}.`;
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

/** The hint an error from prefer_current's path carries: the migration or the grant it needs. */
export function currentSearchHint(msg: string): string {
  return /search_thoughts_current/.test(msg) && /does not exist|could not find/i.test(msg)
    ? " — migration 059 (db/migrations/059_search_prefers_current.sql) is not applied, or PostgREST has not reloaded its schema cache; search without prefer_current meanwhile"
    : /permission denied for table ob1_(ticket_head|superseded_by)\b/i.test(msg)
    ? " — prefer_current reads node_state's projection (migration 068), and the server's role needs the capture group's grants on ob1_ticket_head and ob1_superseded_by (db/README.md, Grants for a capturing role; migrate.ts --grant issues them); search without prefer_current meanwhile"
    : /permission denied for table thought_sources/i.test(msg)
    ? " — prefer_current reads node_state; before migration 068, and after it wherever PostgreSQL checks a removed join's tables, the server's role needs SELECT on thought_sources (db/README.md, Grants for a capturing role — the server group, which migrate.ts --grant issues); search without prefer_current meanwhile"
    : "";
}

// ── The read tools ───────────────────────────────────────────────────────────

/** `search` and `fetch`: ChatGPT reads the text as JSON, so the text is the value. */
export const renderSearch = (o: Outcome<SearchResult>): Reply => render(o, (v) => JSON.stringify(v), searchRefusal, AS_JSON);

export const renderFetch = (o: Outcome<FetchedThought>): Reply =>
  render(o, (v) => JSON.stringify(v), (r) => (r.code === "NOT_FOUND" ? `Fetch error: no thought with id ${r.id}` : unknownRefusal(r)), AS_JSON);

export function renderSearchThoughts(o: Outcome<SearchThoughtsResult>, askedPreferCurrent: boolean): Reply {
  return render(o, (v) => {
    const { query, hits: data, facts } = v;
    if (data.length === 0) {
      // Nothing cleared the threshold and no literal matched; the probe's
      // facts (core/reads.ts) say why, when the brain had a row to say it on.
      const why: string[] = [];
      if (facts) {
        const absent = facts.needles.filter((_, i) => facts.needleCounts[i] === 0);
        if (absent.length) why.push(`No thought contains: ${absent.join(", ")}.`);
        if (facts.commonNeedles.length) why.push(`Too common to match exactly (more thoughts contain it than one keyword page returns): ${facts.commonNeedles.join(", ")} — use search_thoughts_keyword to page through them.`);
      }
      return `No thoughts found matching "${query}".${why.length ? ` ${why.join(" ")}` : ""}`;
    }

    const results = data.map(
      (t, i) => {
        const m = t.metadata || {};
        // A keyword hit with no vector has no similarity to report; it is
        // here because it contains the literal, and the header says which.
        const match = t.similarity == null ? "exact match, no vector" : `${(t.similarity * 100).toFixed(1)}% match`;
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
        // SMD-1328: an undated row shows no Captured line rather than a
        // fabricated 1/1/1970; infinity/a no-ISO-form date shows its text.
        const captured = displayDate(t.created_at);
        parts.push(
          ...(captured ? [`Captured: ${captured}`] : []),
          `Type: ${m.type || "unknown"}`,
        );
        // SMD-1726: who wrote the current text, from the key (050); its own
        // line, as every field of this block is — nothing parses `ID:`
        // past the id, and nothing should start to.
        const by = actorLine(m);
        if (by) parts.push(by);
        if (t.matchedNeedles.length) parts.push(`Contains: ${t.matchedNeedles.join(", ")}`);
        if (Array.isArray(m.topics) && m.topics.length)
          parts.push(`Topics: ${(m.topics as string[]).join(", ")}`);
        if (Array.isArray(m.people) && m.people.length)
          parts.push(`People: ${(m.people as string[]).join(", ")}`);
        if (Array.isArray(m.action_items) && m.action_items.length)
          parts.push(`Actions: ${(m.action_items as string[]).join("; ")}`);
        parts.push(`\n${t.content}`);
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
    const notes: string[] = [];
    if (head.needles.length) notes.push(`Searched exactly for: ${head.needles.join(", ")}.`);
    if (absent.length) notes.push(`No thought contains: ${absent.join(", ")}.`);
    if (truncated.length) notes.push(`Outside the top ${data.length}${v.preferCurrent ? " (or demoted past it)" : ""}: ${truncated.map((n, ) => `${n} (in ${head.needleCounts[head.needles.indexOf(n)]} thought${head.needleCounts[head.needles.indexOf(n)] === 1 ? "" : "s"})`).join(", ")} — raise limit or use search_thoughts_keyword.`);
    if (head.commonNeedles.length) notes.push(`Too common to match exactly (more thoughts contain it than one keyword page returns): ${head.commonNeedles.join(", ")}.`);
    // prefer_current's window rides the value once; the note reads it off the first row.
    const current = currentNote(data.map((t) => ({ demoted: t.demoted, window: v.window ?? undefined })));
    if (current) notes.push(current);
    if (head.literalOnly) {
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
        `Type: ${m.type || "unknown"}`,
      ];
      // SMD-1726: who wrote it, the line search_thoughts prints.
      const by = actorLine(m);
      if (by) parts.push(by);
      if (Array.isArray(m.topics) && m.topics.length)
        parts.push(`Topics: ${(m.topics as string[]).join(", ")}`);
      parts.push(`\n${t.content}`);
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
  return render(o, ({ thoughts: data }) => {
    if (!data.length) return "No thoughts found.";
    const results = data.map(
      (t, i) => {
        const m = t.metadata || {};
        const tags = Array.isArray(m.topics) ? (m.topics as string[]).join(", ") : "";
        // An `ID:` line, the same label the two search tools print — it is what
        // update_thought and delete_thought take. This compact format has no
        // header group, so it trails the content. SMD-1248.
        const mark = t.supersededBy ? `\n   ⚠ Superseded by a newer thought — ID ${t.supersededBy}` : "";
        // SMD-1726: who wrote it, AFTER the id line, indented as the block
        // is — the content-then-ID adjacency stays, which this repo's own
        // e2e suite ([8]) matched on and a client may too.
        const by = actorLine(m);
        const who = by ? `\n   ${by}` : "";
        // SMD-1328: the date bracket is structural here, so an undated row
        // reads `[undated]` (never `[1/1/1970]`); a sentinel shows its text.
        return `${i + 1}. [${displayDate(t.created_at) ?? "undated"}] (${m.type || "??"}${tags ? " - " + tags : ""})\n   ${t.content}\n   ID: ${t.id}${who}${mark}`;
      }
    );
    return `${data.length} recent thought(s):\n\n${results.join("\n\n")}`;
  }, unknownRefusal, safeList);
}

export function renderSupersessionProposals(o: Outcome<ProposalsResult>): Reply {
  return render(o, ({ status, lineage, proposals: data }) => {
    const onLineage = lineage === true ? " on a lineage pair" : lineage === false ? " not on a lineage pair" : "";
    if (!data.length) {
      // A lineage pair is never proposed since 066, so an empty lineage
      // selection is not the pass's to fill (maintainer read, third pass).
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
      : "conflict, direction not stated — accepting needs --direction newer or older";
    const results = data.map((p, i) => {
      const edited = p.older.edited || p.newer.edited;
      const dir = p.verdict === "conflict_undirected" ? " --direction <newer|older>" : "";
      // 070: the CLI refuses an accept on a lineage pair without --force.
      const review = p.status === "pending"
        ? `   accept: cd db && bun consolidate.ts --url $DATABASE_URL --accept ${p.id}${dir}${edited || p.lineage ? " --force" : ""}   reject: … --reject ${p.id}` +
          (edited ? "\n   (a thought was edited after the pair was judged, so the verdict is about an earlier text; --force accepts it anyway)" : "")
        : `   ${p.status}${p.reviewedAt ? ` on ${day(p.reviewedAt)}` : ""}${p.reviewNote ? `: ${cleanForDisplay(p.reviewNote)}` : ""}`;
      // 070 (SMD-2313): a lineage pair — one side derived from the other
      // — is never proposed since 066; a row standing on one is the
      // reviewer's to reject, said with the command while it is theirs.
      const lineageLine = p.lineage
        ? `\n   LINEAGE PAIR: one side's derived_from names the other (a derivation and its input) — never proposed since migration 066${p.status === "pending" || p.status === "stale" ? `; reject it: cd db && bun consolidate.ts --url $DATABASE_URL --reject ${p.id} --note "lineage pair (066)"` : p.status === "accepted" ? `; accepted while the derivation names its input — cd db && bun consolidate.ts --url $DATABASE_URL --reject ${p.id} clears the pointer (029)` : ""}`
        : "";
      return `${i + 1}. [confidence ${p.confidence.toFixed(2)}] ${phrase(p.verdict)}${p.lineage ? "  LINEAGE PAIR" : ""}${p.reason ? `\n   ${cleanForDisplay(p.reason)}` : ""}${lineageLine}` +
        `\n   newer [${day(p.newer.created_at)}]${p.newer.edited ? " (edited since judged)" : ""}: ${snip(p.newer.content)}\n      ID: ${p.newer.id}` +
        `\n   older [${day(p.older.created_at)}]${p.older.edited ? " (edited since judged)" : ""}: ${snip(p.older.content)}\n      ID: ${p.older.id}` +
        `\n   proposal ${p.id} — judged by ${p.judgeKey} on ${day(p.judgedAt)}\n${review}`;
    });
    return `${data.length} ${status === "all" ? "" : status + " "}supersession proposal(s)${onLineage}, most confident first. The pass proposes; nothing is written to a thought until a proposal is accepted.\n\n${results.join("\n\n")}`;
  }, unknownRefusal, safeProposals);
}

/**
 * The hint a listing error carries. 070 (SMD-2313): both stores call the
 * three-argument form, so a brain short of 070 — or of 029, whose queue the
 * listing reads — fails naming that form (PostgREST names p_lineage); the
 * driver's message is the same either way, so one hint names both files (cold
 * read, first and fourth review passes).
 */
export const proposalsHint = (msg: string): string =>
  /list_supersession_proposals|supersession_proposals|p_lineage/.test(msg)
    ? " — the migrations through 070 are not applied (029, db/migrations/029_supersession_proposals.sql, creates the queue; 070, db/migrations/070_listing_flags_lineage_pair.sql, its current listing), or PostgREST has not reloaded its schema cache"
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

    // Never report aggregates as corpus-wide when they are not. The SQL path
    // covers the whole corpus (aggregated === total) and this never fires; a
    // capped PostgREST walk that stopped short says so rather than quietly
    // under-reporting.
    if (aggregated < total) {
      lines.push(
        `Note: breakdowns below cover the ${aggregated.toLocaleString()} most recent thoughts, ` +
          `not all ${total.toLocaleString()}.`
      );
    }

    lines.push("", "Types:", ...sort(types).map(([k, v]) => `  ${k}: ${v}`));

    if (Object.keys(topics).length) {
      lines.push("", "Top topics:");
      for (const [k, v] of sort(topics)) lines.push(`  ${k}: ${v}`);
    }

    if (Object.keys(people).length) {
      lines.push("", "People mentioned:");
      for (const [k, v] of sort(people)) lines.push(`  ${k}: ${v}`);
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
  const verb = c.action === "capture" ? "captured" : c.action === "update" ? (marksOnly ? "marked" : "edited") : "deleted";
  const gone = c.action !== "delete" && !c.present ? " (deleted since)" : "";
  const lines = [`${n}. ${when} — ${verb} ${who} — ID: ${c.thoughtId}${gone}`];
  const text = c.head === null ? null : snipText(c.head, 200);
  // A capture row carries no text of its own (008's capture diff is the
  // metadata), so the head is the thought's CURRENT text — say so, since an edit
  // since would otherwise read as what was captured; a deleted thought's text
  // is in its delete row, not gone (both caught: cold-read, pass 1).
  if (c.action === "capture") lines.push(text === null ? "   (the text is in its delete row)" : `   now: "${text}"`);
  if (c.action === "delete" && text !== null) lines.push(`   was: "${text}"`);
  if (c.action === "update") {
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
    ? " — migration 052 (db/migrations/052_thought_changes.sql) is not applied, or PostgREST has not reloaded its schema cache"
    : /permission denied for table thought_audit/i.test(msg)
    ? " — the server's role needs SELECT on thought_audit (db/README.md, Grants for a capturing role — the server group, which migrate.ts --grant issues)"
    : "";

/** list_thought_ids: the page itself is the text, a JSON object a script reads. */
export const renderThoughtIds = (o: Outcome<ThoughtIdPage>): Reply =>
  render(o, (v) => JSON.stringify(v), (r) => (r.code === "REFUSED_CURSOR" ? "Error: `after` must be a thought id (a uuid) — pass the previous page's `cursor`." : unknownRefusal(r)), AS_JSON);

/** list_logged_searches: the page itself is the text. */
export const renderLoggedSearches = (o: Outcome<LoggedSearchPage>): Reply =>
  render(o, (v) => JSON.stringify(v), (r) => (r.code === "REFUSED_SINCE" ? "Error: `since` must be an ISO-8601 time (e.g. 2026-09-24T00:00:00Z)." : unknownRefusal(r)), AS_JSON);

export const loggedSearchesHint = (msg: string): string =>
  /query_log/.test(msg) && /does not exist|could not find/i.test(msg)
    ? " — migration 034 (db/migrations/034_query_log.sql) is not applied, or PostgREST has not reloaded its schema cache"
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
