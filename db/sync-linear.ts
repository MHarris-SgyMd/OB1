#!/usr/bin/env bun
/**
 * sync-linear.ts — keep a brain in lockstep with the Linear board (SMD-1954).
 *
 * The dogfood brain held the Open Brain board only as hand captures: an agent
 * pasted each ticket through capture_thought, and a ticket that moved to Done
 * kept reading Backlog until someone pasted it again — which made a second
 * row, not an update (three identifiers had two or more rows when this landed).
 * On 2026-09-22 one session hand-ingested eight tickets in two sweeps because
 * another session kept filing between asks. This tool is that sweep, committed
 * and repeatable: every issue in the Open Brain initiative's projects becomes
 * one thought, in the SAME text shape the hand captures used (so the first
 * run rewrites only what really changed), and an issue that moves, is renamed
 * or gains a label updates its existing row instead of duplicating it.
 *
 *   bun db/sync-linear.ts --url postgres://…                 # one pass
 *   bun db/sync-linear.ts --url … --dry-run                  # what a pass would write; nothing written
 *   bun db/sync-linear.ts --url … --loop                     # a pass every OB1_BOARD_SYNC_INTERVAL seconds (300)
 *   bun db/sync-linear.ts --url … --audit                    # the lockstep census alone: missing / stale / extra, exit 1 when any
 *   bun db/sync-linear.ts --url … --full                     # every issue re-rendered and compared, not only the moved ones
 *   bun db/sync-linear.ts --self-check                       # the pure parts and the write decisions, no network, no database
 *
 * ── What it reads, what it writes ────────────────────────────────────────────
 * The BRAIN is the state. There is no done-file and no watermark to lose (the
 * deploy/.env loss of 2026-09-21 is why): a pass lists every issue's identifier
 * and updatedAt from Linear (two requests for ~300 issues), reads every
 * ticket row from the brain, and the diff is the work — an identifier the brain
 * lacks is captured, one whose `linear_updated_at` is older than Linear's is
 * fetched in full and compared, the rest are left alone. Killed mid-pass, the
 * next pass finds exactly the rows that did not land. Re-run over an unchanged
 * board, it writes nothing — the Verify the ticket asks for, by construction.
 *
 * A row is a TICKET ROW when its metadata says `issue: SMD-N` (this tool's
 * rows, and db/ingest-records.ts's — the same key, so a stable brain rebuilt
 * from a corpus dump is adopted, not duplicated) or, before it has been
 * adopted, when its text opens with the hand-capture header this tool renders
 * (`SMD-N — title` / `Project: … · Status: …` / the Linear URL). A note that
 * merely BEGINS "SMD-N — DONE …" is not a ticket row and is never touched: the
 * grammar is the boundary, not the identifier. When one identifier has several
 * ticket rows (the hand re-captures), the row that already says what Linear
 * says — by the fingerprint rule the database judges duplicates with — else
 * the newest is the HEAD, and the rest are chained under it by `supersedes`
 * (032), so search labels them rather than returning a Backlog and a Done
 * answer; nothing is deleted. A pointer the hand set to a thought outside the
 * group is kept at the chain's tail, not erased.
 *
 * WRITES go through the server's own store — server-portable/store-sql.ts's
 * captureThought and updateThought over upsert_thought / update_thought — with
 * the vector from the same embedder a capture uses (embed.ts), the tags from
 * the same extraction (metadata.ts), the egress gate asked first (SMD-1903:
 * refused, the row lands without a vector and the decision is on its audit
 * row) and an actor on every row: name `board-sync`, via this file. So a
 * synced ticket is indistinguishable from a captured one in every column but
 * `metadata.source`, which says `linear` — SMD-1806 rule 5 — beside the facets
 * Linear knows: issue, project, status, status_type, priority, labels, parent,
 * linear_updated_at, url, archived_at. The text, the facets and the structure
 * come from the Linear ADAPTER (db/ingest-linear.ts, SMD-1867's reference
 * implementation of the ingestion contract; SMD-1865 is what it answers):
 * Linear's autolink markup (`<issue …>SMD-x</issue>`) is stripped to the
 * identifier in the text, and once the head row is written the pass records
 * beside it — through the Writer's `structure` hook, db/ingest-records.ts's
 * recordStructure — the issue as fetched as its CANONICAL (thought_sources),
 * its cross-references, parent and relations as `link` facets (a set: a
 * relation Linear drops is closed, not deleted) and its project and labels as
 * mentions under `source:linear`, which 016's extractor never displaces
 * (migration 051). No model call for any of it.
 *
 * The provider settings are the server's (OB1_LLM_BASE_URL, OB1_EMBEDDING_*,
 * OB1_METADATA_MODEL, OB1_LLM_LOCAL, OB1_EGRESS_*…), resolved once at start by
 * resolveEmbedConfig as db/reembed.ts does. LINEAR_API_KEY is the one knob of
 * its own; OB1_LINEAR_INITIATIVE (default "Open Brain") names the initiative
 * whose projects are the board; OB1_BOARD_SYNC_INTERVAL the loop's period.
 * All of them — the provider knobs too — are read from the environment, else
 * from the `.env` files on db/env.ts's search path ($OB1_ENV_FILE, evals/.env,
 * <repo>/.env, deploy/.env), so a run from a checkout resolves the same knobs a
 * server started from deploy/.env does; in the container none of those files
 * is on the mount (db/ and server-portable/ alone), so the environment compose
 * forwarded is all there is. A run whose egress gate would refuse every
 * embedding, or every chat call — the default policy against an endpoint not
 * declared local — is refused up front rather than landing every ticket bare
 * (or tagged `egress_denied`, which nothing revisits) and calling it synced;
 * --allow-refused is the operator saying that is meant.
 *
 * ── What it does not do ──────────────────────────────────────────────────────
 * Remove: an issue deleted in Linear or moved out of the initiative keeps its
 * row, reported under "extra" by --audit (ingest-records.ts has the same rule).
 * Comments: the corpus builder (evals/build-linear-corpus.ts) appends them for
 * the retrieval eval; the board mirror keeps the hand captures' shape, which
 * had none. A webhook: exact and immediate, but it needs an inbound URL the
 * stack has no origin for until SMD-1846, and SMD-1862 owns the Linear webhook
 * handler's shape (signature, replay window, loop guard); when both land the
 * handler calls runPass({ only: [identifier] }) here with the one identifier
 * it was told — the census still runs, so the plan is the same one a
 * scheduled pass would make.
 */

import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SQL } from "bun";
import { SqlStore } from "../server-portable/store-sql.ts";
import { createEmbedder, resolveEmbedConfig, type EmbedConfig, type EmbedEnv, type EmbeddedCapture } from "../server-portable/embed.ts";
import { decideCalls, refusesEverything, type EgressSubject } from "../server-portable/egress.ts";
import { extractMetadata, metadataRefused, tagsOverExisting } from "../server-portable/metadata.ts";
import type { Actor } from "../server-portable/store.ts";
import { describeEnv, loadEnv } from "./env.ts";
import { linearClient, strict, type Gql } from "./linear-api.ts";
import { IDENTIFIER_PATTERN, issueFacets, labelNames, linearAdapter, renderIssue, SAMPLE_ISSUE, stripAutolinks, type LinearIssue } from "./ingest-linear.ts";
// From ingest-structure.ts, NOT ingest-records.ts: the ingester imports evals/
// and scripts/, which the board-sync container does not mount (third review
// pass; the self-check holds this file's import closure to db/ and
// server-portable/).
import { recordStructure, runName, type Structure } from "./ingest-structure.ts";

// The Linear adapter's pure rules, re-exported: the renderer, the facets and
// the markup strip moved to db/ingest-linear.ts (SMD-1867) so the sync and
// the ingester render a ticket one way (SMD-1958); callers of this module see
// the same names.
export { IDENTIFIER_PATTERN, issueFacets, labelNames, renderIssue, stripAutolinks, type LinearIssue };

export const DEFAULT_INITIATIVE = "Open Brain";
export const DEFAULT_INTERVAL_S = 300;
export const ACTOR_NAME = "board-sync";
const SELF = "db/sync-linear.ts";

// ---------------------------------------------------------------------------
// The issue, as Linear gives it and as the brain stores it — pure functions.
// ---------------------------------------------------------------------------

/** The identifier at the head of a ticket row (a team key of one letter or more), and the header grammar the hand captures used. */
// One spelling of the grammar (IDENTIFIER_PATTERN, the adapter's), in a dialect
// both engines read the same (character classes, `*`, `[^\n]`), so the JS test
// and the SQL pre-filter cannot drift apart — a widening of one that the other
// did not get would drop hand pastes before ticketIdentifier saw them (tenth
// review pass).
export const HEADER_PATTERN = `^${IDENTIFIER_PATTERN} — [^\n]*\nProject: `;
export const IDENTIFIER_RE = new RegExp(`^(${IDENTIFIER_PATTERN})\\b`);
const HEADER_RE = new RegExp(`^(${IDENTIFIER_PATTERN}) — [^\\n]*\\nProject: [^\\n]*\\nhttps:\\/\\/linear\\.app\\/[^\\n]*(?:\\n|$)`);

/**
 * A brain row as this tool reads it. `fingerprint` is `content_fingerprint`
 * (016's rule: sha256 of the text lower-cased, trimmed, whitespace collapsed),
 * the identity update_thought judges DUPLICATE_CONTENT by — so "already holds
 * this text" is asked in the database's terms, not by an exact string compare
 * a trailing newline defeats (second review pass). NULL on a row 018 left
 * unfingerprinted.
 */
export type BrainRow = { id: string; content: string; metadata: Record<string, unknown>; created_at: string | null; supersedes: string | null; fingerprint: string | null };

/**
 * The identifier a row is a ticket row FOR, or null. Adopted rows say so in
 * metadata.issue; a hand capture is recognised by the header grammar alone —
 * a note that opens "SMD-N — DONE 2026-09-22: …" with no facet line is a
 * note, whatever its first token, and stays untouched.
 */
export function ticketIdentifier(row: Pick<BrainRow, "content" | "metadata">): string | null {
  const claimed = row.metadata?.issue;
  // The identifier the claim OPENS with, as the header branch reads it: a
  // claim with a suffix ("SMD-12 (old)") would otherwise become a group key
  // no census row ever matches — extra every pass, and SMD-12 captured again.
  const c = typeof claimed === "string" ? IDENTIFIER_RE.exec(claimed) : null;
  if (c) return c[1];
  const m = HEADER_RE.exec(row.content);
  return m ? m[1] : null;
}

/**
 * The brain's ticket rows grouped by identifier, the row kept current first.
 * Current is the row no other row of the group supersedes — the chain is the
 * truth — and among those the newest; the rest follow, newest first. Ties on
 * created_at (a same-second double paste) fall to the id so the order is
 * stable across passes. syncIssue may still choose another head (the row that
 * already holds Linear's text); it then re-chains so this rule agrees next pass.
 */
export function groupTicketRows(rows: BrainRow[]): Map<string, BrainRow[]> {
  const byIssue = new Map<string, BrainRow[]>();
  for (const row of rows) {
    const key = ticketIdentifier(row);
    if (!key) continue;
    const list = byIssue.get(key) ?? [];
    list.push(row);
    byIssue.set(key, list);
  }
  for (const list of byIssue.values()) {
    list.sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? "") || a.id.localeCompare(b.id));
    const superseded = new Set(list.map((r) => r.supersedes).filter((s): s is string => s !== null));
    const byId = new Map(list.map((r) => [r.id, r]));
    // The order IS the chain: from each unsuperseded row (newest first) follow
    // its pointers, so a group whose chain already stands comes back in the
    // order desiredPointers would set and a pass writes nothing — where a sort
    // by age below the head re-chained an unchanged board on every second pass
    // and inverted a hand-set supersession between two twins (thirteenth review
    // pass). A row no pointer reaches (a cycle's remainder) follows by age.
    const ordered: BrainRow[] = [];
    const seen = new Set<string>();
    for (const start of list.filter((r) => !superseded.has(r.id))) {
      let cur: BrainRow | undefined = start;
      while (cur && !seen.has(cur.id)) { seen.add(cur.id); ordered.push(cur); cur = cur.supersedes ? byId.get(cur.supersedes) : undefined; }
    }
    for (const r of list) if (!seen.has(r.id)) ordered.push(r);
    list.splice(0, list.length, ...ordered);
  }
  return byIssue;
}

/**
 * The `supersedes` pointer each row of one identifier should carry, given the
 * order the head decides: head → next → … → last, and the last carries the
 * first pointer any of them held to a thought OUTSIDE the group (a design note
 * the hand named on capture), so a person's provenance survives at the chain's
 * tail rather than being erased or left to strand a twin. Returned as
 * `[row, wanted]` for the rows whose pointer differs; applied by chainRows in
 * two phases — every differing non-null pointer cleared, then every wanted one
 * set — so no intermediate state closes a loop: after the clears the only
 * in-group pointers left are already-wanted ones along a linear order. The
 * two-step swap this replaces re-linked only two rows and, with three where the
 * text-holder was the oldest, left the middle twin as head and every later pass
 * on WOULD_CYCLE (second review pass).
 */
export function desiredPointers(order: BrainRow[]): { row: BrainRow; wanted: string | null; dropped?: string[] }[] {
  const ids = new Set(order.map((r) => r.id));
  const foreign = order.map((r) => r.supersedes).filter((s): s is string => s !== null && !ids.has(s));
  // One tail, one pointer: a second outside pointer cannot be kept, and is
  // named on the last row's change so the pass says so (eighth review pass).
  const dropped = foreign.slice(1);
  const out: { row: BrainRow; wanted: string | null; dropped?: string[] }[] = [];
  for (let i = 0; i < order.length; i++) {
    const wanted = i + 1 < order.length ? order[i + 1].id : foreign[0] ?? null;
    if (order[i].supersedes !== wanted) out.push({ row: order[i], wanted, ...(i + 1 === order.length && dropped.length ? { dropped } : {}) });
  }
  return out;
}

/** The facets that differ between what the row carries and what Linear says — the metadata patch, or nothing. */
export function facetPatch(current: Record<string, unknown>, wanted: Record<string, unknown>): Record<string, unknown> | null {
  const patch: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(wanted)) {
    if (JSON.stringify(current[k] ?? null) !== JSON.stringify(v ?? null)) patch[k] = v;
  }
  return Object.keys(patch).length ? patch : null;
}

/**
 * One census row: the identifier, when the issue last changed, and the three
 * names the text and facets carry that Linear can RENAME without touching the
 * issue's updatedAt — its project, its state, its labels. The plan compares
 * them with the current row's facets, so a renamed project or workflow state
 * reaches the brain on the next pass instead of waiting for `--full` (ninth
 * review pass). Optional, so a plan can still be made from identifiers alone.
 */
export type CensusRow = { identifier: string; updatedAt: string; project?: string | null; status?: string; labels?: string[] };
export type Census = CensusRow[];

/** Whether a census row's names disagree with what the current row's facets say — a rename the watermark cannot see. */
export function namesMoved(c: CensusRow, metadata: Record<string, unknown> | undefined): boolean {
  const m = metadata ?? {};
  if (c.project !== undefined && JSON.stringify(m.project ?? null) !== JSON.stringify(c.project ?? null)) return true;
  if (c.status !== undefined && m.status !== c.status) return true;
  if (c.labels !== undefined && JSON.stringify(m.labels ?? []) !== JSON.stringify([...c.labels].sort((a, b) => a.localeCompare(b, "en")))) return true;
  return false;
}
export type Plan = { fetch: string[]; missing: string[]; stale: string[]; extra: string[]; unchanged: number };

