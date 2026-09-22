#!/usr/bin/env bun
/**
 * sync-linear.ts — keep a brain in lockstep with the Linear board (SMD-1954).
 *
 * The dogfood brain held the Open Brain board only as hand captures: an agent
 * pasted each ticket through capture_thought, and a ticket that moved to Done
 * kept reading Backlog until someone pasted it again — which made a second
 * row, not an update (nine identifiers had two or more rows when this landed).
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
 *   bun db/sync-linear.ts --self-check                       # the pure parts, no network, no database
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
 * ticket rows (the hand re-captures), the newest is the one kept current and
 * each older twin is marked superseded by the next newer through
 * update_thought's provenance (032), so search labels it rather than returning
 * two Backlog-and-Done answers; nothing is deleted.
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
 * linear_updated_at, url. Linear's autolink markup (`<issue …>SMD-x</issue>`)
 * is stripped to the identifier before storing (SMD-1865's first item; the
 * typed edges are its second and stay there).
 *
 * The provider settings are the server's (OB1_LLM_BASE_URL, OB1_EMBEDDING_*,
 * OB1_METADATA_MODEL, OB1_LLM_LOCAL, OB1_EGRESS_*…), resolved once at start by
 * resolveEmbedConfig as db/reembed.ts does. LINEAR_API_KEY is the one knob of
 * its own; OB1_LINEAR_INITIATIVE (default "Open Brain") names the initiative
 * whose projects are the board. Both come from the environment or a .env file
 * (evals/env.ts's search: $OB1_ENV_FILE, evals/.env, <repo>/.env, deploy/.env).
 *
 * ── What it does not do ──────────────────────────────────────────────────────
 * Remove: an issue deleted in Linear or moved out of the initiative keeps its
 * row, reported under "extra" by --audit (ingest-records.ts has the same rule).
 * Comments: the corpus builder (evals/build-linear-corpus.ts) appends them for
 * the retrieval eval; the board mirror keeps the hand captures' shape, which
 * had none. A webhook: exact and immediate, but it needs an inbound URL the
 * stack has no origin for until SMD-1846, and SMD-1862 owns the Linear webhook
 * handler's shape (signature, replay window, loop guard); when both land the
 * handler calls syncIdentifiers() here with the one identifier it was told.
 */

import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { SqlStore } from "../server-portable/store-sql.ts";
import { createEmbedder, resolveEmbedConfig, type EmbedConfig, type EmbedEnv } from "../server-portable/embed.ts";
import { decideCalls, type EgressSubject } from "../server-portable/egress.ts";
import { extractMetadata, metadataRefused } from "../server-portable/metadata.ts";
import type { Actor } from "../server-portable/store.ts";
import { describeEnv, loadEnv } from "../evals/env.ts";

const API = "https://api.linear.app/graphql";
export const DEFAULT_INITIATIVE = "Open Brain";
export const DEFAULT_INTERVAL_S = 300;
export const ACTOR_NAME = "board-sync";
const SELF = "db/sync-linear.ts";

// ---------------------------------------------------------------------------
// The issue, as Linear gives it and as the brain stores it — pure functions.
// ---------------------------------------------------------------------------

export type LinearIssue = {
  identifier: string;
  title: string;
  description: string | null;
  url: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  priorityLabel: string;
  state: { name: string; type: string };
  project: { id: string; name: string } | null;
  parent: { identifier: string } | null;
  labels: { nodes: { name: string }[] };
};

/** The identifier at the head of a ticket row, and the header grammar the hand captures used. */
export const IDENTIFIER_RE = /^([A-Z][A-Z0-9]+-\d+)\b/;
const HEADER_RE = /^([A-Z][A-Z0-9]+-\d+) — [^\n]*\nProject: [^\n]*\nhttps:\/\/linear\.app\/[^\n]*(?:\n|$)/;

/**
 * Linear's autolink markup, `<issue id="…" href="…">SMD-1234</issue>`, to the
 * identifier it wraps — ~80 bytes of URL boilerplate per cross-reference that
 * bloated every embedding and tripped the extractor (SMD-1865). Only that
 * element: the description is otherwise Markdown, which is kept.
 */
export function stripAutolinks(text: string): string {
  return text.replace(/<issue\b[^>]*>([^<]*)<\/issue>/g, "$1");
}

