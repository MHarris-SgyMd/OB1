#!/usr/bin/env bun
/**
 * board-findings.ts — a consolidation finding between two Linear tickets the
 * board does not link, posted as one comment on the newer ticket (SMD-2681).
 *
 * Board-sync reads the board into the brain; nothing went the other way. When
 * consolidation judged two ticket rows — a pending `outdates` proposal (029),
 * or a standing `related`, `evolves` or `duplicate` relation (084) — the
 * finding waited in the brain until someone read the queue (SMD-2680 counts
 * it in brain_info and preflight). This posts it where the people who decide
 * it look: one comment on the newer ticket, naming the other ticket, what the
 * judge found, and how to act on it.
 *
 *   bun db/board-findings.ts --url postgres://… --dry-run   # what would be posted (the board unread); no request, no row
 *   bun db/board-findings.ts --url …                        # post, up to the cap
 *   bun db/board-findings.ts --url … --cap 2                # the 24-hour ceiling this run applies, over OB1_FINDINGS_POST_CAP
 *
 * board-sync runs the same step after each pass (not --audit, not --only)
 * when LINEAR_COMMENT_API_KEY is set (db/sync-linear.ts), so "not linked"
 * is read on the links as of that pass. A pass refetches only the tickets
 * Linear says moved: a link Linear adds without moving either ticket's
 * updatedAt reaches the brain at the next --full pass, and until then such a
 * pair can still be posted.
 *
 * ── What is posted ───────────────────────────────────────────────────────────
 * A pair is two Linear rows (metadata.source = 'linear': board-sync's tickets
 * and their dated sections) filed under two different tickets — 079's
 * identity, coalesce(metadata->>'ticket', metadata->>'issue'), read as an
 * identifier — that no active Linear link joins: neither 079's
 * consolidation_tickets_linked nor a duplicate_of either way (SMD-2680's
 * rule, brain-info.ts's board-pair reads, asked here when posting: a link
 * made after the verdict never moves the proposal). A fork change record or a
 * capture may carry a `ticket` too; its text is not the board's, and it is
 * never posted, nor is a session note.
 *
 * One comment per ticket pair, on the ticket of the thought the judge saw as
 * newer: several proposals or relations between rows of the same two
 * tickets are one comment. The record (migration 086, board_findings_posted)
 * is per pair and WORD — outdates, related, evolves, duplicate — so a
 * relation a re-judge replaced at another score is not posted again, and a
 * pair posted as related is posted once more only when the judge says
 * something else about it. The comment carries the two identifiers, the word
 * and its direction, the judge's confidence, a proposal's one-line reason (a
 * code span: a link or a mention in it is shown, not rendered) and its id.
 * It proposes only: no link is added, no status moved, no description
 * edited. A proposal is decided in the brain (consolidate.ts --accept /
 * --reject); a relation by linking the tickets on the board, which
 * board-sync's next pass brings back.
 *
 * ── Posted once ──────────────────────────────────────────────────────────────
 * The comment's last line is a marker, `ob1-finding SMD-A SMD-B words`, read
 * back through normalised() since Linear returns markdown derived from its
 * rich text. Before posting, both tickets' comments are read: a marker naming
 * the pair and the word means another brain posted it, or this one did and
 * lost its row; that word is recorded as `found` and not posted. Each post
 * holds one transaction-scoped advisory lock for the brain, re-reads the
 * record and re-counts the day's posts under it, and writes its rows after
 * Linear answers, in the same transaction — a post that fails records
 * nothing and the next run tries again; a run killed between Linear's answer
 * and the commit leaves the marker, which the next run finds. Board-sync
 * passes its census: a pair with a ticket off the board is not asked of
 * Linear, and a listed ticket the key cannot find is a failure. Without it
 * (the CLI), Linear's "Entity not found" is reported and asked again.
 *
 * ── Bounded ──────────────────────────────────────────────────────────────────
 * At most OB1_FINDINGS_POST_CAP comments (5) in any 24 hours, counted from
 * the comments this brain recorded posting; `found` rows are not counted. The judge's
 * confidence does not yet rank real findings (SMD-2705), so the cap is the
 * guard against flooding the board. Pairs are posted best first: the
 * highest-confidence finding, then the oldest.
 *
 * ── Through the egress gate ──────────────────────────────────────────────────
 * The comment leaves to api.linear.app, so it is a subject for mayLeaveBox
 * (server-portable/egress.ts) with units of its own: type `board-finding`,
 * source `board-findings`, and its text for a marker: term. Under the default
 * deny it is refused and printed instead; an operator opts in with one term:
 *
 *   OB1_EGRESS_ALLOW=type:board-finding
 *
 * The two thoughts are not gated themselves: both are the board's own rows,
 * and what leaves is a remark about them, to that board.
 *
 * The key is LINEAR_COMMENT_API_KEY — a key that can comment, never
 * board-sync's LINEAR_API_KEY, which only reads and is someone's whole
 * account. It is read from the environment (or the .env files db/env.ts
 * searches) and never printed.
 */

import type { SQL } from "bun";
import { commandLine, readNumber } from "./cli.ts";
import { databaseUrl, openSql, closeThenExit } from "./connect.ts";
import { describeEnv, loadEnv } from "./env.ts";
import { linearClient, strict, type Gql } from "./linear-api.ts";
import { stripAutolinks } from "./ingest-linear.ts";
import { egressRefusal } from "./worker-bootstrap.ts";
import { mayLeaveBox, resolveEgressPolicy, type EgressDecision, type EgressEnv, type EgressPolicy, type EgressSubject, type EgressTerm, type EgressUnit } from "../server-portable/egress.ts";