/**
 * The plan for one identifier from the census: which issues a pass must fetch
 * in full. `missing` — no ticket row; `stale` — the row's linear_updated_at is
 * older than Linear's, or absent (a hand capture, adopted on first sight), or
 * its tags fell back, or a name the census carries moved; `extra` — a ticket
 * row Linear's list does not name (deleted, or moved out of the initiative).
 * `full` puts every listed issue in the fetch.
 */
export function planPass(census: Census, groups: Map<string, BrainRow[]>, full = false): Plan {
  const missing: string[] = [], stale: string[] = [], fetch: string[] = [];
  let unchanged = 0;
  const listed = new Set<string>();
  for (const c of census) {
    const { identifier, updatedAt } = c;
    listed.add(identifier);
    const rows = groups.get(identifier);
    if (!rows) { missing.push(identifier); fetch.push(identifier); continue; }
    // The newest watermark any row of the group carries — not the first row's:
    // a hand twin left unsuperseded by a refused pointer, newer than the head
    // and without a watermark, would otherwise keep the ticket stale forever
    // (fifth review pass).
    const have = rows.map((r) => r.metadata?.linear_updated_at).filter((v): v is string => typeof v === "string").sort().at(-1);
    // The names are judged on the row that carries the newest watermark — the
    // row the pass last wrote — not on rows[0]: when a holder the pass promoted
    // cannot be chained over it (a hand-set pointer the database refuses),
    // rows[0] keeps the old names for good and the ticket would be stale
    // forever while the writer called it unchanged (tenth review pass).
    // A row whose TAGS fell back (a provider timeout at capture) is not the
    // plan's concern: repairing tags is SMD-1975's worker, for every thought,
    // not this sync's for ticket rows alone — a branch that lived here from
    // the seventh review pass to the twelfth and left before the merge.
    const written = rows.find((r) => r.metadata?.linear_updated_at === have) ?? rows[0];
    const isStale = have === undefined || have < updatedAt || namesMoved(c, written.metadata);
    if (isStale) { stale.push(identifier); fetch.push(identifier); }
    else if (full) fetch.push(identifier);
    else unchanged++;
  }
  const extra = [...groups.keys()].filter((k) => !listed.has(k)).sort();
  return { fetch, missing, stale, extra, unchanged };
}

/** The patch that clears a refusal marker a row carries, or nothing — one spelling for the three places that ask (seventh review pass). */
export function refusalClear(metadata: Record<string, unknown> | undefined): { text_refused_by: null } | Record<never, never> {
  return metadata && metadata.text_refused_by != null ? { text_refused_by: null } : {};
}

// ---------------------------------------------------------------------------
// Linear
// ---------------------------------------------------------------------------

/**
 * The board named is not a board: no initiative by that name, or two, or one
 * with no projects or more than one page of them. Configuration, which a
 * restart does not fix — main exits 2 on it — where a Linear transport error
 * at the same call is transient and is retried (twelfth review pass: a 502 at
 * boot was exiting 2 and, under `restart: on-failure:3`, stopping the sidecar
 * for good).
 */
export class BoardConfigError extends Error {}

// The client — the endpoint, the authorization rule, errors beside data — is
// db/linear-api.ts, one definition with the corpus builder (SMD-1985's move; it began under this ticket's third review pass).

/**
 * The projects of the named initiative — the board. Matched on the exact name,
 * else on the name's prefix when exactly one initiative starts with it. The
 * initiatives are paged; an initiative's projects are asked for in one page and
 * the tool refuses to go on when there are more — a census silently short of a
 * project would report its tickets extra and never capture its new ones.
 */
export async function initiativeProjects(gql: Gql, name: string): Promise<{ initiative: string; projects: { id: string; name: string }[] }> {
  type Node = { name: string; projects: { pageInfo: { hasNextPage: boolean }; nodes: { id: string; name: string }[] } };
  type R = { initiatives: { pageInfo: { hasNextPage: boolean; endCursor: string }; nodes: Node[] } };
  const all: Node[] = [];
  let after: string | null = null;
  do {
    const d: R = await strict<R>(gql, `query($after: String) { initiatives(first: 50, after: $after) { pageInfo { hasNextPage endCursor } nodes { name projects(first: 50, includeArchived: true) { pageInfo { hasNextPage } nodes { id name } } } } }`, { after });
    all.push(...d.initiatives.nodes);
    after = d.initiatives.pageInfo.hasNextPage ? d.initiatives.pageInfo.endCursor : null;
  } while (after);
  const exact = all.filter((i) => i.name === name);
  const prefixed = exact.length ? exact : all.filter((i) => i.name.startsWith(name));
  if (prefixed.length !== 1) {
    throw new BoardConfigError(`OB1_LINEAR_INITIATIVE="${name}" matches ${prefixed.length} initiative(s) (${all.map((i) => JSON.stringify(i.name)).join(", ")}); name one.`);
  }
  if (prefixed[0].projects.pageInfo.hasNextPage) throw new BoardConfigError(`initiative "${prefixed[0].name}" has more than 50 projects and this tool reads one page of them; page the projects query before syncing this board.`);
  // No projects is no board: the census would be empty and every ticket row in the brain `extra` (seventh review pass).
  if (prefixed[0].projects.nodes.length === 0) throw new BoardConfigError(`initiative "${prefixed[0].name}" has no projects; nothing to sync — name an initiative whose projects hold the board.`);
  return { initiative: prefixed[0].name, projects: prefixed[0].projects.nodes };
}

/**
 * Every issue's identifier and updatedAt across the projects: the census.
 * Archived issues are included — a completed ticket Linear auto-archived is
 * still a ticket — but a TRASHED one (deleted in Linear; `includeArchived`
 * returns those too) is not: it must fall out of the census so the brain's row
 * shows up as `extra` and a fresh deletion is never captured (third review pass).
 */
export async function censusOf(gql: Gql, projectIds: string[]): Promise<Census> {
  type Node = { identifier: string; updatedAt: string; trashed: boolean | null; project: { name: string } | null; state: { name: string }; labels: { nodes: { name: string }[] } };
  type R = { issues: { pageInfo: { hasNextPage: boolean; endCursor: string }; nodes: Node[] } };
  const out: Census = [];
  let after: string | null = null;
  do {
    const d: R = await strict<R>(
      gql,
      // 100 issues a page with the labels connection bounded: Linear costs a
      // request by its nodes, and 250 issues each with an unbounded connection
      // could reach its per-request cap on a board this size or larger — a
      // refused census is no census (eleventh review pass).
      `query($ids: [ID!], $after: String) { issues(first: 100, after: $after, includeArchived: true, filter: { project: { id: { in: $ids } } }) { pageInfo { hasNextPage endCursor } nodes { identifier updatedAt trashed project { name } state { name } labels(first: ${LABELS_BOUND}) { nodes { name } } } } }`,
      { ids: projectIds, after },
    );
    out.push(...d.issues.nodes.filter((n) => !n.trashed).map((n) => ({ identifier: n.identifier, updatedAt: n.updatedAt, project: n.project?.name ?? null, status: n.state.name, labels: n.labels.nodes.map((l) => l.name) })));
    after = d.issues.pageInfo.hasNextPage ? d.issues.pageInfo.endCursor : null;
  } while (after);
  return out;
}

// Labels bounded as the census bounds them (twelfth review pass): the two must
// see the same set, or an issue with more labels than the bound would read
// `namesMoved` on every pass and never be unchanged.
export const LABELS_BOUND = 20;
/** Relations an issue holds, and those held toward it, per request — the structure the adapter turns into `link` facets (SMD-1867); a ticket with more is rare and its links beyond the bound wait for the day the bound is raised. */
export const RELATIONS_BOUND = 25;
const ISSUE_FIELDS = `identifier title description url createdAt updatedAt archivedAt priorityLabel state { name type } project { id name } parent { identifier } labels(first: ${LABELS_BOUND}) { nodes { name } } relations(first: ${RELATIONS_BOUND}) { nodes { type relatedIssue { identifier } } } inverseRelations(first: ${RELATIONS_BOUND}) { nodes { type issue { identifier } } }`;

/**
 * The issues named, in full, fifty a request: one query with an alias per
 * issue (`issue(id:)` takes an identifier as well as a uuid; the list filter's
 * `id: { in }` takes uuids only), so a first pass over three hundred tickets is
 * six requests, not three hundred. One alias the API refuses — an issue deleted
 * between the census and this fetch, or one the key cannot read — comes back as
 * a null alias with an error naming its path; it is reported under `failed` and
 * the other forty-nine proceed, where a client that threw on any error dropped
 * the whole batch and, outside the per-issue try, the whole pass (second
 * review pass).
 */
export async function fetchIssues(gql: Gql, identifiers: string[]): Promise<{ issues: LinearIssue[]; failed: { identifier: string; error: string }[] }> {
  const issues: LinearIssue[] = [];
  const failed: { identifier: string; error: string }[] = [];
  for (let i = 0; i < identifiers.length; i += 50) {
    const batch = identifiers.slice(i, i + 50);
    const vars = Object.fromEntries(batch.map((ident, j) => [`i${j}`, ident]));
    const decl = batch.map((_, j) => `$i${j}: String!`).join(", ");
    const fields = batch.map((_, j) => `a${j}: issue(id: $i${j}) { ${ISSUE_FIELDS} }`).join("\n");
    // The whole query refused — HTTP 200 with errors and no data (a complexity
    // limit), or a non-2xx the client throws on (HTTP 429): the batches behind
    // it would be refused the same way, so they are reported as not attempted
    // and the pass moves on with its report intact — the next pass retries
    // (ninth review pass; the thrown shape the tenth).
    let r: { data: Record<string, LinearIssue | null> | null; errors: { message: string; path?: (string | number)[] }[] };
    try { r = await gql<Record<string, LinearIssue | null>>(`query(${decl}) { ${fields} }`, vars); }
    catch (e) { r = { data: null, errors: [{ message: (e as Error).message }] }; }
    if (r.data === null) {
      const why = r.errors.map((e) => e.message).join("; ") || "no data and no error";
      for (const ident of batch) failed.push({ identifier: ident, error: why });
      for (const ident of identifiers.slice(i + 50)) failed.push({ identifier: ident, error: `not attempted — the batch before it was refused whole (${why})` });
      break;
    }
    for (let j = 0; j < batch.length; j++) {
      const n = r.data[`a${j}`];
      if (n) { issues.push(n); continue; }
      failed.push({ identifier: batch[j], error: r.errors.find((e) => e.path?.[0] === `a${j}`)?.message ?? "not returned in full" });
    }
  }
  return { issues, failed };
}

// ---------------------------------------------------------------------------
// The pass
// ---------------------------------------------------------------------------

export type Outcome = "captured" | "updated" | "patched" | "unchanged" | "refused";
export type PassReport = {
  initiative: string;
  projects: number;
  census: number;
  plan: Plan;
  tally: Record<Outcome, number>;
  twinsMarked: number;
  noVector: number;
  errors: { identifier: string; error: string }[];
  /** Pointers the database refused while chaining twins — the ticket itself landed; the chain is as it was. */
  chainRefusals: { identifier: string; refusal: string }[];
  /** Rows whose vector is the head window's, the provider having refused the whole text — reembed.ts --retry-fallbacks repairs them. */
  headWindow: number;
  /** Issues left unwritten because the pass was asked to stop; the next pass finds them. */
  stopped?: number;
};

export type Writer = {
  store: Pick<SqlStore, "captureThought" | "updateThought">;
  cfg: EmbedConfig;
  /** The embedder's own shape (embed.ts): the three fields a write records, and the caveats it should say — a head-window vector standing in for the whole text, windows that went in without their blurb. */
  embed: (content: string, subject: EgressSubject) => Promise<Pick<EmbeddedCapture, "embedding" | "model" | "chunks"> & Partial<Pick<EmbeddedCapture, "wholeContentFellBack" | "wholeContentError" | "contextFailures">>>;
  tags: (content: string, subject: EgressSubject) => Promise<Record<string, unknown>>;
  /** `content_fingerprint_of(text)` — the database's own rule, asked of the database. Null when it cannot be asked (a brain before 016), and the exact compare stands in. */
  fingerprintOf: (text: string) => Promise<string | null>;
  /** The thought carrying this fingerprint, whatever its text says, as a row this tool can read (ticketIdentifier decides whose it is) — or null. */
  holderOf: (fingerprint: string) => Promise<BrainRow | null>;
  actor: Actor;
  dryRun: boolean;
  log: (line: string) => void;
  /** Asked between issues: true ends the pass after the issue in hand (SIGTERM under --loop). */
  stopping?: () => boolean;
  /**
   * The structure beside the head row (SMD-1867): called with the row that
   * holds the ticket after each write or adoption — never under --dry-run,
   * never for a text refused as another ticket's — with what the adapter
   * mapped; db/ingest-records.ts's recordStructure is the one implementation,
   * the self-check records the calls. Absent, the pass writes rows alone (a
   * brain before 051).
   */
  structure?: (thoughtId: string, structure: Structure) => Promise<void>;
};

/**
 * Read every ticket row the brain has: adopted rows by their claim
 * (`metadata ? 'issue'`, indexable), and — when asked — hand captures by their
 * header, a regex over every thought's text that no index serves. runPass asks
 * for the header scan when the plan over the claimed rows has a `missing`
 * identifier (a hand paste is the one thing that could hold it), under `--full`
 * and under `--audit`; a scheduled pass with nothing missing pays the claim
 * alone. The third review pass skipped the scan whenever ANY claimed row
 * existed, which on a brain with one ingested or model-tagged `issue` row hid
 * every hand capture and would have captured the moved ones twice (fourth).
 */
export async function readTicketRows(sql: SQL, opts: { scanHeaders: boolean; claimed?: BrainRow[] } = { scanHeaders: false }): Promise<BrainRow[]> {
  // The claimed rows a caller already read are not read again (sixth review pass).
  const claimed = opts.claimed ?? ((await sql`SELECT ${rowColumns(sql)} FROM thoughts WHERE metadata ? 'issue'`) as BrainRow[]);
  if (!opts.scanHeaders) return claimed;
  // The header grammar in SQL is only a pre-filter; ticketIdentifier() decides.
  // `metadata` is nullable (001): `NOT (NULL ? 'issue')` is NULL, not true, and
  // a raw-inserted paste with no metadata was invisible to both reads (eighth
  // review pass).
  const byHeader = (await sql`
    SELECT ${rowColumns(sql)} FROM thoughts
    WHERE NOT (COALESCE(metadata, '{}'::jsonb) ? 'issue') AND content ~ ${HEADER_PATTERN}`) as BrainRow[];
  return [...claimed, ...byHeader];
}

/**
 * The one projection of a thought as a BrainRow — readTicketRows' two queries
 * and main's holderOf all select it, so a field added to BrainRow reaches every
 * row that enters syncIssue (sixth review pass). `created_at` is spelled in
 * UTC: the `::text` of a timestamptz carries the session's offset, and across a
 * DST change that text does not sort as the instants do, which would have made
 * the older of two pastes the head.
 */
function rowColumns(sql: SQL) {
  return sql`id::text AS id, content, metadata, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at, supersedes::text AS supersedes, content_fingerprint AS fingerprint`;
}