/** The facets Linear knows about an issue — what `metadata` carries beside the extracted tags. */
export function issueFacets(issue: LinearIssue): Record<string, unknown> {
  return {
    source: "linear",
    issue: issue.identifier,
    project: issue.project?.name ?? null,
    status: issue.state.name,
    status_type: issue.state.type,
    priority: issue.priorityLabel,
    labels: issue.labels.nodes.map((l) => l.name),
    parent: issue.parent?.identifier ?? null,
    url: issue.url,
    linear_updated_at: issue.updatedAt,
    ...(issue.archivedAt ? { archived_at: issue.archivedAt } : {}),
  };
}

/**
 * The thought's text: the shape the hand captures used, exactly, so the first
 * pass over a hand-built brain rewrites the tickets that changed and not every
 * one of them. Header line, facet line, URL, blank, the description with
 * autolinks stripped. `Labels: none` and `Parent: none` are spelled, as the hand
 * did; the project too, for an issue that has none.
 */
export function renderIssue(issue: LinearIssue): string {
  const labels = issue.labels.nodes.map((l) => l.name);
  const header = `${issue.identifier} — ${issue.title.trim()}`;
  const facets = [
    `Project: ${issue.project?.name ?? "none"}`,
    `Status: ${issue.state.name} (${issue.state.type})`,
    `Priority: ${issue.priorityLabel}`,
    `Parent: ${issue.parent?.identifier ?? "none"}`,
    `Labels: ${labels.length ? labels.join(", ") : "none"}`,
  ].join(" · ");
  const body = stripAutolinks((issue.description ?? "").trim());
  return `${header}\n${facets}\n${issue.url}${body ? `\n\n${body}` : ""}`;
}

/** A brain row as this tool reads it. */
export type BrainRow = { id: string; content: string; metadata: Record<string, unknown>; created_at: string | null; supersedes: string | null };

/**
 * The identifier a row is a ticket row FOR, or null. Adopted rows say so in
 * metadata.issue; a hand capture is recognised by the header grammar alone —
 * a note that opens "SMD-N — DONE 2026-09-22: …" with no facet line is a
 * note, whatever its first token, and stays untouched.
 */
export function ticketIdentifier(row: Pick<BrainRow, "content" | "metadata">): string | null {
  const claimed = row.metadata?.issue;
  if (typeof claimed === "string" && IDENTIFIER_RE.test(claimed)) return claimed;
  const m = HEADER_RE.exec(row.content);
  return m ? m[1] : null;
}

/**
 * The brain's ticket rows grouped by identifier, newest first — the newest is
 * the row kept current; the rest are twins. Ties on created_at (a same-second
 * double paste) fall to the id so the order is stable across passes.
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
  }
  return byIssue;
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
 * The plan for one identifier from the census: which issues a pass must fetch
 * in full. `missing` — no ticket row; `stale` — the row's linear_updated_at is
 * older than Linear's, or absent (a hand capture, adopted on first sight);
 * `extra` — a ticket row Linear's list does not name (deleted, or moved out of
 * the initiative). `full` puts every listed issue in the fetch.
 */
export type Census = { identifier: string; updatedAt: string }[];
export type Plan = { fetch: string[]; missing: string[]; stale: string[]; extra: string[]; unchanged: number };

export function planPass(census: Census, groups: Map<string, BrainRow[]>, full = false): Plan {
  const missing: string[] = [], stale: string[] = [], fetch: string[] = [];
  let unchanged = 0;
  const listed = new Set<string>();
  for (const { identifier, updatedAt } of census) {
    listed.add(identifier);
    const rows = groups.get(identifier);
    if (!rows) { missing.push(identifier); fetch.push(identifier); continue; }
    const have = rows[0].metadata?.linear_updated_at;
    const isStale = typeof have !== "string" || have < updatedAt;
    if (isStale) { stale.push(identifier); fetch.push(identifier); }
    else if (full) fetch.push(identifier);
    else unchanged++;
  }
  const extra = [...groups.keys()].filter((k) => !listed.has(k)).sort();
  return { fetch, missing, stale, extra, unchanged };
}

// ---------------------------------------------------------------------------
// Linear
// ---------------------------------------------------------------------------

type Gql = <T>(query: string, variables?: Record<string, unknown>) => Promise<T>;