export const DEFAULT_CAP = 5;
export const MAX_CAP = 100;
/** A Linear request's bound: the post is made inside the transaction that records it. */
export const LINEAR_TIMEOUT_MS = 20_000;
/** The comments read back for a marker — Linear's largest page. */
const COMMENTS_READ = 250;
/** A proposal's reason, at most this long in the comment. */
const REASON_CHARS = 300;

export type FindingWord = "outdates" | "related" | "evolves" | "duplicate";
export const FINDING_WORDS: readonly FindingWord[] = ["outdates", "related", "evolves", "duplicate"];

/** One proposal or relation between two ticket rows, as selectFindings reads it. */
export type Finding = {
  kind: "proposal" | "relation";
  /** The supersession_proposals id or the relation's thought_facets id. */
  id: string;
  word: FindingWord;
  /** The older thought's ticket and the newer thought's (a relation's target and holder). */
  older: string;
  newer: string;
  /** The pair in the database's order: a < b. */
  a: string;
  b: string;
  /** A proposal's verdict: newer_supersedes_older, older_supersedes_newer or conflict_undirected. */
  verdict: string | null;
  confidence: number | null;
  reason: string | null;
  /** When it was judged (a relation: when its facet was written). */
  at: string;
};

/** The findings of one ticket pair, ranked, with the ticket the comment goes on. */
export type FindingGroup = {
  a: string;
  b: string;
  /** The newer side of the pair's first-ranked finding. */
  on: string;
  findings: Finding[];
};

// ── The pure parts ──────────────────────────────────────────────────────────

/** Best first: the higher confidence (none last), then the older. */
export function rankFindings(x: Finding, y: Finding): number {
  const cx = x.confidence ?? -1, cy = y.confidence ?? -1;
  if (cx !== cy) return cy - cx;
  return x.at < y.at ? -1 : x.at > y.at ? 1 : x.id < y.id ? -1 : x.id > y.id ? 1 : 0;
}

/** The findings grouped by ticket pair, each group ranked, the groups ranked by their best. */
export function groupFindings(rows: readonly Finding[]): FindingGroup[] {
  const groups = new Map<string, Finding[]>();
  for (const f of rows) {
    const k = `${f.a}\u0000${f.b}`;
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(f);
  }
  const out: FindingGroup[] = [];
  for (const fs of groups.values()) {
    fs.sort(rankFindings);
    out.push({ a: fs[0].a, b: fs[0].b, on: fs[0].newer, findings: fs });
  }
  return out.sort((g, h) => rankFindings(g.findings[0], h.findings[0]));
}

/** The words a group names, in rank order. */
export function groupWords(g: Pick<FindingGroup, "findings">): FindingWord[] {
  return [...new Set(g.findings.map((f) => f.word))];
}

/** The group with only the findings of these words (null when none is left). */
export function onlyWords(g: FindingGroup, words: ReadonlySet<FindingWord>): FindingGroup | null {
  const findings = g.findings.filter((f) => words.has(f.word));
  return findings.length ? { ...g, findings } : null;
}

const conf = (c: number | null) => (c === null ? "" : ` (confidence ${c.toFixed(2)})`);
/**
 * A reason as one code span, bounded: on one line, so it cannot start a line
 * of its own (a marker), and inside backticks, so a link, an image, a mention
 * or emphasis in the judge's text is shown as text, not rendered (review pass 1).
 */