/**
 * Set the pointers desiredPointers named, clears first, then sets — see its
 * docblock for why that order. Runs AFTER the head's own write: a pointer the
 * database refuses (a hand-set chain through a thought outside the group that
 * loops back — WOULD_CYCLE — or a pointer at a thought since deleted) is
 * bookkeeping, and must not hold the ticket's text and facets hostage every
 * pass (fourth review pass); it is returned as `refusal` for the report.
 */
async function chainRows(w: Writer, identifier: string, order: BrainRow[]): Promise<{ changed: number; refusal?: string }> {
  const changes = desiredPointers(order);
  if (changes.length === 0) return { changed: 0 };
  const say = (c: { row: BrainRow; wanted: string | null; dropped?: string[] }) => `${c.row.id} ${c.wanted ? `→ ${c.wanted}` : "cleared"}${c.row.supersedes && c.row.supersedes !== c.wanted ? ` (was ${c.row.supersedes})` : ""}${c.dropped ? ` — a second outside pointer (${c.dropped.join(", ")}) has no place in one chain and is DROPPED` : ""}`;
  if (w.dryRun) { w.log(`  ~ ${identifier}: would re-chain ${changes.map(say).join(", ")}`); return { changed: changes.length }; }
  // A write the database refuses undoes EVERY write before it — the clears and
  // the sets that landed — in reverse: the pointers a person set were promised
  // a place at the tail, not erasure, and "the chain is as it was" must be
  // true of every row, not only the cleared ones (sixth review pass, made
  // whole by the seventh). A row touched twice (cleared, then set) is restored
  // once, to what it held before either.
  // The same undo runs when a statement THROWS (a dropped connection) as when
  // one answers ok:false — the statements autocommit one by one, so a throw
  // between the phases would otherwise leave the clears and lose the pointer
  // (ninth review pass). A kill between them is the remaining gap; the loop
  // stops between issues, not inside one, and the compose grace period is
  // sized for that.
  const written: BrainRow[] = [];
  const undo = async (why: string): Promise<{ changed: number; refusal: string }> => {
    const failed: string[] = [];
    for (const row of [...new Set(written)].reverse()) {
      try {
        const back = await w.store.updateThought({ id: row.id, actor: w.actor, provenance: { supersedes: row.supersedes } });
        if (!back.ok) failed.push(`${row.id} → ${row.supersedes}: ${back.error}`);
      } catch (e) { failed.push(`${row.id} → ${row.supersedes}: ${(e as Error).message}`); }
    }
    return { changed: 0, refusal: `${why}; the chain is as it was${failed.length ? ` except ${failed.join(", ")}, which could not be restored` : ""}` };
  };
  try {
    for (const c of changes.filter((c) => c.row.supersedes !== null)) {
      const r = await w.store.updateThought({ id: c.row.id, actor: w.actor, provenance: { supersedes: null } });
      if (!r.ok) return undo(`clearing ${c.row.id}'s pointer: ${r.error}`);
      written.push(c.row);
    }
    for (const c of changes.filter((c) => c.wanted !== null)) {
      const r = await w.store.updateThought({ id: c.row.id, actor: w.actor, provenance: { supersedes: c.wanted } });
      if (!r.ok) return undo(`pointing ${c.row.id} at ${c.wanted}: ${r.error}`);
      written.push(c.row);
    }
  } catch (e) {
    return undo(`a pointer write failed: ${(e as Error).message}`);
  }
  w.log(`  ~ ${identifier}: re-chained ${changes.map(say).join(", ")}`);
  // `changed` counts rows whose pointer moved, not statements: a row cleared then set is one.
  return { changed: changes.length };
}

/**
 * Bring one issue's row(s) to what Linear says.
 *
 * No row: a capture with the vector, the tags and the facets — unless a thought
 * already carries the text's fingerprint (a paste the header grammar did not
 * recognise: a leading space, a lower-cased identifier), which is adopted with
 * a facet patch — the facets that differ, so a holder the grammar still cannot
 * read is not re-patched every pass — and no model call; upsert_thought's own
 * `existed` is honoured the same way should the fingerprint arrive between.
 *
 * Rows: the HEAD is the row that already holds Linear's text, by fingerprint,
 * else the current one. The head's text is brought up (an edit with a fresh
 * vector and fresh tags, the facets over them as at capture) or its facets
 * patched (no model call); THEN the group is chained under it (chainRows) —
 * a pointer the database refuses is reported, never a reason the text did not
 * land. A text held by a thought outside this ticket's rows is refused before
 * any model call (holderOf), the facets patched WITHOUT advancing
 * linear_updated_at and `text_refused_by` naming the holder, so the plan keeps
 * the ticket stale — visible in --audit, retried each pass at the cost of one
 * lookup — until the holder is edited or gone (fourth review pass).
 */
export type SyncOutcome = { outcome: Outcome; noVector: boolean; twinsMarked: number; chainRefusal?: string; headWindow?: boolean };

/**
 * What the embedder had to settle for, said on the line and counted in the
 * report, as the server's capture reply and reembed.ts's claim row say it: a
 * head-window vector standing in for a text the provider refused whole, and
 * windows that went in without their blurb. Silent before (thirteenth review
 * pass); reembed.ts --retry-fallbacks is the repair, and only a reader told can
 * reach for it.
 */
function caveat(e: { wholeContentFellBack?: boolean; wholeContentError?: string; contextFailures?: number } | undefined): string {
  if (!e) return "";
  const parts: string[] = [];
  if (e.wholeContentFellBack) parts.push(`the head window's vector stands in for the whole text (${e.wholeContentError ?? "no detail"}; reembed.ts --retry-fallbacks repairs it)`);
  if (e.contextFailures) parts.push(`${e.contextFailures} chunk(s) without context`);
  return parts.length ? ` — caveat: ${parts.join("; ")}` : "";
}

export async function syncIssue(w: Writer, issue: LinearIssue, rows: BrainRow[]): Promise<SyncOutcome> {
  // One mapping, the adapter's: the text, the facets and the structure of one issue (SMD-1867).
  const mapped = linearAdapter.map(issue);
  const content = mapped.text;
  const facets = mapped.facets;
  const structure: Structure = { identity: mapped.identity, canonical: mapped.canonical, links: mapped.links, mentions: mapped.mentions };
  // The structure lands on the row that holds the ticket once the row is
  // settled — after a capture, an adoption, a patch or an edit; not on a dry
  // run. A failure here is the pass's to report for this issue, as a write's is.
  const recordOn = async (thoughtId: string): Promise<void> => { if (!w.dryRun && w.structure) await w.structure(thoughtId, structure); };
  const fp = await w.fingerprintOf(content);
  const holds = (row: BrainRow) => row.content === content || (fp !== null && row.fingerprint === fp);
  const actorWith = (record: ReturnType<typeof decideCalls>["record"]): Actor => ({ ...w.actor, ...(record ? { egress: record } : {}) });
  const said = (patch: Record<string, unknown> | null) => (patch ? Object.keys(patch).join(", ") : "");
  // The facets without the watermark: what a refused text carries, so the plan revisits it.
  const facetsSansWatermark = Object.fromEntries(Object.entries(facets).filter(([k]) => k !== "linear_updated_at"));

  if (rows.length === 0) {
    const elsewhere = fp !== null ? await w.holderOf(fp) : null;
    // A holder claimed by ANOTHER ticket is not adopted — as the rows branch
    // refuses it — rather than re-keyed under this one (sixth review pass).
    const claimedBy = elsewhere ? ticketIdentifier(elsewhere) : null;
    if (elsewhere && claimedBy !== null && claimedBy !== issue.identifier) {
      w.log(`  ! ${issue.identifier}: the text is held by ${elsewhere.id}, claimed as ${claimedBy}; not adopted`);
      return { outcome: "refused", noVector: false, twinsMarked: 0 };
    }
    if (elsewhere) {
      const patch = facetPatch(elsewhere.metadata ?? {}, facets);
      if (!patch) { await recordOn(elsewhere.id); return { outcome: "unchanged", noVector: false, twinsMarked: 0 }; }
      if (w.dryRun) { w.log(`  · ${issue.identifier}: would adopt ${elsewhere.id}, which already holds the text (${said(patch)})`); return { outcome: "patched", noVector: false, twinsMarked: 0 }; }
      const r = await w.store.updateThought({ id: elsewhere.id, metadataPatch: patch, actor: w.actor });
      if (!r.ok) throw new Error(`adopting ${elsewhere.id}: ${r.error}`);
      await recordOn(elsewhere.id);
      w.log(`  · ${issue.identifier}: adopted ${elsewhere.id}, which already held the text (${said(patch)})`);
      return { outcome: "patched", noVector: false, twinsMarked: 0 };
    }
    // One subject for the gate, the embedder and the tags, so the call is
    // judged under the subject the audit row records (second review pass).
    const subject: EgressSubject = { kind: "capture", actor: w.actor.name, metadata: facets, content };
    const g = decideCalls(subject, w.cfg, w.cfg.egress);
    if (w.dryRun) { w.log(`  + ${issue.identifier}: would capture (${g.embeddings.allowed ? "with" : "WITHOUT"} a vector)`); return { outcome: "captured", noVector: !g.embeddings.allowed, twinsMarked: 0 }; }
    const [embedded, tags] = await Promise.all([
      g.embeddings.allowed ? w.embed(content, subject) : Promise.resolve(undefined),
      g.chat.allowed ? w.tags(content, subject) : Promise.resolve(metadataRefused()),
    ]);
    // Asked once more, after the model calls: a row holding this text written
    // meanwhile would take a wholesale merge of a fallback or a refusal marker
    // over its real tags through upsert_thought's `existed` path; found here it
    // takes the facets alone (thirteenth review pass). The window between this
    // look and the write remains, and `existed` below says when it was hit.
    const late = fp !== null ? await w.holderOf(fp) : null;
    if (late) {
      const patch = facetPatch(late.metadata ?? {}, facets);
      if (patch) {
        const r = await w.store.updateThought({ id: late.id, metadataPatch: patch, actor: w.actor });
        if (!r.ok) throw new Error(`adopting ${late.id}: ${r.error}`);
      }
      await recordOn(late.id);
      w.log(`  · ${issue.identifier}: adopted ${late.id}, which took the text while the tags were extracted (${said(patch)})`);
      return { outcome: "patched", noVector: false, twinsMarked: 0 };
    }
    // The facets last: Linear's word on status and project beats a tag the model guessed.
    const captured = await w.store.captureThought({
      content,
      payload: { metadata: { ...tags, ...facets } },
      chunks: embedded?.chunks ?? [],
      actor: actorWith(g.record),
      embedding: embedded?.embedding ?? null,
      embeddingModel: embedded?.model,
    });
    await recordOn(captured.id);
    if (captured.existed === true) {
      // 035: the text was there after all — written in the window after the
      // second look — and the tag set went over that row's tags wholesale,
      // which for a fallback or a refusal is the clobber tagsOverExisting
      // prevents on the edit path. Said plainly, with the row, so the operator
      // can look; the window is a race this tool cannot close from outside.
      w.log(`  ! ${issue.identifier}: ${captured.id} took the text in the last instant; the fresh tags${"metadata_extraction_failed" in tags ? " (a FALLBACK set — check that row's tags)" : ""} and the facets merged onto it`);
      return { outcome: "patched", noVector: false, twinsMarked: 0 };
    }
    w.log(`  + ${issue.identifier}: captured${embedded ? "" : " WITHOUT a vector (egress refused)"}${caveat(embedded)}`);
    return { outcome: "captured", noVector: !embedded, twinsMarked: 0, headWindow: embedded?.wholeContentFellBack === true };
  }

  // The thought holding the new text, when none of this ticket's rows does. A
  // hand paste of THIS ticket made after its row was adopted (the header
  // grammar, no claim; the scheduled path did not scan for it because nothing
  // was missing) is not an outside holder: it is folded in as the head, so it
  // is chained and the ticket has one current answer, where refusing it every
  // pass left Backlog in one row and Done in the other for good (fifth pass).
  let group = rows;
  let outside: BrainRow | null = null;
  if (!rows.some(holds) && fp !== null) {
    const holder = await w.holderOf(fp);
    if (holder && !rows.some((r) => r.id === holder.id)) {
      // Ours when it reads as this ticket OR as nothing (a paste the grammar
      // cannot read — a leading space — is still this ticket's text, exactly;
      // the no-row branch adopts the same row, and the two must agree — sixth
      // pass); another ticket's claim on the same text is the outside case.
      const claimedBy = ticketIdentifier(holder);
      if (claimedBy === null || claimedBy === issue.identifier) group = [holder, ...rows];
      else outside = holder;
    }
  }
  const head = group.find(holds) ?? group[0];
  const order = [head, ...group.filter((r) => r !== head)];
  const chain = async (): Promise<Pick<SyncOutcome, "twinsMarked" | "chainRefusal">> => {
    const c = await chainRows(w, issue.identifier, order);
    if (c.refusal) w.log(`  ! ${issue.identifier}: chain left as it was — ${c.refusal}`);
    return { twinsMarked: c.changed, ...(c.refusal ? { chainRefusal: c.refusal } : {}) };
  };
  // A refusal recorded earlier, on the head or on a twin, is cleared once the
  // head holds the text: nothing is refused any more (fifth review pass).
  const clearRefusals = async (): Promise<void> => {
    for (const r of group) {
      const clear = refusalClear(r.metadata);
      if (r === head || !Object.keys(clear).length) continue;
      if (w.dryRun) { w.log(`  · ${issue.identifier}: would clear text_refused_by on ${r.id}`); continue; }
      const u = await w.store.updateThought({ id: r.id, metadataPatch: clear, actor: w.actor });
      if (!u.ok) throw new Error(`clearing text_refused_by on ${r.id}: ${u.error}`);
    }
  };
  const staleRefusal = refusalClear(head.metadata);

  if (holds(head)) {
    const where = head !== rows[0] ? ` on ${head.id}, which already holds the text` : "";
    // One question of the row: what differs between what it holds and the
    // facets plus the refusal clear. No model call on this branch: the text is
    // already Linear's, and a row whose tags fell back at capture is SMD-1975's
    // retag worker's to repair, for every thought — not this sync's for ticket
    // rows alone (the branch that did it here left before the merge).
    const patch = facetPatch(head.metadata ?? {}, { ...facets, ...staleRefusal });
    if (!patch) { await recordOn(head.id); await clearRefusals(); return { outcome: "unchanged", noVector: false, ...(await chain()) }; }
    if (w.dryRun) { w.log(`  · ${issue.identifier}: would patch ${said(patch)}${where}`); await clearRefusals(); return { outcome: "patched", noVector: false, ...(await chain()) }; }
    const r = await w.store.updateThought({ id: head.id, metadataPatch: patch, actor: w.actor });
    if (!r.ok) throw new Error(`patching ${head.id}: ${r.error}`);
    await recordOn(head.id);
    w.log(`  · ${issue.identifier}: facets patched (${said(patch)})${where}`);
    await clearRefusals();
    return { outcome: "patched", noVector: false, ...(await chain()) };
  }
  const patch = facetPatch(head.metadata ?? {}, facets);

  // A thought outside this ticket's rows holds the new text: the edit would be
  // refused as DUPLICATE_CONTENT, so no model call is made. The facets land
  // without the watermark, and the holder is named on the row — once: a
  // refusal already recorded costs the lookup and no write (fifth pass).
  const refuse = async (holder: string | null): Promise<SyncOutcome> => {
    const named = holder ?? "unknown";
    const already = head.metadata?.text_refused_by === named;
    const parkedPatch = { ...(facetPatch(head.metadata ?? {}, facetsSansWatermark) ?? {}), ...(already ? {} : { text_refused_by: named }) };
    if (Object.keys(parkedPatch).length === 0) { w.log(`  ! ${issue.identifier}: text still held by ${holder ?? "another thought"}; nothing new to record`); return { outcome: "refused", noVector: false, ...(await chain()) }; }
    if (w.dryRun) { w.log(`  ! ${issue.identifier}: text held by ${holder ?? "another thought"} — would patch ${said(parkedPatch)}, text left`); return { outcome: "refused", noVector: false, ...(await chain()) }; }
    const parked = await w.store.updateThought({ id: head.id, metadataPatch: parkedPatch, actor: w.actor });
    if (!parked.ok) throw new Error(`recording the refusal on ${head.id}: ${parked.error}`);
    w.log(`  ! ${issue.identifier}: text held by ${holder ?? "another thought"} (DUPLICATE_CONTENT) — facets patched, text left, stays stale until the holder moves`);
    return { outcome: "refused", noVector: false, ...(await chain()) };
  };
  if (outside) return refuse(outside.id);

  // The text moved: judged as an edit of THIS row — its own source and tags.
  // The tags are extracted again with the vector: the people, topics and
  // action items were the OLD text's, and a fallback tag set from a provider
  // outage would otherwise stand on current text forever (third review pass).
  // The whole facet set goes over the tags, as at capture — a `status` or an
  // `issue` the model read out of the description must not win (fourth) —
  // and a stale failure marker the fresh tags do not carry is nulled, the
  // nearest a shallow merge comes to removing it.
  const subject: EgressSubject = { kind: "edit", actor: w.actor.name, metadata: { ...(head.metadata ?? {}), ...facets }, content };
  const g = decideCalls(subject, w.cfg, w.cfg.egress);
  if (w.dryRun) { w.log(`  ~ ${issue.identifier}: would update the text (${g.embeddings.allowed ? "re-embedded" : "WITHOUT a vector"}, ${g.chat.allowed ? "re-tagged" : "tags NOT re-extracted"})${patch ? ` and patch ${said(patch)}` : ""}`); return { outcome: "updated", noVector: !g.embeddings.allowed, ...(await chain()) }; }
  // The vector first, the tags after: an embedder that throws (a provider
  // answering no vector) fails the edit — the fork's rule, only an egress
  // refusal stores a row bare — and paid for no chat call it would have thrown
  // away (tenth review pass). A capture runs the two together because it keeps
  // both; here the second is worth making only once the first is in hand.
  const embedded = g.embeddings.allowed ? await w.embed(content, subject) : undefined;
  // Refused or fallen back: the marker, and every tag key the answer did not
  // set nulled — the OLD text's people, topics and action items must not stand
  // on the new text under a marker that says no extraction happened (fifth
  // pass said the marker; the eleventh found the old tags still standing).
  const tags = tagsOverExisting(g.chat.allowed ? await w.tags(content, subject) : metadataRefused());
  const clearRefusal = refusalClear(head.metadata);
  // Only what differs is sent, as the patch branch sends it: a merge would
  // persist a `metadata_extraction_failed: null` key on every edited row that
  // never carried a marker, and every facet whether it moved or not
  // (thirteenth review pass).
  const editPatch = facetPatch(head.metadata ?? {}, { ...tags, ...clearRefusal, ...facets });
  const r = await w.store.updateThought({
    id: head.id,
    content,
    metadataPatch: editPatch ?? undefined,
    embedding: embedded?.embedding,
    chunks: embedded?.chunks,
    actor: actorWith(g.record),
    embeddingModel: embedded?.model,
  });
  // The holder arrived between the lookup and the edit (or is unfingerprinted): the same refusal.
  if (!r.ok && r.error === "DUPLICATE_CONTENT") return refuse(null);
  if (!r.ok) throw new Error(`updating ${head.id}: ${r.error}`);
  await recordOn(head.id);
  w.log(`  ~ ${issue.identifier}: updated${embedded ? "" : " WITHOUT a vector (egress refused)"}${editPatch ? ` (${said(editPatch)})` : ""}${caveat(embedded)}`);
  // The twins' refusal markers too, as the patch branch does (eighth review pass).
  await clearRefusals();
  return { outcome: "updated", noVector: !embedded, headWindow: embedded?.wholeContentFellBack === true, ...(await chain()) };
}