export function linearClient(key: string, fetchImpl: typeof fetch = fetch): Gql {
  // Personal API keys go in Authorization raw; OAuth tokens take Bearer.
  const auth = key.startsWith("lin_api_") ? key : `Bearer ${key}`;
  return async <T>(query: string, variables: Record<string, unknown> = {}): Promise<T> => {
    const res = await fetchImpl(API, {
      method: "POST",
      headers: { Authorization: auth, "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) throw new Error(`Linear returned HTTP ${res.status} ${res.statusText}: ${(await res.text()).slice(0, 300)}`);
    const json = (await res.json()) as { data?: T; errors?: { message: string }[] };
    // A GraphQL error arrives with HTTP 200 and an `errors` array.
    if (json.errors?.length) throw new Error(`Linear GraphQL error: ${json.errors.map((e) => e.message).join("; ")}`);
    if (json.data === undefined) throw new Error("Linear returned no data and no errors.");
    return json.data;
  };
}

/** The projects of the named initiative — the board. Matched on the exact name, else on the name's prefix when exactly one initiative starts with it. */
export async function initiativeProjects(gql: Gql, name: string): Promise<{ initiative: string; projects: { id: string; name: string }[] }> {
  type R = { initiatives: { nodes: { name: string; projects: { nodes: { id: string; name: string }[] } }[] } };
  const d = await gql<R>(`{ initiatives(first: 50) { nodes { name projects(first: 50, includeArchived: true) { nodes { id name } } } } }`);
  const exact = d.initiatives.nodes.filter((i) => i.name === name);
  const prefixed = exact.length ? exact : d.initiatives.nodes.filter((i) => i.name.startsWith(name));
  if (prefixed.length !== 1) {
    throw new Error(`OB1_LINEAR_INITIATIVE="${name}" matches ${prefixed.length} initiative(s) (${d.initiatives.nodes.map((i) => JSON.stringify(i.name)).join(", ")}); name one.`);
  }
  return { initiative: prefixed[0].name, projects: prefixed[0].projects.nodes };
}

/** Every issue's identifier and updatedAt across the projects: the census, archived issues included. */
export async function censusOf(gql: Gql, projectIds: string[]): Promise<Census> {
  type R = { issues: { pageInfo: { hasNextPage: boolean; endCursor: string }; nodes: { identifier: string; updatedAt: string }[] } };
  const out: Census = [];
  let after: string | null = null;
  do {
    const d: R = await gql<R>(
      `query($ids: [ID!], $after: String) { issues(first: 250, after: $after, includeArchived: true, filter: { project: { id: { in: $ids } } }) { pageInfo { hasNextPage endCursor } nodes { identifier updatedAt } } }`,
      { ids: projectIds, after },
    );
    out.push(...d.issues.nodes);
    after = d.issues.pageInfo.hasNextPage ? d.issues.pageInfo.endCursor : null;
  } while (after);
  return out;
}

const ISSUE_FIELDS = `identifier title description url createdAt updatedAt archivedAt priorityLabel state { name type } project { id name } parent { identifier } labels { nodes { name } }`;

/**
 * The issues named, in full, fifty a request: one query with an alias per
 * issue (`issue(id:)` takes an identifier as well as a uuid; the list filter's
 * `id: { in }` takes uuids only), so a first pass over three hundred tickets is
 * six requests, not three hundred.
 */
export async function fetchIssues(gql: Gql, identifiers: string[]): Promise<LinearIssue[]> {
  const out: LinearIssue[] = [];
  for (let i = 0; i < identifiers.length; i += 50) {
    const batch = identifiers.slice(i, i + 50);
    const vars = Object.fromEntries(batch.map((ident, j) => [`i${j}`, ident]));
    const decl = batch.map((_, j) => `$i${j}: String!`).join(", ");
    const fields = batch.map((_, j) => `a${j}: issue(id: $i${j}) { ${ISSUE_FIELDS} }`).join("\n");
    const d = await gql<Record<string, LinearIssue | null>>(`query(${decl}) { ${fields} }`, vars);
    for (let j = 0; j < batch.length; j++) { const n = d[`a${j}`]; if (n) out.push(n); }
  }
  return out;
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
};

export type Writer = {
  store: Pick<SqlStore, "captureThought" | "updateThought">;
  cfg: EmbedConfig;
  embed: (content: string, subject: EgressSubject) => Promise<{ embedding: number[]; model: string; chunks: { content: string; embedding: number[]; context?: string }[] }>;
  tags: (content: string, subject: EgressSubject) => Promise<Record<string, unknown>>;
  actor: Actor;
  dryRun: boolean;
  log: (line: string) => void;
};

/** Read every ticket row the brain has — adopted rows by their claim, hand captures by their header. */
export async function readTicketRows(sql: SQL): Promise<BrainRow[]> {
  // The header grammar in SQL is only a pre-filter; ticketIdentifier() decides.
  const rows = await sql`
    SELECT id::text AS id, content, metadata, created_at::text AS created_at, supersedes::text AS supersedes
    FROM thoughts
    WHERE metadata ? 'issue' OR content ~ '^[A-Z][A-Z0-9]+-[0-9]+ — [^\n]*\nProject: '`;
  return rows as BrainRow[];
}

/**
 * Bring one issue's row(s) to what Linear says. New: a capture with the vector,
 * the tags and the facets. Changed text: an edit with a fresh vector, the facets
 * patched in the same statement. Facets only (a status change is text too, so
 * this is the adoption case — a hand capture whose text already matches): a
 * metadata patch, no model call. Twins: each older row superseded by the next
 * newer, once.
 */
export async function syncIssue(w: Writer, issue: LinearIssue, rows: BrainRow[]): Promise<{ outcome: Outcome; noVector: boolean; twinsMarked: number }> {
  const content = renderIssue(issue);
  const facets = issueFacets(issue);
  const gate = (kind: "capture" | "edit", metadata: Record<string, unknown>) =>
    decideCalls({ kind, actor: w.actor.name, metadata, content }, w.cfg, w.cfg.egress);
  const actorWith = (record: ReturnType<typeof decideCalls>["record"]): Actor => ({ ...w.actor, ...(record ? { egress: record } : {}) });

  let twinsMarked = 0;
  if (rows.length === 0) {
    const g = gate("capture", facets);
    if (w.dryRun) { w.log(`  + ${issue.identifier}: would capture (${g.embeddings.allowed ? "with" : "WITHOUT"} a vector)`); return { outcome: "captured", noVector: !g.embeddings.allowed, twinsMarked }; }
    const subject: EgressSubject = { kind: "capture", actor: w.actor.name, metadata: facets, content };
    const [embedded, tags] = await Promise.all([
      g.embeddings.allowed ? w.embed(content, subject) : Promise.resolve(undefined),
      g.chat.allowed ? w.tags(content, subject) : Promise.resolve(metadataRefused()),
    ]);
    // The facets last: Linear's word on status and project beats a tag the model guessed.
    await w.store.captureThought({
      content,
      payload: { metadata: { ...tags, ...facets } },
      chunks: embedded?.chunks ?? [],
      actor: actorWith(g.record),
      embedding: embedded?.embedding ?? null,
      embeddingModel: embedded?.model,
    });
    w.log(`  + ${issue.identifier}: captured${embedded ? "" : " WITHOUT a vector (egress refused)"}`);
    return { outcome: "captured", noVector: !embedded, twinsMarked };
  }

  const [current, ...twins] = rows;
  // Older twins: each superseded by the next newer, so the chain ends at the current row.
  for (let i = 0; i < twins.length; i++) {
    const newer = i === 0 ? current : twins[i - 1];
    const older = twins[i];
    if (newer.supersedes === older.id) continue;
    if (w.dryRun) { w.log(`  ~ ${issue.identifier}: would mark ${older.id} superseded by ${newer.id}`); twinsMarked++; continue; }
    const r = await w.store.updateThought({ id: newer.id, actor: w.actor, provenance: { supersedes: older.id } });
    if (!r.ok) throw new Error(`marking ${older.id} superseded by ${newer.id}: ${r.error}`);
    twinsMarked++;
  }

  const patch = facetPatch(current.metadata ?? {}, facets);
  if (current.content === content) {
    if (!patch) return { outcome: "unchanged", noVector: false, twinsMarked };
    if (w.dryRun) { w.log(`  · ${issue.identifier}: would patch ${Object.keys(patch).join(", ")}`); return { outcome: "patched", noVector: false, twinsMarked }; }
    const r = await w.store.updateThought({ id: current.id, metadataPatch: patch, actor: w.actor });
    if (!r.ok) throw new Error(`patching ${current.id}: ${r.error}`);
    w.log(`  · ${issue.identifier}: facets patched (${Object.keys(patch).join(", ")})`);
    return { outcome: "patched", noVector: false, twinsMarked };
  }

  // The text moved: judged as an edit of THIS row — its own source and tags.
  const g = gate("edit", { ...(current.metadata ?? {}), ...facets });
  if (w.dryRun) { w.log(`  ~ ${issue.identifier}: would update the text (${g.embeddings.allowed ? "re-embedded" : "WITHOUT a vector"})${patch ? ` and patch ${Object.keys(patch).join(", ")}` : ""}`); return { outcome: "updated", noVector: !g.embeddings.allowed, twinsMarked }; }
  const subject: EgressSubject = { kind: "edit", actor: w.actor.name, metadata: { ...(current.metadata ?? {}), ...facets }, content };
  const embedded = g.embeddings.allowed ? await w.embed(content, subject) : undefined;
  const r = await w.store.updateThought({
    id: current.id,
    content,
    metadataPatch: patch ?? undefined,
    embedding: embedded?.embedding,
    chunks: embedded?.chunks,
    actor: actorWith(g.record),
    embeddingModel: embedded?.model,
  });
  if (!r.ok) throw new Error(`updating ${current.id}: ${r.error}`);
  w.log(`  ~ ${issue.identifier}: updated${embedded ? "" : " WITHOUT a vector (egress refused)"}${patch ? ` (${Object.keys(patch).join(", ")})` : ""}`);
  return { outcome: "updated", noVector: !embedded, twinsMarked };
}

/** One pass: census, plan, fetch, write. */
export async function runPass(opts: { gql: Gql; sql: SQL; writer: Writer; initiative: string; full: boolean; only?: string[] }): Promise<PassReport> {
  const { initiative, projects } = await initiativeProjects(opts.gql, opts.initiative);
  const census = await censusOf(opts.gql, projects.map((p) => p.id));
  const groups = groupTicketRows(await readTicketRows(opts.sql));
  const plan = planPass(census, groups, opts.full);
  const wanted = opts.only ? plan.fetch.filter((i) => opts.only!.includes(i)) : plan.fetch;
  const tally: Record<Outcome, number> = { captured: 0, updated: 0, patched: 0, unchanged: 0, refused: 0 };
  const report: PassReport = { initiative, projects: projects.length, census: census.length, plan, tally, twinsMarked: 0, noVector: 0, errors: [] };
  if (wanted.length === 0) return report;
  const issues = await fetchIssues(opts.gql, wanted);
  const seen = new Set(issues.map((i) => i.identifier));
  for (const ident of wanted) if (!seen.has(ident)) report.errors.push({ identifier: ident, error: "listed in the census but not returned in full" });
  for (const issue of issues) {
    try {
      const r = await syncIssue(opts.writer, issue, groups.get(issue.identifier) ?? []);
      tally[r.outcome]++;
      report.twinsMarked += r.twinsMarked;
      if (r.noVector) report.noVector++;
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
    `  ${dryRun ? "would write" : "wrote"}: captured ${r.tally.captured}  updated ${r.tally.updated}  patched ${r.tally.patched}  unchanged ${r.tally.unchanged}${r.twinsMarked ? `  twins marked superseded ${r.twinsMarked}` : ""}${r.noVector ? `  without a vector ${r.noVector}` : ""}`,
  ];
  if (r.errors.length) lines.push(`  errors: ${r.errors.length} — ${r.errors.slice(0, 5).map((e) => `${e.identifier}: ${e.error}`).join("; ")}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Self-check — the pure parts.
// ---------------------------------------------------------------------------

function selfCheck(): Promise<number> {
  let bad = 0;
  const ok = (cond: boolean, label: string) => { if (!cond) { console.error(`FAIL ${label}`); bad++; } };

  const issue: LinearIssue = {
    identifier: "SMD-1936", title: " The SQL-safety guard rail ", description: "## Problem\n\nSee <issue id=\"x\" href=\"https://linear.app/…\">SMD-1730</issue> and SMD-1250.\n",
    url: "https://linear.app/siggymd/issue/SMD-1936/the-sql-safety", createdAt: "2026-09-22T00:00:00.000Z", updatedAt: "2026-09-22T01:00:00.000Z", archivedAt: null,
    priorityLabel: "Low", state: { name: "Backlog", type: "backlog" }, project: { id: "p", name: "Open Brain — Release Engineering & Fork Maintenance" }, parent: null, labels: { nodes: [{ name: "infrastructure" }] },
  };
  const text = renderIssue(issue);
  ok(text === "SMD-1936 — The SQL-safety guard rail\nProject: Open Brain — Release Engineering & Fork Maintenance · Status: Backlog (backlog) · Priority: Low · Parent: none · Labels: infrastructure\nhttps://linear.app/siggymd/issue/SMD-1936/the-sql-safety\n\n## Problem\n\nSee SMD-1730 and SMD-1250.", "renders the hand-capture shape: header, facets, url, blank, body with autolinks stripped");
  ok(HEADER_RE.test(text), "…and the rendered text matches the header grammar");
  const two = renderIssue({ ...issue, labels: { nodes: [{ name: "infrastructure" }, { name: "Improvement" }] }, parent: { identifier: "SMD-1850" }, project: null, description: null });
  ok(two === "SMD-1936 — The SQL-safety guard rail\nProject: none · Status: Backlog (backlog) · Priority: Low · Parent: SMD-1850 · Labels: infrastructure, Improvement\nhttps://linear.app/siggymd/issue/SMD-1936/the-sql-safety", "labels comma-joined, a parent named, no project and no description spelled");
  ok(stripAutolinks("a <issue id=\"1\" href=\"h\">SMD-1</issue> b <issue>SMD-2</issue>") === "a SMD-1 b SMD-2", "every autolink element becomes its identifier");
  ok(stripAutolinks("<issues> keep </issues>") === "<issues> keep </issues>", "…and only that element (a longer tag name is not it)");

  const f = issueFacets(issue);
  ok(f.source === "linear" && f.issue === "SMD-1936" && f.status === "Backlog" && f.status_type === "backlog" && JSON.stringify(f.labels) === '["infrastructure"]' && f.parent === null && f.linear_updated_at === issue.updatedAt && !("archived_at" in f), "facets: source, issue, status, type, labels, parent, updatedAt; archived only when set");
  ok(issueFacets({ ...issue, archivedAt: "2026-10-01T00:00:00.000Z" }).archived_at === "2026-10-01T00:00:00.000Z", "…archived_at when Linear archived it");

  ok(ticketIdentifier({ content: text, metadata: { source: "mcp" } }) === "SMD-1936", "a hand capture is a ticket row by its header");
  ok(ticketIdentifier({ content: "SMD-1903 — DONE 2026-09-22: the egress gate landed\nProject: X · Status: Done\nhttps://linear.app/x", metadata: {} }) === "SMD-1903", "…the three-line header with a status suffices");
  ok(ticketIdentifier({ content: "SMD-1903 — DONE 2026-09-22: the egress gate landed in Open Brain (PR #99).", metadata: {} }) === null, "a note that only opens with an identifier is not a ticket row");
  ok(ticketIdentifier({ content: "anything", metadata: { issue: "SMD-12" } }) === "SMD-12", "an adopted row is a ticket row by its claim, whatever its text");
  ok(ticketIdentifier({ content: "anything", metadata: { issue: "not an id" } }) === null, "…a claim that is not an identifier is ignored");

  const rows: BrainRow[] = [
    { id: "b", content: text, metadata: {}, created_at: "2026-09-22T00:00:00Z", supersedes: null },
    { id: "a", content: text, metadata: {}, created_at: "2026-09-21T00:00:00Z", supersedes: null },
    { id: "c", content: text, metadata: {}, created_at: "2026-09-22T00:00:00Z", supersedes: null },
    { id: "n", content: "SMD-1936 — a note", metadata: {}, created_at: "2026-09-23T00:00:00Z", supersedes: null },
  ];
  const groups = groupTicketRows(rows);
  ok(groups.size === 1 && groups.get("SMD-1936")!.map((r) => r.id).join("") === "bca", "grouped by identifier, newest first, ties by id; the note excluded");

  const census: Census = [{ identifier: "SMD-1936", updatedAt: "2026-09-22T01:00:00.000Z" }, { identifier: "SMD-2000", updatedAt: "2026-09-22T02:00:00.000Z" }];
  const g2 = new Map<string, BrainRow[]>([
    ["SMD-1936", [{ id: "b", content: text, metadata: { linear_updated_at: "2026-09-22T00:30:00.000Z" }, created_at: null, supersedes: null }]],
    ["SMD-9", [{ id: "z", content: "", metadata: { issue: "SMD-9" }, created_at: null, supersedes: null }]],
  ]);
  const plan = planPass(census, g2);
  ok(JSON.stringify(plan) === JSON.stringify({ fetch: ["SMD-1936", "SMD-2000"], missing: ["SMD-2000"], stale: ["SMD-1936"], extra: ["SMD-9"], unchanged: 0 }), `plan: an older linear_updated_at is stale, an absent row is missing, an unlisted row is extra (${JSON.stringify(plan)})`);
  const fresh = planPass(census, new Map([["SMD-1936", [{ id: "b", content: text, metadata: { linear_updated_at: "2026-09-22T01:00:00.000Z" }, created_at: null, supersedes: null }]], ["SMD-2000", [{ id: "d", content: "", metadata: { linear_updated_at: "2026-09-22T02:00:00.000Z" }, created_at: null, supersedes: null }]]]));
  ok(fresh.fetch.length === 0 && fresh.unchanged === 2, "an equal linear_updated_at is unchanged and fetches nothing");
  ok(planPass(census, new Map([["SMD-1936", [{ id: "b", content: text, metadata: {}, created_at: null, supersedes: null }]]])).stale[0] === "SMD-1936", "a hand capture with no linear_updated_at is stale — adopted on first sight");
  ok(planPass(census, g2, true).fetch.length === 2 && planPass([{ identifier: "SMD-1936", updatedAt: "2026-09-22T00:30:00.000Z" }], g2, true).unchanged === 0, "--full fetches the unchanged too");

  const adopt = facetPatch({ source: "mcp", status: "Backlog", labels: [] }, { source: "linear", status: "Backlog", labels: [] });
  ok(adopt !== null && Object.keys(adopt).join() === "source", "the patch names only the facets that differ");
  ok(facetPatch({ source: "linear", parent: null }, { source: "linear", parent: null }) === null, "…and is null when none do (absent and null agree)");

  // The write decisions, against a recording store: which call each state of
  // the brain gets, and which model calls it costs.
  const calls: string[] = [];
  const recorder: Writer = {
    store: {
      captureThought: async (o) => { calls.push(`capture ${JSON.stringify(o.payload.metadata.status)} vec=${o.embedding ? "yes" : "no"} type=${o.payload.metadata.type ?? "-"}`); return { id: "new" }; },
      updateThought: async (o) => { calls.push(`update ${o.id}${o.content !== undefined ? " content" : ""}${o.metadataPatch ? ` patch(${Object.keys(o.metadataPatch).join(",")})` : ""}${o.provenance ? ` supersedes=${o.provenance.supersedes}` : ""}${o.embedding ? " vec" : ""}`); return { ok: true, id: o.id }; },
    },
    cfg: resolveEmbedConfig({ OB1_LLM_LOCAL: "1", OB1_EGRESS_POLICY: "off" }),
    embed: async () => { calls.push("embed"); return { embedding: [1], model: "m", chunks: [] }; },
    tags: async () => { calls.push("tags"); return { type: "task", topics: ["t"], status: "a guess" }; },
    actor: { name: ACTOR_NAME, via: SELF },
    dryRun: false,
    log: () => {},
  };
  const run = async (rows: BrainRow[]) => { calls.length = 0; const r = await syncIssue(recorder, issue, rows); return { r, calls: calls.slice() }; };
  const withFacets = { ...issueFacets(issue) };
  return (async () => {
    let r = await run([]);
    ok(r.r.outcome === "captured" && r.calls.join("; ") === 'embed; tags; capture "Backlog" vec=yes type=task', `a new issue: embed, tags, capture with the facets over the tags (${r.calls.join("; ")})`);
    r = await run([{ id: "cur", content: text, metadata: { source: "mcp", type: "task" }, created_at: "2026-09-22T00:00:00Z", supersedes: null }]);
    // No `parent` in the patch: the row has none and Linear says null, and absent and null agree.
    ok(r.r.outcome === "patched" && r.calls.join("; ") === "update cur patch(source,issue,project,status,status_type,priority,labels,url,linear_updated_at)", `a hand capture with the same text: one facet patch, no model call (${r.calls.join("; ")})`);
    r = await run([{ id: "cur", content: text, metadata: withFacets, created_at: null, supersedes: null }]);
    ok(r.r.outcome === "unchanged" && r.calls.length === 0, "same text and facets: nothing written, nothing called");
    r = await run([{ id: "cur", content: text.replace("Status: Backlog (backlog)", "Status: Done (completed)"), metadata: { ...withFacets, status: "Done", status_type: "completed" }, created_at: null, supersedes: null }]);
    ok(r.r.outcome === "updated" && r.calls.join("; ") === "embed; update cur content patch(status,status_type) vec", `moved text: one embed, one edit with the vector and the facets that moved (${r.calls.join("; ")})`);
    r = await run([
      { id: "c", content: text, metadata: withFacets, created_at: "2026-09-23T00:00:00Z", supersedes: null },
      { id: "b", content: text, metadata: {}, created_at: "2026-09-22T00:00:00Z", supersedes: "a" },
      { id: "a", content: text, metadata: {}, created_at: "2026-09-21T00:00:00Z", supersedes: null },
    ]);
    ok(r.r.twinsMarked === 1 && r.calls.join("; ") === "update c supersedes=b", `twins: only the missing pointer is set (c→b; b→a already stands), the current row untouched (${r.calls.join("; ")})`);
    const refusing: Writer = { ...recorder, cfg: resolveEmbedConfig({ OB1_LLM_BASE_URL: "https://api.example.com/v1", OB1_LLM_API_KEY: "k", OB1_EGRESS_POLICY: "deny" }) };
    calls.length = 0;
    const refused = await syncIssue(refusing, issue, []);
    ok(refused.noVector && calls.join("; ") === 'capture "Backlog" vec=no type=-', `under deny to a hosted endpoint: no embed, no tags, the row lands bare (${calls.join("; ")})`);
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
  const TAKES_NONE = new Set(["dry-run", "loop", "audit", "full", "self-check", "quiet"]);
  const USAGE = "  flags: --url <postgres://…>, --initiative <name>, --interval <seconds>, --only <SMD-1,SMD-2>, --dry-run, --loop, --audit, --full, --quiet, --self-check";
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

  const envSources = loadEnv();
  const key = process.env.LINEAR_API_KEY?.trim();
  if (!key) {
    console.error(`LINEAR_API_KEY is not set, and no .env file supplied it. Create a personal API key at https://linear.app/settings/api and put it in a .env (gitignored; see evals/.env.example).\n  Read: ${describeEnv(envSources)}`);
    process.exit(2);
  }
  const url = values.get("url") ?? process.env.DATABASE_URL;
  if (!url) { console.error("No database URL. Pass --url or set DATABASE_URL."); process.exit(2); }
  const initiative = (values.get("initiative") ?? process.env.OB1_LINEAR_INITIATIVE)?.trim() || DEFAULT_INITIATIVE;
  const intervalRaw = (values.get("interval") ?? process.env.OB1_BOARD_SYNC_INTERVAL)?.trim();
  const interval = intervalRaw ? Number(intervalRaw) : DEFAULT_INTERVAL_S;
  if (!Number.isInteger(interval) || interval < 10) { console.error(`--interval / OB1_BOARD_SYNC_INTERVAL must be a whole number of seconds, at least 10 (got "${intervalRaw}").`); process.exit(2); }
  const dryRun = flags.has("dry-run");
  const quiet = flags.has("quiet");
  const only = values.get("only")?.split(",").map((s) => s.trim()).filter(Boolean);

  const gql = linearClient(key);
  const sql = new SQL({ url, max: 2 });
  const store = new SqlStore(url, { max: 2 });
  // Resolved once, as db/reembed.ts does; the embedder does not remember a
  // refusal across rows (each row's length is its own).
  const cfg = resolveEmbedConfig(process.env as EmbedEnv);
  const embedder = createEmbedder(() => cfg, { rememberRefusal: false });
  const session = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
  const writer: Writer = {
    store,
    cfg,
    embed: (content, subject) => embedder.embedCapture(content, subject),
    tags: (content, subject) => extractMetadata(content, subject, cfg),
    actor: { name: ACTOR_NAME, via: SELF, session },
    dryRun,
    log: quiet ? () => {} : (line) => console.log(line),
  };

  const once = async (): Promise<number> => {
    const t0 = Date.now();
    if (flags.has("audit")) {
      const { initiative: name, projects } = await initiativeProjects(gql, initiative);
      const census = await censusOf(gql, projects.map((p) => p.id));
      const plan = planPass(census, groupTicketRows(await readTicketRows(sql)));
      console.log(`  board: ${name} — ${projects.length} project(s), ${census.length} issue(s)`);
      console.log(`  missing ${plan.missing.length}${plan.missing.length ? ` (${plan.missing.join(", ")})` : ""}`);
      console.log(`  stale   ${plan.stale.length}${plan.stale.length ? ` (${plan.stale.slice(0, 20).join(", ")}${plan.stale.length > 20 ? ", …" : ""})` : ""}`);
      console.log(`  extra   ${plan.extra.length}${plan.extra.length ? ` (${plan.extra.join(", ")})` : ""}`);
      console.log(`  in lockstep: ${plan.missing.length === 0 && plan.stale.length === 0 ? "yes" : "NO"}  (${Date.now() - t0} ms)`);
      return plan.missing.length || plan.stale.length ? 1 : 0;
    }
    const report = await runPass({ gql, sql, writer, initiative, full: flags.has("full"), only });
    console.log(formatReport(report, dryRun));
    console.log(`  ${dryRun ? "dry run — nothing written" : "done"} (${Date.now() - t0} ms)`);
    return report.errors.length ? 1 : 0;
  };

  let code = 0;
  try {
    if (!flags.has("loop")) { code = await once(); return; }
    console.log(`  ${SELF}: a pass every ${interval} s against ${initiative}${dryRun ? " (dry run)" : ""}; SIGTERM/SIGINT ends the loop after the current pass`);
    let stopping = false;
    const stop = () => { stopping = true; };
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
    while (!stopping) {
      console.log(`▸ ${new Date().toISOString()}`);
      try { await once(); } catch (e) { console.error(`  pass failed: ${(e as Error).message}`); }
      for (let waited = 0; waited < interval && !stopping; waited++) await Bun.sleep(1000);
    }
  } finally {
    await sql.close();
    process.exitCode = code;
  }
}

if (import.meta.main) await main();