const reasonSpan = (s: string) => {
  const flat = s.replace(/\s+/g, " ").replace(/`/g, "'").trim();
  return `\`${flat.length > REASON_CHARS ? `${flat.slice(0, REASON_CHARS - 1)}…` : flat}\``;
};

/** One finding's bullet. */
export function findingLine(f: Finding): string {
  if (f.kind === "proposal") {
    const says = f.verdict === "newer_supersedes_older" ? `**${f.newer} outdates ${f.older}**`
      : f.verdict === "older_supersedes_newer" ? `**${f.older} outdates ${f.newer}**`
      : `**${f.newer} and ${f.older} conflict** (which outdates which is undecided)`;
    const decide = f.verdict === "conflict_undirected"
      ? `\`cd db && bun consolidate.ts --accept ${f.id} --direction newer|older\``
      : `\`cd db && bun consolidate.ts --accept ${f.id}\``;
    const reason = f.reason?.trim() ? `: ${reasonSpan(f.reason)}` : "";
    return `- ${says}${conf(f.confidence)}${reason}. A pending supersession proposal, decided in the brain: ${decide}, or \`--reject ${f.id}\`.`;
  }
  const verb = f.word === "duplicate" ? "duplicates" : f.word === "evolves" ? "evolves from" : "is related to";
  // A related link takes the pair out of consolidation's candidates (079); a
  // duplicate_of does not — 079 leaves it to the judge — so only this post
  // stops (review pass 1: the comment said the brain stops pairing them).
  return f.word === "duplicate"
    ? `- **${f.newer} ${verb} ${f.older}**${conf(f.confidence)}. If so, mark one a duplicate of the other here; board-sync brings the link back on its next pass, and the pair is not posted again.`
    : `- **${f.newer} ${verb} ${f.older}**${conf(f.confidence)}. If so, link them as related here; board-sync brings the link back on its next pass and the brain stops pairing them.`;
}

/**
 * The marker line, the comment's last: the pair in order and the words, in
 * letters, digits, hyphens and spaces only. Linear keeps a comment as rich
 * text and hands back markdown derived from it, so a `~` or `·` may come back
 * escaped and an identifier as an autolink (review pass 1); markerWords reads
 * the body through normalised() for those.
 */
export function markerLine(a: string, b: string, words: readonly FindingWord[]): string {
  return `ob1-finding ${a} ${b} ${words.join(" ")}`;
}

/** The comment for a group: the findings, that it proposes only, and the marker last. */
export function commentBody(g: FindingGroup): string {
  const other = g.on === g.a ? g.b : g.a;
  return [
    `**Open Brain found something about ${g.on} and ${other}**, two tickets this board does not link.`,
    "",
    ...g.findings.map(findingLine),
    "",
    "Posted by the brain's consolidation pass; it proposes only, and changed nothing on this board.",
    "",
    markerLine(g.a, g.b, groupWords(g)),
  ].join("\n");
}

const TICKET = "[A-Za-z][A-Za-z0-9]*-\\d+";
const MARKER = new RegExp(`^[ \\t>]*ob1-finding[ \\t]+(${TICKET})[ \\t]+(${TICKET})((?:[ \\t,]+[a-z]+)+)[ \\t]*$`, "gmi");

/**
 * A body as Linear may hand it back, read as written: an autolinked
 * identifier (`<issue …>SMD-1</issue>`, or `[SMD-1](url)`) as the identifier,
 * a backslash escape as the character, emphasis markers dropped.
 */
export function normalised(body: string): string {
  return stripAutolinks(body)
    .replace(/\[([^\]\n]*)\]\([^)\n]*\)/g, "$1")
    .replace(/\\([\\`*_{}\[\]()#+\-.!~|<>])/g, "$1")
    .replace(/\*\*|__/g, "");
}

/** The words a body's marker lines name for this pair (either order); empty when none does. */
export function markerWords(body: string, a: string, b: string): Set<FindingWord> {
  const out = new Set<FindingWord>();
  for (const m of normalised(body).matchAll(MARKER)) {
    const [x, y] = [m[1].toUpperCase(), m[2].toUpperCase()];
    const [p, q] = [a.toUpperCase(), b.toUpperCase()];
    if (!((x === p && y === q) || (x === q && y === p))) continue;
    for (const w of m[3].split(/[\s,]+/).map((s) => s.toLowerCase())) if ((FINDING_WORDS as readonly string[]).includes(w)) out.add(w as FindingWord);
  }
  return out;
}

/** The cap from the flag, else OB1_FINDINGS_POST_CAP, else 5: whole comments, 0 to 100. `label` names where it came from. */
export function readCap(raw: string | undefined, label = "--cap / OB1_FINDINGS_POST_CAP"): number | { error: string } {
  const v = raw?.trim();
  if (!v) return DEFAULT_CAP;
  const n = readNumber(label, v, { min: 0, max: MAX_CAP });
  return typeof n === "number" ? n : { error: `${n.error} (whole comments a day).` };
}

// ── The egress subject ──────────────────────────────────────────────────────

/** The units a comment carries: no actor — the comment key is not a brain key. */
export const FINDING_UNITS: readonly EgressUnit[] = ["source", "type", "marker"];

/**
 * The gate's subject for a comment: its own type and source, and its text for
 * a marker: term. The values are ones a capture is unlikely to carry —
 * OB1_EGRESS_ALLOW is the server's too, and a term admits any row whose
 * metadata carries the value (review pass 1: `type:finding` and
 * `source:consolidation` are words a capture may well use).
 */
export function findingSubject(body: string): EgressSubject {
  return { kind: "finding", metadata: { type: "board-finding", source: "board-findings" }, content: body };
}

/** The endpoint a comment is gated against: Linear's, never local. */
export const LINEAR_ENDPOINT = { base: "https://api.linear.app", local: false } as const;

/** The per-comment gate under a policy. */
export function findingGate(policy: EgressPolicy): (body: string) => EgressDecision {
  return (body) => mayLeaveBox(findingSubject(body), LINEAR_ENDPOINT, policy);
}

export const ALLOW_HINT = "name the findings in OB1_EGRESS_ALLOW (type:board-finding), or set OB1_EGRESS_POLICY";

/**
 * The policy without the findings' own allow terms — for a caller judging
 * whether ITS calls could leave. board-sync's up-front refusal asks whether
 * any allow term names a unit a ticket carries; `type:board-finding` names
 * `type`, which a section row carries, so the term the docs tell an operator
 * to set cleared it, and every ticket landed without a vector, exit 0
 * (review pass 3). No ticket carries these values.
 */
export function withoutFindingTerms(policy: EgressPolicy): EgressPolicy {
  const own = (t: EgressTerm) => (t.unit === "type" && t.value.toLowerCase() === "board-finding") || (t.unit === "source" && t.value.toLowerCase() === "board-findings");
  return { ...policy, allow: policy.allow.filter((t) => !own(t)) };
}

// ── The database ────────────────────────────────────────────────────────────

/**
 * What this brain, or this role, lacks for posting, in words, or null. A role
 * that cannot read or record what it needs is said once and the step stays
 * off — before, it failed every pass of the sync (review pass 1). A dry run
 * records nothing and needs the reads alone (review pass 2).
 */
export async function findingsSchemaProblem(sql: SQL, opts: { write?: boolean } = {}): Promise<string | null> {
  const write = opts.write ?? true;
  const [r] = await sql`SELECT to_regclass('board_findings_posted') IS NOT NULL AS posted,
                               to_regprocedure('consolidation_tickets_linked(jsonb, jsonb)') IS NOT NULL AS linked`;
  if (!r.linked) return "migration 079 is not applied, so whether the board links two tickets cannot be asked (cd db && bun migrate.ts --url …)";
  if (!r.posted) return "migration 086 is not applied, so nothing posted could be recorded (cd db && bun migrate.ts --url …)";
  // 029's table precedes 086 in every tree, so it exists here.
  const [g] = await sql`SELECT has_table_privilege('board_findings_posted', 'SELECT') AS posted_read,
                               has_table_privilege('board_findings_posted', 'INSERT') AS posted_write,
                               has_table_privilege('thoughts', 'SELECT') AND has_table_privilege('thought_facets', 'SELECT') AS read,
                               has_table_privilege('supersession_proposals', 'SELECT') AS proposals,
                               has_function_privilege('consolidation_tickets_linked(jsonb, jsonb)', 'EXECUTE') AS linked`;
  const missing = [
    ...(g.posted_read && (g.posted_write || !write) ? [] : [`${write ? "SELECT and INSERT" : "SELECT"} on board_findings_posted (the structure group)`]),
    ...(g.read ? [] : ["SELECT on thoughts and thought_facets (the capture group)"]),
    ...(g.proposals ? [] : ["SELECT on supersession_proposals (the structure group)"]),
    ...(g.linked ? [] : ["EXECUTE on consolidation_tickets_linked(jsonb, jsonb)"]),
  ];
  return missing.length ? `this role lacks ${missing.join("; ")} — cd db && bun migrate.ts --url <owner's url> --grant <role> --groups capture,structure` : null;
}

// Both sides are Linear rows (metadata.source = 'linear': board-sync's
// tickets and their dated sections), and both identities are identifiers —
// 079's identity alone also names a fork change record's or any capture's
// `ticket`, whose text is not the board's, and a raw identity went into the
// comment unescaped (review pass 1).
const PAIR_RULE = `
     os = 'linear' AND ns = 'linear'
 AND ko ~ '^[A-Z][A-Z0-9]*-[0-9]+$' AND kn ~ '^[A-Z][A-Z0-9]*-[0-9]+$'
 AND ko <> kn
 AND NOT consolidation_tickets_linked(om, nm)
 AND NOT EXISTS (SELECT 1 FROM thought_facets d JOIN thoughts dh ON dh.id = d.thought_id
                  WHERE d.kind = 'link' AND d.valid_until IS NULL AND d.payload->>'system' = 'linear' AND d.payload->>'relation' = 'duplicate_of'
                    AND (coalesce(dh.metadata->>'ticket', dh.metadata->>'issue'), d.payload->>'target') IN ((ko, kn), (kn, ko)))
 AND NOT EXISTS (SELECT 1 FROM board_findings_posted b
                  WHERE b.ticket_a = least(ko, kn) AND b.ticket_b = greatest(ko, kn) AND b.word = x.word)`;

const PROPOSALS = `
SELECT 'proposal' AS kind, x.id::text AS id, x.word, ko AS older, kn AS newer, least(ko, kn) AS a, greatest(ko, kn) AS b,
       x.verdict, x.confidence, x.reason, x.at
  FROM (SELECT p.id, 'outdates'::text AS word, p.verdict, p.confidence::float8 AS confidence, p.reason, p.judged_at AS at,
               o.metadata AS om, n.metadata AS nm, o.metadata->>'source' AS os, n.metadata->>'source' AS ns,
               coalesce(o.metadata->>'ticket', o.metadata->>'issue') AS ko, coalesce(n.metadata->>'ticket', n.metadata->>'issue') AS kn
          FROM supersession_proposals p
          JOIN thoughts o ON o.id = p.older_id
          JOIN thoughts n ON n.id = p.newer_id
         WHERE p.status = 'pending') x
 WHERE ${PAIR_RULE}`;

const RELATIONS = `
SELECT 'relation' AS kind, x.id::text AS id, x.word, ko AS older, kn AS newer, least(ko, kn) AS a, greatest(ko, kn) AS b,
       NULL::text AS verdict, x.confidence, NULL::text AS reason, x.at
  FROM (SELECT f.id, f.payload->>'relation' AS word, (f.payload->>'confidence')::float8 AS confidence, f.created_at AS at,
               t.metadata AS om, h.metadata AS nm, t.metadata->>'source' AS os, h.metadata->>'source' AS ns,
               coalesce(t.metadata->>'ticket', t.metadata->>'issue') AS ko, coalesce(h.metadata->>'ticket', h.metadata->>'issue') AS kn
          FROM thought_facets f
          JOIN thoughts h ON h.id = f.thought_id
          JOIN thoughts t ON t.id = CASE WHEN f.kind = 'relation' THEN (f.payload->>'target')::uuid END
         WHERE f.kind = 'relation' AND f.valid_until IS NULL) x
 WHERE ${PAIR_RULE}`;

/**
 * Every finding between two unlinked tickets not yet posted for its word. The
 * proposals arm needs 029's table, the relations arm 084's facet kind; a
 * brain without one reads none of it. Asked fresh on every run.
 */
export async function selectFindings(sql: SQL): Promise<Finding[]> {
  const [has] = await sql`SELECT to_regclass('supersession_proposals') IS NOT NULL AS proposals,
                                 to_regproc('record_thought_relation') IS NOT NULL AS relations`;
  const arms = [has.proposals ? PROPOSALS : null, has.relations ? RELATIONS : null].filter((s): s is string => s !== null);
  if (!arms.length) return [];
  const rows = (await sql.unsafe(arms.join("\nUNION ALL\n"))) as Record<string, unknown>[];
  return rows.map((r) => ({
    kind: r.kind as Finding["kind"],
    id: String(r.id),
    word: r.word as FindingWord,
    older: String(r.older),
    newer: String(r.newer),
    a: String(r.a),
    b: String(r.b),
    verdict: (r.verdict as string | null) ?? null,
    confidence: r.confidence === null || r.confidence === undefined ? null : Number(r.confidence),
    reason: (r.reason as string | null) ?? null,
    at: r.at instanceof Date ? r.at.toISOString() : String(r.at),
  }));
}

/** Comments this brain posted in the last 24 hours: one per pair and transaction. */
export async function postedToday(sql: SQL): Promise<number> {
  const [r] = await sql`SELECT count(DISTINCT (ticket_a, ticket_b, posted_at))::int AS n
                          FROM board_findings_posted WHERE origin = 'posted' AND posted_at > now() - interval '24 hours'`;
  return Number(r.n);
}

type Row = { word: FindingWord; ids: string[] };
const rowsOf = (g: FindingGroup): Row[] => groupWords(g).map((word) => ({ word, ids: g.findings.filter((f) => f.word === word).map((f) => f.id) }));

async function record(tx: SQL, g: FindingGroup, origin: "posted" | "found", commentId: string | null): Promise<void> {
  for (const r of rowsOf(g)) {
    await tx`INSERT INTO board_findings_posted (ticket_a, ticket_b, word, posted_on, origin, comment_id, finding_ids)
             VALUES (${g.a}, ${g.b}, ${r.word}, ${g.on}, ${origin}, ${commentId}, ${`{${r.ids.join(",")}}`}::uuid[])
             ON CONFLICT DO NOTHING`;
  }
}

// ── Linear ──────────────────────────────────────────────────────────────────

const TICKET_QUERY = `query BoardFindingTicket($id: String!) {
  issue(id: $id) { id identifier comments(first: ${COMMENTS_READ}) { nodes { body } } }
}`;
const COMMENT_MUTATION = `mutation BoardFindingComment($issueId: String!, $body: String!) {
  commentCreate(input: { issueId: $issueId, body: $body }) { success comment { id } }
}`;

type TicketAnswer = { issue: { id: string; identifier: string; comments: { nodes: { body: string | null }[] } } | null };
type CommentAnswer = { commentCreate: { success: boolean; comment: { id: string } | null } };

/** "No such ticket" as Linear says it: Entity not found, on the issue field. */
const NOT_FOUND = /^Entity not found/i;

/**
 * A ticket as the comment key reads it: its id and the words its comments'
 * markers name for the pair, or null when Linear answers that it has no such
 * ticket for this key. Only that answer is null — "Entity not found" on the
 * `issue` field, or the issue null with no error; any other error, an empty
 * answer or a non-JSON one is a failure (review pass 2: any "not found"
 * anywhere, and an empty answer, read as no ticket, and a failure was
 * skipped for good). Linear may send a user error with HTTP 400; the client
 * throws on it with the body, which is read for the same answer.
 */
async function readTicket(gql: Gql, id: string, a: string, b: string): Promise<{ id: string; words: Set<FindingWord> } | null> {
  let r: Awaited<ReturnType<Gql>>;
  try { r = await gql<TicketAnswer>(TICKET_QUERY, { id }); }
  catch (e) {
    const m = (e as Error).message;
    if (/^Linear returned HTTP 400\b/.test(m) && /"message"\s*:\s*"Entity not found/i.test(m)) return null;
    throw e;
  }
  const data = r.data as TicketAnswer | null;
  if (data && data.issue === null && r.errors.every((e) => NOT_FOUND.test(e.message) && (e.path === undefined || e.path[0] === "issue"))) return null;
  if (r.errors.length) throw new Error(`Linear GraphQL error: ${r.errors.map((e) => e.message).join("; ")}`);
  if (!data?.issue) throw new Error(`Linear returned no answer for ${id}`);
  const words = new Set<FindingWord>();
  for (const c of data.issue.comments.nodes) for (const w of markerWords(c.body ?? "", a, b)) words.add(w);
  return { id: data.issue.id, words };
}

// ── The step ────────────────────────────────────────────────────────────────

/**
 * What a run did, ONE outcome per ticket pair: the outcome lists and counts
 * below add up to `pairs` (review pass 2: a pair found for one word and
 * capped for another was counted twice, a pair another poster settled and
 * the pairs after a signal not at all). `foundWords` counts the words
 * recorded found, whatever the pair's outcome.
 */
export type FindingsReport = {
  /** Ticket pairs with something not yet posted. */
  pairs: number;
  posted: { a: string; b: string; on: string; words: FindingWord[]; commentId: string }[];
  /** Pairs whose every word left was already on the board. */
  found: { a: string; b: string; on: string; words: FindingWord[] }[];
  /** Pairs the gate refused (printed instead); under a dry run, the pairs it would refuse. */
  refused: number;
  /** Pairs with a ticket the board's census does not list (deleted, or moved off the board), or one this pass could not sync: not asked of Linear. */
  offBoard: number;
  /** Pairs with a ticket Linear answered it has not for the key — only when no census was given (the CLI). */
  unreachable: { a: string; b: string; ticket: string }[];
  failed: { a: string; b: string; error: string }[];
  /** Pairs left for a later run by the cap. */
  waitingOnCap: number;
  /** Pairs another poster settled while this run held the pair. */
  settledElsewhere: number;
  /** Pairs a signal left for the next run. */
  notReached: number;
  /** Under a dry run, the pairs it would post. */
  wouldPost: number;
  foundWords: number;
  /** Comments this brain had posted in the 24 hours before this run, and at its last count. */
  postedBefore: number;
  postedLast: number;
};

export type PostOptions = {
  sql: SQL;
  /** The comment key's client; null under a dry run. */
  gql: Gql | null;
  cap: number;
  dryRun: boolean;
  gate: (body: string) => EgressDecision;
  log?: (line: string) => void;
  warn?: (line: string) => void;
  /** Checked between pairs: a signal ends the step after the pair in hand. */
  stopped?: () => boolean;
  /** Print a refused comment's whole text (the CLI); a loop prints one line a pair. */
  showRefused?: boolean;
  /**
   * The identifiers the board lists now — board-sync's census of this pass.
   * Given, a pair with a ticket off it (deleted in Linear, or moved out of
   * the initiative; its row stays) is not asked of Linear at all, and a
   * ticket on it that the comment key cannot find is a failure — the key
   * does not see the board (review pass 2: such pairs were asked every pass,
   * and a key of the wrong workspace read every pair as no ticket, exit 0).
   */
  board?: ReadonlySet<string>;
};

export const emptyReport = (): FindingsReport => ({
  pairs: 0, posted: [], found: [], refused: 0, offBoard: 0, unreachable: [], failed: [], waitingOnCap: 0, settledElsewhere: 0, notReached: 0, wouldPost: 0, foundWords: 0, postedBefore: 0, postedLast: 0,
});

/** How many pairs the report gives an outcome — `pairs` when every pair has exactly one. */
export function outcomes(r: FindingsReport): number {
  return r.posted.length + r.found.length + r.refused + r.offBoard + r.unreachable.length + r.failed.length + r.waitingOnCap + r.settledElsewhere + r.notReached + r.wouldPost;
}

/**
 * One run: select, group, and post up to the cap. Never throws for a pair —
 * a pair that fails is reported and left for the next run; the select and
 * the cap's read may throw (the caller's pass fails).
 *
 * Each post holds one lock for the whole brain (a transaction-scoped advisory
 * lock), re-reads what is recorded and re-counts the day's posts under it,
 * then posts and records in that transaction: two posters at once — the
 * loop and a hand run — post neither a pair twice nor past the cap (review
 * pass 1: the count was read once, before any lock).
 */
export async function postFindings(opts: PostOptions): Promise<FindingsReport> {
  const log = opts.log ?? ((l: string) => console.log(l));
  const warn = opts.warn ?? ((l: string) => console.error(l));
  const groups = groupFindings(await selectFindings(opts.sql));
  const postedBefore = await postedToday(opts.sql);
  const report: FindingsReport = { ...emptyReport(), pairs: groups.length, postedBefore, postedLast: postedBefore };
  let left = Math.max(0, opts.cap - postedBefore);
  const refuse = (on: string, reason: string, body: string) => {
    report.refused++;
    warn(`  not posted on ${on}: ${reason} — ${ALLOW_HINT}${opts.showRefused ? `. The comment:\n${indent(body)}` : ""}`);
  };
  for (const [n, g0] of groups.entries()) {
    if (opts.stopped?.()) { report.notReached += groups.length - n; break; }
    if (opts.board && !(opts.board.has(g0.a) && opts.board.has(g0.b))) { report.offBoard++; continue; }
    if (left === 0) { report.waitingOnCap++; continue; }
    const body0 = commentBody(g0);
    // The gate first: a refused comment costs no Linear request. A dry run asks it too.
    const gate0 = opts.gate(body0);
    if (opts.dryRun) {
      if (gate0.allowed) { report.wouldPost++; log(`  would post on ${g0.on}:\n${indent(body0)}`); left--; }
      else { report.refused++; log(`  would be refused on ${g0.on} (${gate0.reason}):\n${indent(body0)}`); }
      continue;
    }
    if (!gate0.allowed) { refuse(g0.on, gate0.reason, body0); continue; }
    try {
      // Both tickets' comments: another brain, or this one ranking the pair
      // another way, may have posted on the other (review pass 1).
      const other = g0.on === g0.a ? g0.b : g0.a;
      const on = await readTicket(opts.gql!, g0.on, g0.a, g0.b);
      const off = on ? await readTicket(opts.gql!, other, g0.a, g0.b) : null;
      if (!on || !off) {
        const ticket = on ? other : g0.on;
        if (opts.board) throw new Error(`the comment key cannot read ${ticket}, which the board lists — it must see the board's teams`);
        report.unreachable.push({ a: g0.a, b: g0.b, ticket });
        warn(`  not posted on ${g0.on}: Linear has no ticket ${ticket} this key can read (deleted, or out of its sight) — asked again next run`);
        continue;
      }
      const onBoard = new Set([...on.words, ...off.words]);
      const outcome = await opts.sql.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtext('ob1:board-findings'))`;
        const recorded = new Set(((await tx`SELECT word FROM board_findings_posted WHERE ticket_a = ${g0.a} AND ticket_b = ${g0.b}`) as { word: FindingWord }[]).map((r) => r.word));
        const found = onlyWords(g0, new Set(groupWords(g0).filter((w) => onBoard.has(w) && !recorded.has(w))));
        if (found) await record(tx, found, "found", null);
        const g = onlyWords(g0, new Set(groupWords(g0).filter((w) => !onBoard.has(w) && !recorded.has(w))));
        const foundWords = found ? groupWords(found) : [];
        if (!g) return { kind: foundWords.length ? "found" : "settled", foundWords } as const;
        const today = await postedToday(tx);
        if (today >= opts.cap) return { kind: "capped", foundWords, today } as const;
        const body = commentBody(g);
        // The body changed when a word was dropped; a marker: term reads the text sent.
        const gate = body === body0 ? gate0 : opts.gate(body);
        if (!gate.allowed) return { kind: "refused", foundWords, body, reason: gate.reason } as const;
        const made = (await strict<CommentAnswer>(opts.gql!, COMMENT_MUTATION, { issueId: on.id, body })).commentCreate;
        if (!made.success || !made.comment) throw new Error(`Linear did not create the comment on ${g.on}`);
        await record(tx, g, "posted", made.comment.id);
        return { kind: "posted", foundWords, words: groupWords(g), commentId: made.comment.id, today: today + 1 } as const;
      });
      report.foundWords += outcome.foundWords.length;
      if (outcome.foundWords.length) log(`  already on the board: ${g0.a} ~ ${g0.b} (${outcome.foundWords.join(", ")}) — recorded, not posted`);
      switch (outcome.kind) {
        case "found": report.found.push({ a: g0.a, b: g0.b, on: g0.on, words: outcome.foundWords }); break;
        case "settled": report.settledElsewhere++; break;
        case "capped": report.waitingOnCap++; report.postedLast = outcome.today; left = 0; break;
        case "refused": refuse(g0.on, outcome.reason, outcome.body); break;
        case "posted":
          report.posted.push({ a: g0.a, b: g0.b, on: g0.on, words: outcome.words, commentId: outcome.commentId });
          report.postedLast = outcome.today;
          log(`  posted on ${g0.on}: ${g0.a} ~ ${g0.b} (${outcome.words.join(", ")})`);
          left = Math.max(0, opts.cap - outcome.today);
          break;
      }
    } catch (e) {
      const error = (e as Error).message.split("\n")[0];
      report.failed.push({ a: g0.a, b: g0.b, error });
      warn(`  not posted on ${g0.on}: ${error} — nothing recorded; the next run tries again`);
    }
  }
  return report;
}

const indent = (s: string) => s.split("\n").map((l) => `    | ${l}`).join("\n");

/** The run's one summary line: one outcome per pair. */
export function summaryLine(r: FindingsReport, cap: number, dryRun: boolean): string {
  if (r.pairs === 0) return `  findings: none to post (no unlinked ticket pair the board has not been told about)`;
  const parts = [
    ...(dryRun ? [`${r.wouldPost} would be posted`] : [`${r.posted.length} posted`]),
    ...(r.found.length ? [`${r.found.length} already on the board`] : []),
    ...(r.refused ? [`${r.refused} ${dryRun ? "would be " : ""}refused by the egress gate`] : []),
    ...(r.offBoard ? [`${r.offBoard} with a ticket the board no longer lists or this pass could not sync`] : []),
    ...(r.unreachable.length ? [`${r.unreachable.length} with a ticket Linear does not have for this key`] : []),
    ...(r.failed.length ? [`${r.failed.length} failed`] : []),
    ...(r.settledElsewhere ? [`${r.settledElsewhere} settled by another poster meanwhile`] : []),
    ...(r.waitingOnCap ? [`${r.waitingOnCap} waiting on the cap (${cap} a day; ${r.postedLast} posted in the last 24 h)`] : []),
    ...(r.notReached ? [`${r.notReached} not reached (stopped)`] : []),
  ];
  return `  findings: ${r.pairs} ticket pair(s) with a finding the board has not been told — ${parts.join(", ")}`;
}

/**
 * Whether board-sync runs the step this pass, and whether to warn that the
 * comment key is the read key: on when the key is set, never under --audit
 * (it writes nothing) or --only (a pass over named tickets has not brought
 * the rest of the board's links in). Pure, so the wiring is tested without
 * Linear (review pass 2).
 */
export function findingsWanted(env: Record<string, string | undefined>, opts: { readKey: string; audit: boolean; only: boolean }): { run: boolean; sameKey: boolean } {
  const key = env.LINEAR_COMMENT_API_KEY?.trim();
  const run = !!key && !opts.audit && !opts.only;
  return { run, sameKey: run && key === opts.readKey.trim() };
}

/**
 * The tickets the step may post between this pass: the census, less every
 * ticket the pass failed to sync — its links were not brought in, so "not
 * linked" cannot be read on it (review pass 3: a pair Linear linked this
 * very pass was posted when the ticket's fetch failed). Such a pair counts as
 * off the board and waits for a pass that syncs it.
 */
export function boardOf(listed: readonly string[], unsynced: readonly string[]): Set<string> {
  const out = new Set(listed);
  for (const id of unsynced) out.delete(id);
  return out;
}

/** A pass's exit code: 1 when the sync or the findings step failed. */
export const passCode = (syncErrors: number, findingsCode: number): number => (syncErrors || findingsCode ? 1 : 0);

// ── The step as board-sync and the CLI set it up ────────────────────────────

export type FindingsStep = { run: (opts: { dryRun: boolean; stopped?: () => boolean; board?: ReadonlySet<string> }) => Promise<number> };

/**
 * The step, or the reason it is off, from the environment: the comment key,
 * the cap, the egress policy and the schema. `cap` from a flag wins over the
 * knob. A bad cap is configuration (exit 2 for the caller); a refusing policy
 * or a missing migration turns the step off with a sentence to print once.
 */
export async function findingsStep(sql: SQL, env: Record<string, string | undefined>, opts: { cap?: string; fetchImpl?: typeof fetch; url?: string; timeoutMs?: number; dryRun?: boolean } = {}):
  Promise<{ step: FindingsStep; cap: number; banner: string } | { off: string } | { error: string }> {
  const capRead = opts.cap !== undefined ? readCap(opts.cap) : readCap(env.OB1_FINDINGS_POST_CAP, "OB1_FINDINGS_POST_CAP");
  if (typeof capRead !== "number") return { error: capRead.error };
  const cap = capRead;
  const key = env.LINEAR_COMMENT_API_KEY?.trim();
  if (!key) return { off: "LINEAR_COMMENT_API_KEY is not set" };
  const policy = resolveEgressPolicy(env as EgressEnv);
  const blanket = egressRefusal(LINEAR_ENDPOINT, policy, FINDING_UNITS);
  if (blanket) return { off: `the egress gate refuses every comment: ${blanket} — ${ALLOW_HINT}` };
  // A dry run records nothing, so board-sync's --dry-run needs the reads alone (review pass 3).
  const schema = await findingsSchemaProblem(sql, { write: !opts.dryRun });
  if (schema) return { off: schema };
  const gql = linearClient(key, opts.fetchImpl ?? fetch, { url: opts.url, timeoutMs: opts.timeoutMs ?? LINEAR_TIMEOUT_MS });
  const gate = findingGate(policy);
  const banner = `findings to the board: up to ${cap} comment(s) a day, each through the egress gate`;
  return {
    cap,
    banner,
    step: {
      run: async ({ dryRun, stopped, board }) => {
        const r = await postFindings({ sql, gql: dryRun ? null : gql, cap, dryRun, gate, stopped, board });
        console.log(summaryLine(r, cap, dryRun));
        return r.failed.length ? 1 : 0;
      },
    },
  };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

async function main(): Promise<never> {
  const cli = commandLine("board-findings.ts", { url: "one", "dry-run": "none", cap: "one" },
    { hints: { url: "<postgres://…>", cap: `<comments a day> (OB1_FINDINGS_POST_CAP, else ${DEFAULT_CAP})` } });
  const envSources = loadEnv();
  const url = databaseUrl(cli.value("url"));
  const dryRun = cli.has("dry-run");
  const capRead = readCap(cli.value("cap") ?? process.env.OB1_FINDINGS_POST_CAP);
  if (typeof capRead !== "number") { console.error(capRead.error); process.exit(2); }
  const cap = capRead;
  const sql = openSql(url, { max: 1 });
  return closeThenExit(sql, async () => {
    const schema = await findingsSchemaProblem(sql, { write: !dryRun });
    if (schema) { console.error(`  Nothing can be posted: ${schema}.`); return 2; }
    const policy = resolveEgressPolicy(process.env as EgressEnv);
    const blanket = egressRefusal(LINEAR_ENDPOINT, policy, FINDING_UNITS);
    const key = process.env.LINEAR_COMMENT_API_KEY?.trim();
    // Refused wholesale, or a dry run: print what would be posted, post nothing.
    if (dryRun || blanket) {
      if (blanket && !dryRun) console.error(`  Nothing will be posted: ${blanket} — ${ALLOW_HINT}. What would be posted is printed instead.`);
      const r = await postFindings({ sql, gql: null, cap, dryRun: true, gate: findingGate(policy), showRefused: true });
      console.log(summaryLine(r, cap, true));
      return 0;
    }
    if (!key) {
      console.error(`LINEAR_COMMENT_API_KEY is not set, and no .env file supplied it: a Linear key that can comment (not board-sync's LINEAR_API_KEY, which only reads). --dry-run needs none.\n  Read: ${describeEnv(envSources)}`);
      return 2;
    }
    const gql = linearClient(key, fetch, { timeoutMs: LINEAR_TIMEOUT_MS });
    const r = await postFindings({ sql, gql, cap, dryRun: false, gate: findingGate(policy), showRefused: true });
    console.log(summaryLine(r, cap, false));
    return r.failed.length ? 1 : 0;
  });
}

if (import.meta.main) await main();