/**
 * One pass: census, plan, fetch, write. `only` names identifiers to sync
 * whatever the plan says of them — an operator asking for one ticket by name
 * means it, so an `unchanged` one is fetched and compared all the same, and a
 * name the census does not hold is reported rather than dropped (third review
 * pass). `readRows` is how the brain's ticket rows are read — readTicketRows
 * over a connection, or a fake in the self-check.
 */
/** How the brain's ticket rows are read: with or without the header scan, and with the claimed rows already read when a caller has them. */
export type ReadRows = (scanHeaders: boolean, claimed?: BrainRow[]) => Promise<BrainRow[]>;

/**
 * The board and the brain, side by side: the census, the ticket rows and the
 * plan — the front half of a pass, and the whole of --audit, one definition
 * (sixth review pass; the audit branch had a second copy that already differed
 * in one rule). The claimed rows first; when the plan over them misses an
 * identifier, the hand captures too (the header scan) and the plan again — a
 * paste is the one thing that could hold a missing ticket, and it must be
 * adopted, not captured beside (fourth review pass). `scan` reads both from the
 * start (--full, --audit).
 */
export type Board = { initiative: string; projects: { id: string; name: string }[] };

export async function planBoard(opts: { gql: Gql; readRows: ReadRows; initiative: string; full: boolean; scan?: boolean; board?: Board }) {
  // A board the caller resolved already (main's preflight) is not asked for twice (seventh review pass).
  const { initiative, projects } = opts.board ?? await initiativeProjects(opts.gql, opts.initiative);
  const census = await censusOf(opts.gql, projects.map((p) => p.id));
  const scanFirst = opts.scan || opts.full;
  const claimed = await opts.readRows(scanFirst);
  let groups = groupTicketRows(claimed);
  let plan = planPass(census, groups, opts.full);
  // …and when anything is to be fetched at all, not only when something is
  // missing: a hand paste of an ADOPTED ticket whose text is not Linear's
  // current text is found by no fingerprint, so a stale ticket's pass must see
  // it to chain it (thirteenth review pass). A pass with nothing to fetch still
  // pays the claimed read alone.
  if (!scanFirst && plan.fetch.length > 0) {
    groups = groupTicketRows(await opts.readRows(true, claimed));
    plan = planPass(census, groups, opts.full);
  }
  return { initiative, projects, census, groups, plan };
}

export async function runPass(opts: { gql: Gql; readRows: ReadRows; writer: Writer; initiative: string; full: boolean; only?: string[]; board?: Board }): Promise<PassReport> {
  const { initiative, projects, census, groups, plan } = await planBoard(opts);
  const tally: Record<Outcome, number> = { captured: 0, updated: 0, patched: 0, unchanged: 0, refused: 0 };
  const report: PassReport = { initiative, projects: projects.length, census: census.length, plan, tally, twinsMarked: 0, noVector: 0, errors: [], chainRefusals: [], headWindow: 0 };
  let wanted = plan.fetch;
  if (opts.only) {
    const listed = new Set(census.map((c) => c.identifier));
    for (const name of opts.only) if (!listed.has(name)) report.errors.push({ identifier: name, error: "not in the census — no such issue in the board's projects" });
    wanted = opts.only.filter((name) => listed.has(name));
  }
  if (wanted.length === 0) return report;
  const { issues, failed } = await fetchIssues(opts.gql, wanted);
  for (const f of failed) { report.errors.push(f); opts.writer.log(`  ! ${f.identifier}: ${f.error}`); }
  for (const [i, issue] of issues.entries()) {
    if (opts.writer.stopping?.()) { report.stopped = issues.length - i; break; }
    try {
      const r = await syncIssue(opts.writer, issue, groups.get(issue.identifier) ?? []);
      tally[r.outcome]++;
      report.twinsMarked += r.twinsMarked;
      if (r.noVector) report.noVector++;
      if (r.chainRefusal) report.chainRefusals.push({ identifier: issue.identifier, refusal: r.chainRefusal });
      if (r.headWindow) report.headWindow++;
    } catch (e) {
      report.errors.push({ identifier: issue.identifier, error: (e as Error).message });
      opts.writer.log(`  ! ${issue.identifier}: ${(e as Error).message}`);
    }
  }
  return report;
}

export function formatReport(r: PassReport, dryRun: boolean): string {
  const p = r.plan;
  const lines = [
    `  board: ${r.initiative} — ${r.projects} project(s), ${r.census} issue(s)`,
    `  plan: ${p.missing.length} missing, ${p.stale.length} stale, ${p.unchanged} unchanged${p.extra.length ? `, ${p.extra.length} extra in the brain (${p.extra.slice(0, 8).join(", ")}${p.extra.length > 8 ? ", …" : ""})` : ""}`,
    `  ${dryRun ? "would write" : "wrote"}: captured ${r.tally.captured}  updated ${r.tally.updated}  patched ${r.tally.patched}  unchanged ${r.tally.unchanged}${r.twinsMarked ? `  pointers re-chained ${r.twinsMarked}` : ""}${r.noVector ? `  without a vector ${r.noVector}` : ""}`,
  ];
  if (r.tally.refused) lines.push(`  refused: ${r.tally.refused} ticket(s) whose text another thought holds (DUPLICATE_CONTENT) — facets patched, text left, stale until the holder moves`);
  if (r.chainRefusals.length) lines.push(`  chain refusals: ${r.chainRefusals.length} — ${r.chainRefusals.slice(0, 5).map((c) => `${c.identifier}: ${c.refusal}`).join("; ")}`);
  if (r.headWindow) lines.push(`  head-window vectors: ${r.headWindow} row(s) the provider refused whole — reembed.ts --retry-fallbacks repairs them`);
  if (r.stopped) lines.push(`  stopped: ${r.stopped} issue(s) left for the next pass`);
  if (r.errors.length) lines.push(`  errors: ${r.errors.length} — ${r.errors.slice(0, 5).map((e) => `${e.identifier}: ${e.error}`).join("; ")}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Self-check — the pure parts, and the write decisions against two fakes: a
// recording store (which call each state gets) and a small brain that keeps
// rows, judges DUPLICATE_CONTENT by fingerprint and refuses a cycle, so a
// scenario can be run to a fixpoint across passes.
// ---------------------------------------------------------------------------

/** 016's rule without the hash: enough for a fake to judge "same text" as the database would. */
function fakeFingerprint(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

type FakeRow = { content: string; metadata: Record<string, unknown>; supersedes: string | null; created_at: string | null };

/** A brain in memory: rows, the fingerprint rule, DUPLICATE_CONTENT and WOULD_CYCLE, and what a pass reads back. */
function fakeBrain(seed: Record<string, FakeRow>) {
  const rows = new Map(Object.entries(seed).map(([id, r]) => [id, { ...r }]));
  const holder = (fp: string, except?: string) => [...rows.entries()].find(([id, r]) => id !== except && fakeFingerprint(r.content) === fp)?.[0] ?? null;
  const reaches = (from: string | null, target: string): boolean => { let cur = from; const seen = new Set<string>(); while (cur && !seen.has(cur)) { if (cur === target) return true; seen.add(cur); cur = rows.get(cur)?.supersedes ?? null; } return false; };
  let next = 1;
  const writes: string[] = [];
  const store: Writer["store"] = {
    captureThought: async (o) => {
      const fp = fakeFingerprint(o.content);
      const existing = holder(fp);
      if (existing) { rows.get(existing)!.metadata = { ...rows.get(existing)!.metadata, ...o.payload.metadata }; writes.push(`capture→existed ${existing}`); return { id: existing, existed: true, supersedes: null }; }
      const id = `n${next++}`;
      rows.set(id, { content: o.content, metadata: o.payload.metadata, supersedes: null, created_at: "2026-09-30T00:00:00Z" });
      writes.push(`capture ${id}`);
      return { id, existed: false, supersedes: null };
    },
    updateThought: async (o) => {
      const row = rows.get(o.id);
      if (!row) return { ok: false, error: "NOT_FOUND" };
      if (o.content !== undefined && holder(fakeFingerprint(o.content), o.id)) { writes.push(`update ${o.id} content → DUPLICATE_CONTENT`); return { ok: false, error: "DUPLICATE_CONTENT" }; }
      if (o.provenance && o.provenance.supersedes !== undefined && o.provenance.supersedes !== null) {
        if (!rows.has(o.provenance.supersedes)) return { ok: false, error: "SUPERSEDES_NOT_FOUND" };
        if (o.provenance.supersedes === o.id || reaches(o.provenance.supersedes, o.id)) { writes.push(`update ${o.id} supersedes=${o.provenance.supersedes} → WOULD_CYCLE`); return { ok: false, error: "WOULD_CYCLE" }; }
      }
      if (o.content !== undefined) row.content = o.content;
      if (o.metadataPatch) row.metadata = { ...row.metadata, ...o.metadataPatch };
      if (o.provenance && o.provenance.supersedes !== undefined) row.supersedes = o.provenance.supersedes;
      writes.push(`update ${o.id}${o.content !== undefined ? " content" : ""}${o.metadataPatch ? " patch" : ""}${o.provenance ? ` supersedes=${o.provenance.supersedes}` : ""}`);
      return { ok: true, id: o.id };
    },
  };
  const brainRows = (): BrainRow[] => [...rows.entries()].map(([id, r]) => ({ id, content: r.content, metadata: r.metadata, created_at: r.created_at, supersedes: r.supersedes, fingerprint: fakeFingerprint(r.content) }));
  return { rows, store, writes, brainRows, fingerprintOf: async (t: string) => fakeFingerprint(t), holderOf: async (fp: string) => { const id = holder(fp); return id ? brainRows().find((r) => r.id === id)! : null; } };
}

/**
 * The files a module reaches through its relative imports, transitively —
 * `import … from "./x.ts"`, `import "./x.ts"`, `export … from "./x.ts"`, and a
 * dynamic `import("./x.ts")` with a literal specifier — as paths relative to
 * the repository root. A regex over the source, not a
 * bundler: the fork's imports are static relative specifiers with their
 * extensions written, which is all this needs to hold the container's mount
 * to what the sync loads (third review pass).
 */
export function importClosure(entry: string, root: string): string[] {
  const seen = new Set<string>();
  const walk = (file: string) => {
    const abs = resolve(file);
    if (seen.has(abs)) return;
    seen.add(abs);
    // A file the mount does not carry is in the closure (that is the finding)
    // and cannot be read further — inside the container the ingester's
    // evals/ imports are exactly such files.
    if (!existsSync(abs)) return;
    const src = readFileSync(abs, "utf8");
    for (const m of src.matchAll(/(?:^|\n)\s*(?:import|export)\b[^;]*?\bfrom\s+"(\.{1,2}\/[^"]+)"|(?:^|\n)\s*import\s+"(\.{1,2}\/[^"]+)"|\bimport\(\s*"(\.{1,2}\/[^"]+)"\s*\)/g)) {
      walk(resolve(dirname(abs), m[1] ?? m[2] ?? m[3]));
    }
  };
  walk(entry);
  return [...seen].map((f) => relative(root, f)).sort();
}

/** The directories deploy/compose.yaml mounts into the board-sync container — everything this file loads must be under one of them. */
export const CONTAINER_MOUNTS = ["db/", "server-portable/"] as const;

function selfCheck(): Promise<number> {
  let bad = 0;
  const ok = (cond: boolean, label: string) => { if (!cond) { console.error(`FAIL ${label}`); bad++; } };

  // The container's mount is the boundary: every file this tool loads,
  // transitively, sits under db/ or server-portable/ (third review pass — an
  // import of ingest-records.ts reached evals/ and scripts/, which the
  // container does not mount, and the sync would have failed at load).
  {
    const here = dirname(fileURLToPath(import.meta.url));
    const root = resolve(here, "..");
    const closure = importClosure(resolve(here, "sync-linear.ts"), root);
    const outside = closure.filter((f) => !CONTAINER_MOUNTS.some((m) => f.startsWith(m)));
    ok(closure.length > 10 && outside.length === 0, `every file the sync loads is under ${CONTAINER_MOUNTS.join(" or ")} — the board-sync container's mounts (${closure.length} files; outside: ${outside.join(", ") || "none"})`);
    // The walker sees through: the ingester's closure DOES reach evals/ and
    // scripts/, so a sync that imported it would fail the line above.
    const ingester = importClosure(resolve(here, "ingest-records.ts"), root);
    ok(ingester.some((f) => f.startsWith("evals/")) && ingester.some((f) => f.startsWith("scripts/")) && ingester.includes("db/ingest-structure.ts"), `…and the walker finds the ingester's evals/ and scripts/ imports, so the rule has teeth (${ingester.length} files)`);
  }

  // The adapter's sample issue, with the description the hand-capture shape was asserted on.
  const issue: LinearIssue = { ...SAMPLE_ISSUE, description: "## Problem\n\nSee <issue id=\"x\" href=\"https://linear.app/…\">SMD-1730</issue> and SMD-1250.\n", createdAt: "2026-09-22T00:00:00.000Z" };
  const text = renderIssue(issue);
  ok(text === "SMD-1936 — The SQL-safety guard rail\nProject: Open Brain — Release Engineering & Fork Maintenance · Status: Backlog (backlog) · Priority: Low · Parent: none · Labels: infrastructure\nhttps://linear.app/siggymd/issue/SMD-1936/the-sql-safety\n\n## Problem\n\nSee SMD-1730 and SMD-1250.", "renders the hand-capture shape: header, facets, url, blank, body with autolinks stripped");
  ok(HEADER_RE.test(text), "…and the rendered text matches the header grammar");
  const two = renderIssue({ ...issue, labels: { nodes: [{ name: "infrastructure" }, { name: "Improvement" }] }, parent: { identifier: "SMD-1850" }, project: null, description: null });
  ok(two === "SMD-1936 — The SQL-safety guard rail\nProject: none · Status: Backlog (backlog) · Priority: Low · Parent: SMD-1850 · Labels: Improvement, infrastructure\nhttps://linear.app/siggymd/issue/SMD-1936/the-sql-safety", `labels sorted and comma-joined, a parent named, no project and no description spelled (${JSON.stringify(two.split("\n")[1])})`);
  ok(stripAutolinks("a <issue id=\"1\" href=\"h\">SMD-1</issue> b <issue>SMD-2</issue>") === "a SMD-1 b SMD-2", "every autolink element becomes its identifier");
  ok(stripAutolinks("<issues> keep </issues>") === "<issues> keep </issues>", "…and only that element (a longer tag name is not it)");

  const f = issueFacets(issue);
  ok(f.source === "linear" && f.issue === "SMD-1936" && f.status === "Backlog" && f.status_type === "backlog" && JSON.stringify(f.labels) === '["infrastructure"]' && f.parent === null && f.linear_updated_at === issue.updatedAt && f.archived_at === null, "facets: source, issue, status, type, labels, parent, updatedAt; archived_at null when live");
  ok(issueFacets({ ...issue, archivedAt: "2026-10-01T00:00:00.000Z" }).archived_at === "2026-10-01T00:00:00.000Z", "…archived_at when Linear archived it");
  ok(JSON.stringify(facetPatch({ ...f, archived_at: "2026-10-01T00:00:00.000Z" }, f)) === JSON.stringify({ archived_at: null }), "…and a restored issue's archived_at is patched away, not kept (second review pass)");

  ok(ticketIdentifier({ content: text, metadata: { source: "mcp" } }) === "SMD-1936", "a hand capture is a ticket row by its header");
  ok(ticketIdentifier({ content: "SMD-1903 — DONE 2026-09-22: the egress gate landed\nProject: X · Status: Done\nhttps://linear.app/x", metadata: {} }) === "SMD-1903", "…the three-line header with a status suffices");
  ok(ticketIdentifier({ content: "SMD-1903 — DONE 2026-09-22: the egress gate landed in Open Brain (PR #99).", metadata: {} }) === null, "a note that only opens with an identifier is not a ticket row");
  ok(ticketIdentifier({ content: "anything", metadata: { issue: "SMD-12" } }) === "SMD-12", "an adopted row is a ticket row by its claim, whatever its text");
  ok(ticketIdentifier({ content: "anything", metadata: { issue: "not an id" } }) === null, "…a claim that is not an identifier is ignored");
  ok(ticketIdentifier({ content: "anything", metadata: { issue: "SMD-12 (old)" } }) === "SMD-12", "…a claim with a suffix yields the identifier it opens with, not the whole string");

  const row = (id: string, content: string, metadata: Record<string, unknown>, created_at: string | null, supersedes: string | null): BrainRow => ({ id, content, metadata, created_at, supersedes, fingerprint: fakeFingerprint(content) });
  const groups = groupTicketRows([
    row("b", text, {}, "2026-09-22T00:00:00Z", null),
    row("a", text, {}, "2026-09-21T00:00:00Z", null),
    row("c", text, {}, "2026-09-22T00:00:00Z", null),
    row("n", "SMD-1936 — a note", {}, "2026-09-23T00:00:00Z", null),
  ]);
  ok(groups.size === 1 && groups.get("SMD-1936")!.map((r) => r.id).join("") === "bca", "grouped by identifier, newest first, ties by id; the note excluded");
  const chained = groupTicketRows([row("old", text, {}, "2026-09-21T00:00:00Z", "new"), row("new", text, {}, "2026-09-22T00:00:00Z", null)]).get("SMD-1936")!;
  ok(chained.map((x) => x.id).join(",") === "old,new", `the unsuperseded row is current though older — the chain is the truth (${chained.map((x) => x.id).join(",")})`);

  const census: Census = [{ identifier: "SMD-1936", updatedAt: "2026-09-22T01:00:00.000Z" }, { identifier: "SMD-2000", updatedAt: "2026-09-22T02:00:00.000Z" }];
  const g2 = new Map<string, BrainRow[]>([
    ["SMD-1936", [row("b", text, { linear_updated_at: "2026-09-22T00:30:00.000Z" }, null, null)]],
    ["SMD-9", [row("z", "", { issue: "SMD-9" }, null, null)]],
  ]);
  const plan = planPass(census, g2);
  ok(JSON.stringify(plan) === JSON.stringify({ fetch: ["SMD-1936", "SMD-2000"], missing: ["SMD-2000"], stale: ["SMD-1936"], extra: ["SMD-9"], unchanged: 0 }), `plan: an older linear_updated_at is stale, an absent row is missing, an unlisted row is extra (${JSON.stringify(plan)})`);
  // A row whose tags fell back at capture is not the plan's concern (SMD-1975's worker repairs tags for every thought).
  ok(planPass([{ identifier: "SMD-1936", updatedAt: issue.updatedAt }], new Map([["SMD-1936", [row("F", text, { ...issueFacets(issue), metadata_extraction_failed: "provider_timeout" }, null, null)]]])).unchanged === 1, "fallback tags on a current row do not make the ticket stale");
  const fresh = planPass(census, new Map([["SMD-1936", [row("b", text, { linear_updated_at: "2026-09-22T01:00:00.000Z" }, null, null)]], ["SMD-2000", [row("d", "", { linear_updated_at: "2026-09-22T02:00:00.000Z" }, null, null)]]]));
  ok(fresh.fetch.length === 0 && fresh.unchanged === 2, "an equal linear_updated_at is unchanged and fetches nothing");
  ok(planPass(census, new Map([["SMD-1936", [row("b", text, {}, null, null)]]])).stale[0] === "SMD-1936", "a hand capture with no linear_updated_at is stale — adopted on first sight");
  ok(planPass(census, g2, true).fetch.length === 2 && planPass([{ identifier: "SMD-1936", updatedAt: "2026-09-22T00:30:00.000Z" }], g2, true).unchanged === 0, "--full fetches the unchanged too");

  const adopt = facetPatch({ source: "mcp", status: "Backlog", labels: [] }, { source: "linear", status: "Backlog", labels: [] });
  ok(adopt !== null && Object.keys(adopt).join() === "source", "the patch names only the facets that differ");
  ok(facetPatch({ source: "linear", parent: null }, { source: "linear", parent: null }) === null, "…and is null when none do (absent and null agree)");

  // The chain a group should carry.
  const dp = (order: BrainRow[]) => desiredPointers(order).map((c) => `${c.row.id}→${c.wanted}`).join(" ");
  ok(dp([row("c", text, {}, null, null), row("b", text, {}, null, "a"), row("a", text, {}, null, null)]) === "c→b", "only the missing pointer (c→b; b→a stands; a→null stands)");
  ok(dp([row("c", text, {}, null, "x"), row("b", text, {}, null, null)]) === "c→b b→x", "a pointer to a thought outside the group moves to the chain's tail, not erased");
  ok(dp([row("T1", text, {}, null, null), row("C", text, {}, null, "T0"), row("T0", text, {}, null, "T1")]) === "T1→C T0→null", "the holder at the head: C→T0 stands, T0's pointer at the new head clears, the head points at C");

  // The write decisions, against a recording store.
  const calls: string[] = [];
  const recorder: Writer = {
    store: {
      captureThought: async (o) => { calls.push(`capture ${JSON.stringify(o.payload.metadata.status)} vec=${o.embedding ? "yes" : "no"} type=${o.payload.metadata.type ?? "-"}`); return { id: "new" }; },
      updateThought: async (o) => { calls.push(`update ${o.id}${o.content !== undefined ? " content" : ""}${o.metadataPatch ? ` patch(${Object.keys(o.metadataPatch).join(",")})` : ""}${o.provenance ? ` supersedes=${o.provenance.supersedes}` : ""}${o.embedding ? " vec" : ""}`); return { ok: true, id: o.id }; },
    },
    cfg: resolveEmbedConfig({ OB1_LLM_LOCAL: "1", OB1_EGRESS_POLICY: "off" }),
    embed: async () => { calls.push("embed"); return { embedding: [1], model: "m", chunks: [] }; },
    tags: async () => { calls.push("tags"); return { type: "task", topics: ["t"], status: "a guess" }; },
    fingerprintOf: async (t) => fakeFingerprint(t),
    holderOf: async () => null,
    actor: { name: ACTOR_NAME, via: SELF },
    dryRun: false,
    log: () => {},
  };
  const run = async (w: Writer, rows: BrainRow[], iss: LinearIssue = issue) => { calls.length = 0; const r = await syncIssue(w, iss, rows); return { r, calls: calls.slice() }; };
  const withFacets = { ...issueFacets(issue) };
  const done: LinearIssue = { ...issue, state: { name: "Done", type: "completed" }, updatedAt: "2026-09-22T02:00:00.000Z" };
  const doneText = renderIssue(done);
  return (async () => {
    let r = await run(recorder, []);
    ok(r.r.outcome === "captured" && r.calls.join("; ") === 'embed; tags; capture "Backlog" vec=yes type=task', `a new issue: embed, tags, capture with the facets over the tags (${r.calls.join("; ")})`);
    r = await run({ ...recorder, holderOf: async () => row("h1", ` ${text}`, {}, null, null) }, []);
    ok(r.r.outcome === "patched" && r.calls.join("; ") === "update h1 patch(source,issue,project,status,status_type,priority,labels,url,linear_updated_at)", `no ticket row but a thought holding the text: adopted with a facet patch, no model call (${r.calls.join("; ")})`);
    r = await run({ ...recorder, holderOf: async () => row("h1", ` ${text}`, { ...withFacets, priority: "High" }, null, null) }, []);
    ok(r.r.outcome === "patched" && r.calls.join("; ") === "update h1 patch(priority)", `…and a holder already carrying the facets is patched for what differs alone, so it is not re-patched every pass (${r.calls.join("; ")})`);
    // Sixth review pass: a holder claimed by ANOTHER ticket is not re-keyed under this one, in either branch.
    r = await run({ ...recorder, holderOf: async () => row("h1", ` ${text}`, { ...withFacets, issue: "X-12" }, null, null) }, []);
    ok(r.r.outcome === "refused" && r.calls.length === 0, `no ticket row, the text held under another ticket's claim: refused without a write (${r.calls.join("; ")})`);
    r = await run({ ...recorder, holderOf: async () => row("P", ` ${doneText}`, { source: "mcp" }, "2026-09-25T00:00:00Z", null) }, [row("A", text, withFacets, "2026-09-22T00:00:00Z", null)], done);
    ok(r.r.outcome === "patched" && r.calls.join("; ") === "update P patch(source,issue,project,status,status_type,priority,labels,url,linear_updated_at); update P supersedes=A",
      `a paste the grammar cannot read (a leading space) holding this ticket's text is folded in as the head too, as the no-row branch would adopt it (${r.calls.join("; ")})`);
    // A refused set undoes the clears before it, so a hand-set pointer survives.
    let sets = 0;
    const halfway: Writer["store"] = { captureThought: recorder.store.captureThought, updateThought: async (o) => { if (o.provenance && o.provenance.supersedes !== null && o.provenance.supersedes !== undefined && ++sets === 2) { calls.push(`update ${o.id} supersedes=${o.provenance.supersedes} → WOULD_CYCLE`); return { ok: false, error: "WOULD_CYCLE" }; } return recorder.store.updateThought(o); } };
    r = await run({ ...recorder, store: halfway }, [row("H", text, withFacets, "2026-09-23T00:00:00Z", "x"), row("N", text, {}, "2026-09-22T00:00:00Z", null)]);
    ok(r.r.chainRefusal !== undefined && r.calls.join("; ") === "update H supersedes=null; update H supersedes=N; update N supersedes=x → WOULD_CYCLE; update H supersedes=x" && r.r.twinsMarked === 0,
      `a refused set restores the pointer the clear removed — H→x is back, the chain reported as it was (${r.calls.join("; ")})`);
    // Fifth review pass: a hand paste of THIS ticket made after adoption is folded in as the head, not refused as an outside holder.
    r = await run({ ...recorder, holderOf: async () => row("P", doneText, { source: "mcp" }, "2026-09-25T00:00:00Z", null) }, [row("A", text, withFacets, "2026-09-22T00:00:00Z", null)], done);
    ok(r.r.outcome === "patched" && r.calls.join("; ") === "update P patch(source,issue,project,status,status_type,priority,labels,url,linear_updated_at); update P supersedes=A",
      `a later hand paste holding Linear's text becomes the head, gets the facets and supersedes the adopted row — no embed, no refusal (${r.calls.join("; ")})`);
    ok(ticketIdentifier({ content: "x", metadata: { issue: "X-12" } }) === "X-12", "a one-letter team key is an identifier");
    r = await run({ ...recorder, store: { ...recorder.store, captureThought: async (o) => { calls.push("capture"); return { id: "h2", existed: true, supersedes: null }; } } }, []);
    ok(r.r.outcome === "patched" && r.calls.join("; ") === "embed; tags; capture", `upsert_thought's own existed is honoured: reported as an adoption, not a capture (${r.calls.join("; ")})`);
    r = await run(recorder, [row("cur", text, { source: "mcp", type: "task" }, "2026-09-22T00:00:00Z", null)]);
    // No `parent` in the patch: the row has none and Linear says null, and absent and null agree.
    ok(r.r.outcome === "patched" && r.calls.join("; ") === "update cur patch(source,issue,project,status,status_type,priority,labels,url,linear_updated_at)", `a hand capture with the same text: one facet patch, no model call (${r.calls.join("; ")})`);
    r = await run(recorder, [row("cur", text, withFacets, null, null)]);
    ok(r.r.outcome === "unchanged" && r.calls.length === 0, "same text and facets: nothing written, nothing called");
    r = await run(recorder, [row("cur", `${text}\n`, withFacets, null, null)]);
    ok(r.r.outcome === "unchanged" && r.calls.length === 0, "the same text up to whitespace is the same text — judged by fingerprint, as the database judges it (second review pass)");
    r = await run(recorder, [row("cur", text, { ...withFacets, status: "Done", status_type: "completed" }, null, null)], { ...issue, state: { name: "In Progress", type: "started" } });
    // The whole facet set over the tags: the recorder's tags carry `status: "a guess"`, which must not win (fourth review pass).
    // Thirteenth review pass: only what differs is sent — no `metadata_extraction_failed: null` persisted on a row that never carried a marker, no facet re-sent unchanged.
    ok(r.r.outcome === "updated" && r.calls.join("; ") === "embed; tags; update cur content patch(type,topics,status,status_type) vec", `moved text: one embed, the tags extracted again, one edit with the vector, the tags and the facets that differ — every facet considered, only the moved ones sent (${r.calls.join("; ")})`);
    r = await run(recorder, [row("cur", text, { ...withFacets, status: "Done", status_type: "completed", metadata_extraction_failed: "provider_timeout", text_refused_by: "Z" }, null, null)], { ...issue, state: { name: "In Progress", type: "started" } });
    ok(r.calls[2]?.includes("metadata_extraction_failed") === true && r.calls[2]?.includes("text_refused_by") === true, `a stale failure marker and a stale refusal are nulled when the fresh tags arrive (${r.calls[2]})`);
    // A thought outside the group holds the new text: refused before any model call, the watermark not advanced, the holder named.
    // An outside holder: the same text under ANOTHER ticket's claim (an identical render is otherwise this ticket's paste, and is folded in above).
    const zHolder: Writer = { ...recorder, holderOf: async () => row("Z", doneText, { source: "linear", issue: "SMD-9999" }, null, null) };
    r = await run(zHolder, [row("b", text, withFacets, null, null)], done);
    ok(r.r.outcome === "refused" && r.calls.join("; ") === "update b patch(status,status_type,text_refused_by)", `held outside the group (a note, not a ticket row): no embed, no tags, facets without linear_updated_at, text_refused_by set (${r.calls.join("; ")})`);
    r = await run(zHolder, [row("b", text, { ...withFacets, status: "Done", status_type: "completed", text_refused_by: "Z" }, null, null)], done);
    ok(r.r.outcome === "refused" && r.calls.length === 0, `…and a refusal already recorded costs the lookup and no write (${r.calls.join("; ")})`);
    // Once the head holds the text, a stale refusal on it or on a twin is cleared.
    r = await run(recorder, [row("b", text, { ...withFacets, text_refused_by: "Z" }, "2026-09-22T00:00:00Z", "a"), row("a", text, { text_refused_by: "Z" }, "2026-09-21T00:00:00Z", null)]);
    ok(r.calls.join("; ") === "update b patch(text_refused_by); update a patch(text_refused_by)", `a resolved refusal is cleared on the head and on the twin (${r.calls.join("; ")})`);
    // An edit with the chat call refused carries the refusal marker, as a capture does, not the old text's tags in silence.
    const chatDenied: Writer = { ...recorder, cfg: resolveEmbedConfig({ OB1_LLM_LOCAL: "1", OB1_CHAT_BASE_URL: "https://chat.example.com/v1", OB1_CHAT_API_KEY: "k", OB1_EGRESS_POLICY: "deny" }) };
    r = await run(chatDenied, [row("cur", text, withFacets, null, null)], done);
    // Eleventh review pass: every tag key the refusal does not set is nulled, so the old text's people and action items do not stand on the new text.
    ok(r.r.outcome === "updated" && r.calls.join("; ") === "embed; update cur content patch(metadata_extraction_failed,status,status_type,linear_updated_at) vec", `chat refused on an edit: the vector lands, the tags are not called, the marker says why; a row with no old tags gets no null keys (${r.calls.join("; ")})`);
    r = await run(chatDenied, [row("cur", text, { ...withFacets, people: ["someone"], topics: ["old"], type: "task" }, null, null)], done);
    ok(r.calls[1]?.includes("people") === true && r.calls[1]?.includes("topics") === true && r.calls[1]?.includes("type") === true, `…and a row with old tags has them nulled under the marker (${r.calls[1]})`);
    ok(JSON.stringify(tagsOverExisting({ type: "task", topics: ["t"], people: [] })) === JSON.stringify({ metadata_extraction_failed: null, type: "task", topics: ["t"], people: [] }), "a full answer through tagsOverExisting nulls a stale marker and keeps every tag (twelfth review pass)");
    ok(JSON.stringify(tagsOverExisting(metadataRefused())).includes('"type_raw":null'), "…and a refusal nulls the model's raw type too");
    ok(JSON.stringify(tagsOverExisting({ topics: ["uncategorized"], type: "observation", metadata_extraction_failed: "provider_timeout" })) === JSON.stringify({ people: null, action_items: null, dates_mentioned: null, type_raw: null, topics: ["uncategorized"], type: "observation", metadata_extraction_failed: "provider_timeout" }), "a fallback answer nulls the keys it does not set (type_raw among them) and keeps its own");
    ok(planPass([{ identifier: "SMD-1936", updatedAt: issue.updatedAt }], new Map([["SMD-1936", [row("T", text, {}, "2026-09-25T00:00:00Z", null), row("H", text, withFacets, "2026-09-22T00:00:00Z", null)]]])).unchanged === 1, "the plan reads the newest watermark in the group, not the first row's — an unsuperseded hand twin does not keep the ticket stale");
    // A pointer the database refuses does not hold the ticket's write hostage.
    const cycling: Writer["store"] = { captureThought: recorder.store.captureThought, updateThought: async (o) => { if (o.provenance) { calls.push(`update ${o.id} supersedes=${o.provenance.supersedes} → WOULD_CYCLE`); return { ok: false, error: "WOULD_CYCLE" }; } return recorder.store.updateThought(o); } };
    r = await run({ ...recorder, store: cycling }, [row("c", text, {}, "2026-09-23T00:00:00Z", null), row("b", text, {}, "2026-09-22T00:00:00Z", null)]);
    ok(r.r.outcome === "patched" && r.r.chainRefusal !== undefined && r.calls[0].startsWith("update c patch(") && /WOULD_CYCLE/.test(r.calls[1]), `the head's write lands first; the refused pointer is reported, not thrown (${r.calls.join("; ")})`);
    ok(renderIssue({ ...issue, labels: { nodes: [{ name: "infrastructure" }, { name: "Improvement" }] } }) === renderIssue({ ...issue, labels: { nodes: [{ name: "Improvement" }, { name: "infrastructure" }] } }) && JSON.stringify(issueFacets({ ...issue, labels: { nodes: [{ name: "b" }, { name: "a" }] } }).labels) === '["a","b"]', "labels render and store in one order whatever order Linear returns them (third review pass)");
    r = await run(recorder, [row("c", text, withFacets, "2026-09-23T00:00:00Z", null), row("b", text, {}, "2026-09-22T00:00:00Z", "a"), row("a", text, {}, "2026-09-21T00:00:00Z", null)]);
    ok(r.r.twinsMarked === 1 && r.calls.join("; ") === "update c supersedes=b", `twins: only the missing pointer is set (c→b; b→a already stands), the head untouched (${r.calls.join("; ")})`);
    r = await run(recorder, [row("c", text, withFacets, "2026-09-23T00:00:00Z", "x"), row("b", text, {}, "2026-09-22T00:00:00Z", null)]);
    ok(r.r.twinsMarked === 2 && r.calls.join("; ") === "update c supersedes=null; update c supersedes=b; update b supersedes=x", `a hand-set pointer to another thought moves to the tail: clear first, then set (${r.calls.join("; ")})`);
    // The twin that already holds the new text is the head; no model call; the other row chained under it.
    r = await run(recorder, [row("b", text, withFacets, "2026-09-22T00:00:00Z", "a"), row("a", `${doneText} `, {}, "2026-09-21T00:00:00Z", null)], done);
    ok(r.r.outcome === "patched" && r.calls.join("; ") === "update a patch(source,issue,project,status,status_type,priority,labels,url,linear_updated_at); update b supersedes=null; update a supersedes=b",
      `the twin holding Linear's text (up to whitespace) becomes the head: its facets patched first, then b's pointer cleared and a→b set, nothing embedded (${r.calls.join("; ")})`);
    // Held by a thought outside the group: parked, with linear_updated_at, outcome refused.
    const dupStore: Writer["store"] = { captureThought: recorder.store.captureThought, updateThought: async (o) => { if (o.content !== undefined) { calls.push(`update ${o.id} content → DUPLICATE_CONTENT`); return { ok: false, error: "DUPLICATE_CONTENT" }; } return recorder.store.updateThought(o); } };
    r = await run({ ...recorder, store: dupStore }, [row("b", text, withFacets, null, null)], done);
    // The fresh tags describe the new text, which the row does not hold, so the parked patch carries the facets alone.
    ok(r.r.outcome === "refused" && r.calls.join("; ") === "embed; tags; update b content → DUPLICATE_CONTENT; update b patch(status,status_type,text_refused_by)",
      `DUPLICATE_CONTENT at the write (the holder arrived after the lookup): the facets are patched WITHOUT the watermark, so the ticket stays stale and is retried, outcome refused (${r.calls.join("; ")})`);
    const refusing: Writer = { ...recorder, cfg: resolveEmbedConfig({ OB1_LLM_BASE_URL: "https://api.example.com/v1", OB1_LLM_API_KEY: "k", OB1_EGRESS_POLICY: "deny" }) };
    r = await run(refusing, []);
    ok(r.r.noVector && r.calls.join("; ") === 'capture "Backlog" vec=no type=-', `under deny to a hosted endpoint: no embed, no tags, the row lands bare (${r.calls.join("; ")})`);

    // The second review pass's scenario, to a fixpoint: C newest (Backlog),
    // T0 (In Progress), T1 oldest (Done), no pointers; Linear moves to Done.
    const brain = fakeBrain({
      C: { content: text, metadata: withFacets, supersedes: null, created_at: "2026-09-23T00:00:00Z" },
      T0: { content: renderIssue({ ...issue, state: { name: "In Progress", type: "started" } }), metadata: {}, supersedes: null, created_at: "2026-09-22T00:00:00Z" },
      T1: { content: doneText, metadata: {}, supersedes: null, created_at: "2026-09-21T00:00:00Z" },
    });
    const live: Writer = { ...recorder, store: brain.store, fingerprintOf: brain.fingerprintOf, holderOf: brain.holderOf, embed: async () => { brain.writes.push("embed"); return { embedding: [1], model: "m", chunks: [] }; } };
    const pass = async () => { brain.writes.length = 0; const rows = groupTicketRows(brain.brainRows()).get("SMD-1936")!; const r = await syncIssue(live, done, rows); return { r, writes: brain.writes.slice(), head: rows[0].id }; };
    let p = await pass();
    ok(p.r.outcome === "patched" && !p.writes.includes("embed") && !p.writes.some((w) => /WOULD_CYCLE|DUPLICATE/.test(w)), `pass 1: T1 promoted, no embed, no refusal (${p.writes.join("; ")})`);
    ok(brain.rows.get("T1")!.supersedes === "C" && brain.rows.get("C")!.supersedes === "T0" && brain.rows.get("T0")!.supersedes === null && brain.rows.get("T1")!.metadata.status === "Done", "…the chain is T1→C→T0 and T1 carries the facets");
    p = await pass();
    ok(p.head === "T1" && p.r.outcome === "unchanged" && p.writes.length === 0, `pass 2: T1 is the head by the chain and nothing is written (head ${p.head}; ${p.writes.join("; ")})`);
    // The same brain, the ticket moves again (In Progress): T0 holds that text and takes the head.
    const back: LinearIssue = { ...issue, state: { name: "In Progress", type: "started" }, updatedAt: "2026-09-22T03:00:00.000Z" };
    brain.writes.length = 0;
    const r3 = await syncIssue(live, back, groupTicketRows(brain.brainRows()).get("SMD-1936")!);
    ok(r3.outcome === "patched" && brain.rows.get("T0")!.supersedes === "T1" && brain.rows.get("T1")!.supersedes === "C" && brain.rows.get("C")!.supersedes === null && !brain.writes.some((w) => /WOULD_CYCLE/.test(w)), `moved again: T0 takes the head, chain T0→T1→C, no cycle refused (${brain.writes.join("; ")})`);
    ok(groupTicketRows(brain.brainRows()).get("SMD-1936")![0].id === "T0" && (await syncIssue(live, back, groupTicketRows(brain.brainRows()).get("SMD-1936")!)).outcome === "unchanged", "…and the pass after writes nothing");
    // A new ticket whose text a stray row already holds (a paste the grammar did not recognise).
    const stray = fakeBrain({ S: { content: ` ${text}`, metadata: { source: "mcp" }, supersedes: null, created_at: null } });
    const strayWriter: Writer = { ...live, store: stray.store, fingerprintOf: stray.fingerprintOf, holderOf: stray.holderOf };
    const adopted = await syncIssue(strayWriter, issue, []);
    ok(adopted.outcome === "patched" && stray.writes.join("; ") === "update S patch" && stray.rows.get("S")!.metadata.issue === "SMD-1936", `a stray holder is adopted by fingerprint, not captured twice (${stray.writes.join("; ")})`);

    // fetchIssues: one refused alias fails one identifier, not the batch.
    const fakeGql: Gql = async <T,>(_q: string, vars: Record<string, unknown> = {}) => {
      const data: Record<string, unknown> = {};
      const errors: { message: string; path?: (string | number)[] }[] = [];
      for (const [k, v] of Object.entries(vars)) {
        const alias = `a${k.slice(1)}`;
        if (v === "SMD-404") { data[alias] = null; errors.push({ message: "Entity not found", path: [alias] }); }
        else data[alias] = { ...issue, identifier: v as string };
      }
      return { data: data as T, errors };
    };
    // Ninth review pass: a rename the watermark cannot see, a chain write that throws, a batch refused whole.
    const c0: CensusRow = { identifier: "SMD-1936", updatedAt: issue.updatedAt, project: issue.project!.name, status: "Backlog", labels: ["infrastructure"] };
    ok(planPass([c0], new Map([["SMD-1936", [row("R", text, withFacets, null, null)]]])).stale.length === 0, "a census row whose names match the facets is unchanged");
    ok(planPass([{ ...c0, project: "Release Eng" }], new Map([["SMD-1936", [row("R", text, withFacets, null, null)]]])).stale.length === 1, "…a renamed project makes the ticket stale though updatedAt did not move");
    ok(planPass([{ ...c0, status: "Todo" }], new Map([["SMD-1936", [row("R", text, withFacets, null, null)]]])).stale.length === 1 && planPass([{ ...c0, labels: ["Improvement", "infrastructure"] }], new Map([["SMD-1936", [row("R", text, { ...withFacets, labels: ["infrastructure", "Improvement"] }, null, null)]]])).stale.length === 1, "…a renamed state or a changed label set too, the labels compared in one order");
    // A head holding the text with fallback tags is left to SMD-1975's worker: no model call, nothing written here.
    r = await run(chatDenied, [row("F", text, { ...withFacets, topics: ["uncategorized"], type: "observation", metadata_extraction_failed: "provider_timeout" }, null, null)]);
    ok(r.r.outcome === "unchanged" && r.calls.length === 0, `the head holding the text with fallback tags: nothing written, no call — the retag worker's job (${r.calls.join("; ")})`);
    // Tenth review pass: staleness is judged on the row that carries the watermark; a thrown fetch is a batch refused whole; the grammar is one spelling; the vector is paid for before the tags.
    ok(planPass([c0], new Map([["SMD-1936", [row("O", text, { ...withFacets, status: "Old", linear_updated_at: undefined as unknown as string }, "2026-09-23T00:00:00Z", null), row("W", text, withFacets, "2026-09-22T00:00:00Z", null)]]])).stale.length === 0,
      "the names and the tags are judged on the row carrying the newest watermark, not on rows[0] — a holder that could not be chained does not keep the ticket stale");
    const throwsHttp: Gql = async <T,>(_q: string, vars: Record<string, unknown> = {}) => { if (Object.values(vars)[0] === "SMD-1") throw new Error("Linear returned HTTP 429 Too Many Requests"); return fakeGql<T>(_q, vars); };
    const thrown = await fetchIssues(throwsHttp, ["SMD-1", "SMD-2"]);
    ok(thrown.issues.length === 0 && thrown.failed.length === 2 && /HTTP 429/.test(thrown.failed[0].error), `a non-2xx the client throws on is a batch refused whole, reported, never a pass aborted (${JSON.stringify(thrown.failed.map((f) => f.error.slice(0, 40)))})`);
    ok(new RegExp(HEADER_PATTERN).test(text) && !new RegExp(HEADER_PATTERN).test("SMD-1903 — DONE 2026-09-22: the egress gate landed in Open Brain.") && HEADER_RE.test(text), "the SQL pre-filter's pattern and the JS grammar are one spelling and agree on a ticket row and a note");
    const embedThrows: Writer = { ...recorder, embed: async () => { calls.push("embed"); throw new Error("returned no embedding"); } };
    let threw = false;
    calls.length = 0;
    try { await syncIssue(embedThrows, done, [row("cur", text, withFacets, null, null)]); } catch { threw = true; }
    ok(threw && calls.join("; ") === "embed", `an embedder that throws fails the edit before any chat call is paid for (${calls.join("; ")})`);
    // Thirteenth review pass: the order below the head is the chain, so an unchanged board writes nothing on the pass after a re-chain and a hand-set twin order stands.
    const chainBrain = fakeBrain({
      H: { content: text, metadata: withFacets, supersedes: null, created_at: "2026-09-23T00:00:00Z" },
      r1: { content: `${text} (older paste)`, metadata: {}, supersedes: "r2", created_at: "2026-09-21T00:00:00Z" },
      r2: { content: `${text} (oldest paste)`, metadata: {}, supersedes: null, created_at: "2026-09-22T00:00:00Z" },
    });
    const chainWriter: Writer = { ...live, store: chainBrain.store, fingerprintOf: chainBrain.fingerprintOf, holderOf: chainBrain.holderOf };
    const p1 = await syncIssue(chainWriter, issue, groupTicketRows(chainBrain.brainRows()).get("SMD-1936")!);
    const w1 = chainBrain.writes.slice(); chainBrain.writes.length = 0;
    const p2 = await syncIssue(chainWriter, issue, groupTicketRows(chainBrain.brainRows()).get("SMD-1936")!);
    ok(p1.twinsMarked === 1 && w1.join("; ") === "update H supersedes=r1" && p2.twinsMarked === 0 && chainBrain.writes.length === 0 && chainBrain.rows.get("r1")!.supersedes === "r2",
      `pass one chains the head onto the hand-set twins (H→r1→r2); the pass after writes nothing and the hand's r1→r2 stands (${w1.join("; ")} | ${chainBrain.writes.join("; ")})`);
    ok(groupTicketRows([row("H", text, {}, "2026-09-23T00:00:00Z", "r1"), row("r2", text, {}, "2026-09-22T00:00:00Z", null), row("r1", text, {}, "2026-09-21T00:00:00Z", "r2")]).get("SMD-1936")!.map((x) => x.id).join(",") === "H,r1,r2", "grouping follows the pointers from the head, not the ages below it");
    // A row that takes the text between the model calls and the write is adopted with the facets, not clobbered with a fallback tag set.
    let looks = 0;
    const lateWriter: Writer = { ...recorder, holderOf: async () => (++looks === 2 ? row("L", ` ${text}`, { type: "task", topics: ["real"] }, null, null) : null) };
    r = await run(lateWriter, []);
    ok(r.r.outcome === "patched" && r.calls.join("; ") === "embed; tags; update L patch(source,issue,project,status,status_type,priority,labels,url,linear_updated_at)", `a holder found on the second look takes the facets alone; its tags stand (${r.calls.join("; ")})`);
    // A head-window vector is said and counted.
    r = await run({ ...recorder, embed: async () => { calls.push("embed"); return { embedding: [1], model: "m", chunks: [], wholeContentFellBack: true, wholeContentError: "413" }; } }, []);
    ok(r.r.headWindow === true, "a vector the provider refused whole is reported, not passed as a whole-text vector");
    // The set that builds the chain throws; the restore that follows it lands.
    const throwing: Writer["store"] = { captureThought: recorder.store.captureThought, updateThought: async (o) => { if (o.provenance?.supersedes === "N") { calls.push(`update ${o.id} supersedes=N → THROW`); throw new Error("connection reset"); } return recorder.store.updateThought(o); } };
    r = await run({ ...recorder, store: throwing }, [row("H", text, withFacets, "2026-09-23T00:00:00Z", "x"), row("N", text, {}, "2026-09-22T00:00:00Z", null)]);
    ok(r.r.chainRefusal !== undefined && /connection reset/.test(r.r.chainRefusal) && r.calls.join("; ") === "update H supersedes=null; update H supersedes=N → THROW; update H supersedes=x", `a pointer write that throws is undone like a refusal — H→x restored (${r.calls.join("; ")})`);
    const limited: Gql = async <T,>(_q: string, vars: Record<string, unknown> = {}) => (Object.values(vars)[0] === "SMD-1" ? { data: null, errors: [{ message: "RATELIMITED" }] } : fakeGql<T>(_q, vars));
    const many = Array.from({ length: 60 }, (_, i) => `SMD-${i === 0 ? 1 : 100 + i}`);
    const cut = await fetchIssues(limited, many);
    ok(cut.issues.length === 0 && cut.failed.length === 60 && /RATELIMITED/.test(cut.failed[0].error) && /not attempted/.test(cut.failed[59].error), `a batch refused whole stops the fetch; the batches behind it are reported not attempted (${cut.failed.length} failed)`);
    const fetched = await fetchIssues(fakeGql, ["SMD-1", "SMD-404", "SMD-2"]);
    ok(fetched.issues.map((i) => i.identifier).join(",") === "SMD-1,SMD-2" && fetched.failed.length === 1 && fetched.failed[0].identifier === "SMD-404" && /Entity not found/.test(fetched.failed[0].error), `a refused alias is reported by identifier and the rest proceed (${JSON.stringify(fetched.failed)})`);

    // A board: one initiative, one project, three issues (one trashed); the census, the plan, and --only.
    const board: Gql = async <T,>(q: string, vars: Record<string, unknown> = {}) => {
      if (/initiatives\(/.test(q)) return { data: { initiatives: { pageInfo: { hasNextPage: false, endCursor: "" }, nodes: [{ name: "Open Brain — self-hosted AI memory", projects: { pageInfo: { hasNextPage: vars.after === "more" }, nodes: [{ id: "p1", name: "P" }] } }] } } as T, errors: [] };
      if (/issues\(first: \d+/.test(q)) return { data: { issues: { pageInfo: { hasNextPage: false, endCursor: "" }, nodes: [
        { identifier: "SMD-1936", updatedAt: issue.updatedAt, trashed: null, project: { name: issue.project!.name }, state: { name: "Backlog" }, labels: { nodes: [{ name: "infrastructure" }] } },
        { identifier: "SMD-2000", updatedAt: "2026-09-22T02:00:00.000Z", trashed: false, project: { name: "P" }, state: { name: "Backlog" }, labels: { nodes: [] } },
        { identifier: "SMD-666", updatedAt: "2026-09-22T02:00:00.000Z", trashed: true, project: { name: "P" }, state: { name: "Backlog" }, labels: { nodes: [] } },
      ] } } as T, errors: [] };
      return fakeGql<T>(q, vars);
    };
    const census2 = await censusOf(board, ["p1"]);
    ok(census2.map((c) => c.identifier).join(",") === "SMD-1936,SMD-2000", `a trashed issue falls out of the census, so its row would be extra and a fresh deletion is never captured (${census2.map((c) => c.identifier).join(",")})`);
    const onlyBrain = fakeBrain({ K: { content: text, metadata: withFacets, supersedes: null, created_at: null } });
    const onlyWriter: Writer = { ...live, store: onlyBrain.store, fingerprintOf: onlyBrain.fingerprintOf, holderOf: onlyBrain.holderOf, log: () => {} };
    const rep = await runPass({ gql: board, readRows: async () => onlyBrain.brainRows(), writer: onlyWriter, initiative: "Open Brain", full: false, only: ["SMD-1936", "SMD-9999"] });
    // A claimed row for another ticket beside an unadopted hand capture: the pass reads the headers because something is missing, and adopts (fourth review pass).
    const mixed = fakeBrain({
      K: { content: renderIssue({ ...issue, identifier: "SMD-2000", title: "other" }), metadata: { ...issueFacets({ ...issue, identifier: "SMD-2000" }), linear_updated_at: "2026-09-22T02:00:00.000Z" }, supersedes: null, created_at: null },
      H: { content: text, metadata: { source: "mcp" }, supersedes: null, created_at: null },
    });
    const scans: boolean[] = [];
    const mixedWriter: Writer = { ...live, store: mixed.store, fingerprintOf: mixed.fingerprintOf, holderOf: mixed.holderOf, log: () => {} };
    const repMixed = await runPass({ gql: board, readRows: async (scan) => { scans.push(scan); return mixed.brainRows().filter((r) => scan || "issue" in r.metadata); }, writer: mixedWriter, initiative: "Open Brain", full: false });
    ok(JSON.stringify(scans) === "[false,true]" && repMixed.tally.captured === 0 && repMixed.tally.patched === 1 && mixed.rows.get("H")!.metadata.issue === "SMD-1936" && mixed.rows.size === 2,
      `the hand capture is read on the second look and adopted, not captured beside (scans ${JSON.stringify(scans)}, ${JSON.stringify(repMixed.tally)})`);
    // Thirteenth review pass: a STALE ticket's pass scans the headers too, so a later paste of an adopted ticket with a text that is not Linear's is chained, not left as a second answer.
    const staleMixed = fakeBrain({
      A: { content: text, metadata: { ...withFacets, linear_updated_at: "2026-09-22T00:30:00.000Z" }, supersedes: null, created_at: "2026-09-22T00:00:00Z" },
      P: { content: renderIssue({ ...issue, state: { name: "Todo", type: "unstarted" } }), metadata: { source: "mcp" }, supersedes: null, created_at: "2026-09-23T00:00:00Z" },
    });
    const staleScans: boolean[] = [];
    const staleWriter: Writer = { ...live, store: staleMixed.store, fingerprintOf: staleMixed.fingerprintOf, holderOf: staleMixed.holderOf, log: () => {} };
    const repStale = await runPass({ gql: board, readRows: async (scan) => { staleScans.push(scan); return staleMixed.brainRows().filter((r) => scan || "issue" in r.metadata); }, writer: staleWriter, initiative: "Open Brain", full: false, only: ["SMD-1936"] });
    ok(JSON.stringify(staleScans) === "[false,true]" && repStale.tally.patched === 1 && repStale.tally.updated === 0 && staleMixed.rows.get("A")!.supersedes === "P" && staleMixed.rows.get("P")!.supersedes === null,
      `a stale ticket's pass reads the headers, patches the adopted holder of the current text and chains the later paste under it (scans ${JSON.stringify(staleScans)}, ${JSON.stringify(repStale.tally)}, P→${staleMixed.rows.get("P")!.supersedes}, A→${staleMixed.rows.get("A")!.supersedes})`);
    ok(rep.plan.unchanged === 1 && rep.tally.unchanged === 1 && rep.errors.length === 1 && /not in the census/.test(rep.errors[0].error) && rep.errors[0].identifier === "SMD-9999" && rep.tally.captured === 0,
      `--only fetches the named identifier though the plan calls it unchanged, and names the one the census lacks; the missing SMD-2000 is not touched (${JSON.stringify({ tally: rep.tally, errors: rep.errors })})`);
    let refusedProjects = false;
    try { await initiativeProjects(async <T,>(q: string) => board<T>(q, { after: "more" }), "Open Brain"); } catch (e) { refusedProjects = /more than 50 projects/.test((e as Error).message); }
    ok(refusedProjects, "an initiative with more projects than one page is refused, not silently shortened");

    // A moved text with a fallback answer: the old text's people fall with the tags the answer did not set (tagsOverExisting, the shared rule).
    r = await run({ ...recorder, tags: async () => { calls.push("tags"); return { topics: ["uncategorized"], type: "observation", metadata_extraction_failed: "provider_timeout" }; } }, [row("cur", text, { ...withFacets, people: ["someone"] }, null, null)], done);
    ok(r.r.outcome === "updated" && r.calls[2]?.includes("people") === true && r.calls[2]?.includes("metadata_extraction_failed") === true, `a fallback answer on an edit nulls the old text's people it did not set and carries the marker (${r.calls.join("; ")})`);
    // The update branch clears a twin's stale refusal too.
    r = await run(recorder, [row("B", text, { ...withFacets, status: "Done", status_type: "completed" }, "2026-09-23T00:00:00Z", "A"), row("A", text, { text_refused_by: "Z" }, "2026-09-22T00:00:00Z", null)], { ...issue, state: { name: "In Progress", type: "started" } });
    ok(r.calls.some((c) => c === "update A patch(text_refused_by)"), `after a text update the twin's refusal marker is cleared (${r.calls.join("; ")})`);
    ok(/DROPPED/.test(desiredPointers([row("H", text, {}, null, "X"), row("T", text, {}, null, "Y")]).map((c) => c.dropped?.join() ?? "").join()) === false && desiredPointers([row("H", text, {}, null, "X"), row("T", text, {}, null, "Y")]).at(-1)?.dropped?.join() === "Y", "a second outside pointer is named as dropped on the tail's change, not lost in silence");
    // A refused set undoes the sets that landed too, not the clears alone.
    sets = 0;
    const thirdFails: Writer["store"] = { captureThought: recorder.store.captureThought, updateThought: async (o) => { if (o.provenance && o.provenance.supersedes != null && ++sets === 3) { calls.push(`update ${o.id} supersedes=${o.provenance.supersedes} → WOULD_CYCLE`); return { ok: false, error: "WOULD_CYCLE" }; } return recorder.store.updateThought(o); } };
    r = await run({ ...recorder, store: thirdFails }, [row("H", text, withFacets, "2026-09-23T00:00:00Z", null), row("A", text, {}, "2026-09-22T00:00:00Z", "F"), row("B", text, {}, "2026-09-21T00:00:00Z", null)]);
    ok(r.r.chainRefusal !== undefined && r.calls.join("; ") === "update A supersedes=null; update H supersedes=A; update A supersedes=B; update B supersedes=F → WOULD_CYCLE; update H supersedes=null; update A supersedes=F",
      `every write before the refusal is undone, each row once, to what it held — H back to null, A back to F (${r.calls.join("; ")})`);
    // The structure hook (SMD-1867): called once, with the row that holds the
    // ticket and the adapter's mapping, after a capture, an adoption, a patch
    // and an edit; not on a dry run; not for a text another ticket claims.
    {
      const seen: string[] = [];
      const hooked: Writer = { ...recorder, structure: async (id, s) => { seen.push(`${id}:${s.identity.key}:${s.links.map((l) => `${l.relation}=${l.target}`).join("+")}:${s.mentions.length}`); } };
      const expectHook = async (label: string, rows: BrainRow[], iss: LinearIssue, want: string[]) => {
        seen.length = 0; calls.length = 0;
        await syncIssue(hooked, iss, rows);
        ok(JSON.stringify(seen) === JSON.stringify(want), `${label}: structure recorded ${JSON.stringify(want)} (got ${JSON.stringify(seen)})`);
      };
      const sig = "SMD-1936:references=SMD-1730:2";
      await expectHook("a capture", [], issue, [`new:${sig}`]);
      await expectHook("a facet patch on the head", [row("cur", text, { source: "linear", issue: "SMD-1936" }, null, null)], issue, [`cur:${sig}`]);
      await expectHook("an unchanged head", [row("cur", text, { ...issueFacets(issue) }, null, null)], issue, [`cur:${sig}`]);
      await expectHook("an edit", [row("cur", "old text", { ...issueFacets(issue), linear_updated_at: "2026-09-21T00:00:00.000Z" }, null, null)], issue, [`cur:${sig}`]);
      await expectHook("a parent and a relation", [], { ...issue, parent: { identifier: "SMD-949" }, relations: { nodes: [{ type: "blocks", relatedIssue: { identifier: "SMD-1814" } }] } }, ["new:SMD-1936:blocks=SMD-1814+child_of=SMD-949+references=SMD-1730:2"]);
      const held: Writer = { ...hooked, holderOf: async () => row("H", text, { source: "linear", issue: "SMD-2000" }, null, null) };
      seen.length = 0;
      await syncIssue(held, issue, []);
      ok(seen.length === 0, "a text held under another ticket's claim records no structure (the row is not this ticket's)");
      seen.length = 0;
      await syncIssue({ ...hooked, dryRun: true }, issue, []);
      ok(seen.length === 0, "a dry run records no structure");
      seen.length = 0;
      await syncIssue(recorder, issue, []);
      ok(seen.length === 0 && calls.length > 0, "a Writer without the hook writes rows alone (a brain before 051)");
    }
    // No projects is no board.
    let refusedEmpty = false;
    const empty: Gql = async <T,>() => ({ data: { initiatives: { pageInfo: { hasNextPage: false, endCursor: "" }, nodes: [{ name: "Open Brain", projects: { pageInfo: { hasNextPage: false }, nodes: [] } }] } } as T, errors: [] });
    try { await initiativeProjects(empty, "Open Brain"); } catch (e) { refusedEmpty = /no projects/.test((e as Error).message); }
    ok(refusedEmpty, "an initiative with no projects is refused by name, not an empty census");

    if (bad === 0) console.log("sync-linear.ts self-check PASS");
    return bad === 0 ? 0 : 1;
  })();
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const TAKES_ONE = new Set(["url", "initiative", "interval", "only"]);
  const TAKES_NONE = new Set(["dry-run", "loop", "audit", "full", "self-check", "quiet", "allow-refused"]);
  const USAGE = "  flags: --url <postgres://…>, --initiative <name>, --interval <seconds>, --only <SMD-1,SMD-2>, --dry-run, --loop, --audit, --full, --quiet, --allow-refused, --self-check";
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const name = a.startsWith("--") ? a.slice(2) : null;
    if (name === null) { console.error(`unknown argument: ${/:\/\//.test(a) ? "<a URL>" : a} (a value where no flag takes one)\n${USAGE}`); process.exit(2); }
    if (values.has(name) || flags.has(name)) { console.error(`--${name} given twice.\n${USAGE}`); process.exit(2); }
    if (TAKES_ONE.has(name)) {
      if (i + 1 >= args.length || args[i + 1].startsWith("--")) { console.error(`--${name} takes a value.\n${USAGE}`); process.exit(2); }
      values.set(name, args[++i]);
    } else if (TAKES_NONE.has(name)) flags.add(name);
    else { console.error(`unknown argument: ${a}\n${USAGE}`); process.exit(2); }
  }
  if (flags.has("self-check")) process.exit(await selfCheck());
  // --audit is the whole board's census; --only would be read by nothing on that branch (fourth review pass).
  if (flags.has("audit") && values.has("only")) { console.error(`--audit takes no --only: the census is the whole board.\n${USAGE}`); process.exit(2); }
  // …nor --full or --dry-run: the audit writes nothing and compares the census, not the text (eleventh review pass).
  for (const f of ["full", "dry-run"]) if (flags.has("audit") && flags.has(f)) { console.error(`--audit takes no --${f}: it writes nothing and compares the census alone.\n${USAGE}`); process.exit(2); }

  // Every knob from the environment, else the `.env` files on db/env.ts's search
  // path — the provider knobs too, so a checkout run resolves the endpoint and
  // the egress policy a server started from deploy/.env would (seventh review
  // pass; before it only the key was read from the files and the rest fell to
  // the defaults: deny, every ticket bare). A set variable is never overwritten.
  // In the container none of the files is on the mount, so this reads nothing.
  const envSources = loadEnv();
  const key = process.env.LINEAR_API_KEY?.trim();
  if (!key) {
    console.error(`LINEAR_API_KEY is not set, and no .env file supplied it. Create a personal API key at https://linear.app/settings/api and put it in a .env (gitignored; see evals/.env.example).\n  Read: ${describeEnv(envSources)}`);
    process.exit(2);
  }
  const url = values.get("url") ?? process.env.DATABASE_URL;
  if (!url) { console.error("No database URL. Pass --url or set DATABASE_URL."); process.exit(2); }
  const initiative = values.get("initiative")?.trim() || process.env.OB1_LINEAR_INITIATIVE?.trim() || DEFAULT_INITIATIVE;
  const intervalRaw = values.get("interval")?.trim() || process.env.OB1_BOARD_SYNC_INTERVAL?.trim();
  const interval = intervalRaw ? Number(intervalRaw) : DEFAULT_INTERVAL_S;
  if (!Number.isInteger(interval) || interval < 10) { console.error(`--interval / OB1_BOARD_SYNC_INTERVAL must be a whole number of seconds, at least 10 (got "${intervalRaw}").`); process.exit(2); }
  const dryRun = flags.has("dry-run");
  const quiet = flags.has("quiet");
  const only = values.get("only")?.split(",").map((s) => s.trim()).filter(Boolean);

  const gql = linearClient(key);
  // One connection each: the reader and the store, serial by construction.
  const sql = new SQL({ url, max: 1 });
  const store = new SqlStore(url, { max: 1 });
  let stopping = false;
  let noFingerprintSaid = false;
  // Resolved once, as db/reembed.ts does; the embedder does not remember a
  // refusal across rows (each row's length is its own).
  const cfg = resolveEmbedConfig(process.env as EmbedEnv);
  // The refusal that does not depend on the row (db/reembed.ts asks the same
  // before claiming anything): every embedding would be refused, so every
  // ticket would land bare and read as synced — refused here unless the
  // operator says that is meant (seventh review pass). --audit embeds nothing.
  // Both endpoints (tenth review pass): a chat endpoint refused wholesale would
  // land every ticket with a vector and `egress_denied` for its tags, which
  // nothing revisits until the ticket next moves in Linear.
  const wholesale = refusesEverything(cfg.embeddings, cfg.egress)
    ?? (cfg.chat.base !== cfg.embeddings.base || cfg.chat.local !== cfg.embeddings.local ? refusesEverything(cfg.chat, cfg.egress) : null);
  if (wholesale && !flags.has("allow-refused") && !flags.has("audit")) {
    console.error(`  Refusing to run: ${wholesale}. Declare the endpoint local (OB1_LLM_LOCAL=1 / OB1_CHAT_LOCAL=1) when it is, allow this writer (OB1_EGRESS_ALLOW=actor:${ACTOR_NAME}), or pass --allow-refused to land every ticket without the refused call's result on purpose.\n  Read: ${describeEnv(envSources)}`);
    process.exit(2);
  }
  const embedder = createEmbedder(() => cfg, { rememberRefusal: false });
  const session = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
  // One run name per pass, for thought_sources.ingest_run (SMD-1867); a loop's
  // passes are told apart by it.
  let run = runName(SELF);
  const writer: Writer = {
    store,
    cfg,
    embed: (content, subject) => embedder.embedCapture(content, subject),
    tags: (content, subject) => extractMetadata(content, subject, cfg),
    // The database's own rule (016), asked of the database — never a copy here.
    // A brain without the function (before 016) answers null, once said, and
    // the exact compare stands in, as the Writer's contract promises.
    fingerprintOf: async (text) => {
      try { const [r] = await sql`SELECT content_fingerprint_of(${text}) AS f`; return (r?.f as string | null) ?? null; }
      catch (e) {
        // Only "no such function" (SQLSTATE 42883 — the repo's idiom, as
        // db/ingest-records.ts reads 23505) is the brain-before-016 case the
        // contract's null is for; a dropped connection is an error and is one
        // (twelfth review pass: every error read as "not available").
        const sqlstate = (e as { errno?: string; code?: string }).errno ?? (e as { code?: string }).code;
        if (sqlstate !== "42883") throw e;
        if (!noFingerprintSaid) { noFingerprintSaid = true; console.error(`  content_fingerprint_of is not available (migration 016 not applied); same text is judged by exact compare this run`); }
        return null;
      }
    },
    // By the stored fingerprint, else by the rule computed over the rows 018
    // left unfingerprinted (a NULL fingerprint, so a small set) — such a holder
    // otherwise answered DUPLICATE_CONTENT only after the embed and the tags
    // were paid for, every pass (thirteenth review pass).
    holderOf: async (fp) => {
      const [r] = await sql`SELECT ${rowColumns(sql)} FROM thoughts WHERE content_fingerprint = ${fp}
        UNION ALL SELECT ${rowColumns(sql)} FROM thoughts WHERE content_fingerprint IS NULL AND content_fingerprint_of(content) = ${fp}
        LIMIT 1`;
      return (r as BrainRow | undefined) ?? null;
    },
    actor: { name: ACTOR_NAME, via: SELF, session },
    dryRun,
    log: quiet ? () => {} : (line) => console.log(line),
    stopping: () => stopping,
    // The canonical, the links and the mentions beside the head row (051).
    // `take`: a ticket's head row moves when an older paste becomes the
    // chain's head, and the identity follows the head — without it the hook
    // would refuse IDENTITY_HELD by the old head on every pass (first review
    // pass).
    // One transaction: the takeover (the old head's links closed, its mentions
    // removed, its source row gone), the canonical, the links and the mentions
    // land together or not at all — three autocommit statements left a ticket
    // edge-less until it next moved when the second failed (third review pass,
    // independent read).
    structure: async (id, s) => { await sql.begin(async (tx) => { await recordStructure(tx, id, s, run, { take: true }); }); },
  };

  let resolved: Board | undefined;
  const once = async (): Promise<number> => {
    const t0 = Date.now();
    run = runName(SELF);
    // planBoard asks for the header scan when it needs it; --audit always does (the census should see a hand paste too).
    const readRows: ReadRows = (scanHeaders, claimed) => readTicketRows(sql, { scanHeaders, claimed });
    // The board the preflight resolved serves the first pass; later passes ask again, so a project added to the initiative is seen.
    const board = resolved; resolved = undefined;
    if (flags.has("audit")) {
      const { initiative: name, projects, census, plan } = await planBoard({ gql, readRows, initiative, full: false, scan: true, board });
      console.log(`  board: ${name} — ${projects.length} project(s), ${census.length} issue(s)`);
      console.log(`  missing ${plan.missing.length}${plan.missing.length ? ` (${plan.missing.join(", ")})` : ""}`);
      console.log(`  stale   ${plan.stale.length}${plan.stale.length ? ` (${plan.stale.slice(0, 20).join(", ")}${plan.stale.length > 20 ? ", …" : ""})` : ""}`);
      console.log(`  extra   ${plan.extra.length}${plan.extra.length ? ` (${plan.extra.join(", ")})` : ""}`);
      // Extra counts too: a row for a ticket Linear no longer lists is not lockstep (fifth review pass; the docs said so all along).
      const drift = plan.missing.length + plan.stale.length + plan.extra.length;
      console.log(`  in lockstep: ${drift === 0 ? "yes" : "NO"}  (${Date.now() - t0} ms)`);
      return drift ? 1 : 0;
    }
    const report = await runPass({ gql, readRows, writer, initiative, full: flags.has("full"), only, board });
    console.log(formatReport(report, dryRun));
    console.log(`  ${dryRun ? "dry run — nothing written" : "done"} (${Date.now() - t0} ms)`);
    return report.errors.length ? 1 : 0;
  };

  // The initiative is configuration, resolved once before any pass: a name
  // that matches no initiative (or two) is exit 2 here, as a missing key is —
  // not a "pass failed" line every interval for as long as the loop runs
  // (sixth review pass). Under --loop the passes still ask Linear each time,
  // so a board that gains a project is seen.
  try { resolved = await initiativeProjects(gql, initiative); }
  catch (e) {
    // Configuration exits 2; a transport error is a pass that failed — under
    // --loop the next pass retries, a one-shot run exits 1 (twelfth pass).
    console.error(`  ${(e as Error).message}`);
    if (e instanceof BoardConfigError || !flags.has("loop")) { await store.close(); await sql.close(); process.exit(e instanceof BoardConfigError ? 2 : 1); }
  }

  // The signal handlers serve the one-shot pass too: a Ctrl-C mid-chain would
  // otherwise land between the clears and the sets with no undo (tenth review
  // pass). The pass ends after the issue in hand; a second signal is the
  // runtime's default and kills.
  const stop = () => { if (stopping) process.exit(130); stopping = true; console.error(`  stopping after the issue in hand (a second signal kills)`); };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);

  let code = 0;
  try {
    if (!flags.has("loop")) { code = await once(); return; }
    console.log(`  ${SELF}: a pass every ${interval} s against ${initiative}${dryRun ? " (dry run)" : ""}; SIGTERM/SIGINT ends the loop after the issue in hand`);
    while (!stopping) {
      console.log(`▸ ${new Date().toISOString()}`);
      // The last pass's result is the loop's exit code: a service whose every
      // pass reported errors must not stop clean (eleventh review pass).
      try { code = await once(); } catch (e) { code = 1; console.error(`  pass failed: ${(e as Error).message}`); }
      for (let waited = 0; waited < interval && !stopping; waited++) await Bun.sleep(1000);
    }
  } finally {
    await store.close();
    await sql.close();
    process.exitCode = code;
  }
}

if (import.meta.main) await main();
