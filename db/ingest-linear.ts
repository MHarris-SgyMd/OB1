/**
 * ingest-linear.ts — the Linear adapter: the reference implementation of the
 * ingestion contract (SMD-1867; SMD-1865 is the defect it answers).
 *
 * One issue → one thought. The text is the shape the hand captures and the
 * board sync (SMD-1954) write — header, facet line, URL, blank, the description
 * with Linear's autolink markup stripped — so the sync and the ingester render
 * a ticket ONE way (SMD-1958's ask, met here: `renderIssue` moved from
 * db/sync-linear.ts, which re-exports it). The structure Linear already knows
 * becomes edges with no model call:
 *
 *   `<issue …>SMD-x</issue>` in the description  →  references SMD-x
 *   parent                                       →  child_of <parent>
 *   relations  (this issue holds the relation)   →  blocks / relates_to / duplicate_of
 *   inverseRelations (another issue holds it)    →  blocked_by / relates_to
 *   project, labels                              →  mentions (project, topic), extraction_key source:linear
 *
 * Not taken: `similar` relations (Linear's own suggestion, not a statement),
 * the inverse of `duplicate` (the other issue is the duplicate; the link is
 * its), `references` to the issue itself. The canonical is the issue as the
 * API gave it, as JSON with keys in one order (stableJson) — what a two-way
 * connector (SMD-1817) would write back from; the description's markup is
 * intact there.
 *
 * Every function here is pure; `--self-check` runs them with no network.
 */

import { AdapterRefusal, normaliseLinks, normaliseMentions, stableJson, type Adapter, type Ingested, type Link, type Mention } from "./ingest-contract.ts";

export const LINEAR_SYSTEM = "linear";
export const LINEAR_MEDIA_TYPE = "application/vnd.linear.issue+json";

/** An issue as the sync's GraphQL query returns it. `relations` / `inverseRelations` arrive from db/sync-linear.ts's fetch; a dump without them yields no relation links. */
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
  /** Relations this issue holds: `type` is blocks | duplicate | related | similar; `relatedIssue` is the other end. */
  relations?: { nodes: { type: string; relatedIssue: { identifier: string } | null }[] };
  /** Relations another issue holds toward this one: `issue` is the holder. */
  inverseRelations?: { nodes: { type: string; issue: { identifier: string } | null }[] };
};

/** The identifier grammar Linear uses (a team key of one letter or more, a dash, a number) — one spelling, shared with the sync's header grammar. */
export const IDENTIFIER_PATTERN = "[A-Z][A-Z0-9]*-[0-9]+";

/** Labels per issue, per request — the census (db/sync-linear.ts) bounds them the same, or an issue with more would read as moved every pass. */
export const LABELS_BOUND = 20;
/** Relations an issue holds, and those held toward it, per request; a ticket with more is rare and its links beyond the bound wait for the day the bound is raised. */
export const RELATIONS_BOUND = 25;
/**
 * The GraphQL selection that yields a `LinearIssue` — what the adapter maps,
 * so the adapter names it, and every fetcher (the sync's full fetch, the
 * corpus builder) asks for the same shape and the two write one text
 * (SMD-1958). The self-check holds it to the type: every key of a LinearIssue
 * is selected.
 */
export const ISSUE_FIELDS = `identifier title description url createdAt updatedAt archivedAt priorityLabel state { name type } project { id name } parent { identifier } labels(first: ${LABELS_BOUND}) { nodes { name } } relations(first: ${RELATIONS_BOUND}) { nodes { type relatedIssue { identifier } } } inverseRelations(first: ${RELATIONS_BOUND}) { nodes { type issue { identifier } } }`;
/** The facet that is the issue's clock — the sync's watermark, and the pipeline's rule against an older record (ingest-contract.ts `watermark`). */
export const WATERMARK_KEY = "linear_updated_at";

/**
 * Linear's autolink markup, `<issue id="…" href="…">SMD-1234</issue>`, to the
 * identifier it wraps — ~80 bytes of URL boilerplate per cross-reference that
 * bloated every embedding and tripped the extractor (SMD-1865). Only that
 * element: the description is otherwise Markdown, which is kept.
 */
export function stripAutolinks(text: string): string {
  return text.replace(/<issue\b[^>]*>([^<]*)<\/issue>/g, "$1");
}

/** The identifiers the autolink elements name, in order of appearance, each once. */
export function autolinkTargets(text: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<issue\\b[^>]*>\\s*(${IDENTIFIER_PATTERN})\\s*<\\/issue>`, "g");
  for (const m of text.matchAll(re)) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}

/**
 * The facets Linear knows about an issue — what `metadata` carries beside the
 * extracted tags. Every key is always present (`archived_at` null when the
 * issue is live), so a facet that goes away is patched away too: an issue
 * archived then restored would otherwise keep `archived_at` forever, since the
 * patch compares the keys the new facets name (SMD-1954, second review pass).
 */
export function issueFacets(issue: LinearIssue): Record<string, unknown> {
  return {
    source: LINEAR_SYSTEM,
    issue: issue.identifier,
    project: issue.project?.name ?? null,
    status: issue.state.name,
    status_type: issue.state.type,
    priority: issue.priorityLabel,
    labels: labelNames(issue),
    parent: issue.parent?.identifier ?? null,
    url: issue.url,
    linear_updated_at: issue.updatedAt,
    archived_at: issue.archivedAt ?? null,
  };
}

/**
 * The label names in one order. Linear's `labels` connection promises none, and
 * an order that differed between two requests would re-render the text and
 * re-embed the row every pass (SMD-1954, third review pass).
 */
export function labelNames(issue: LinearIssue): string[] {
  return issue.labels.nodes.map((l) => l.name).sort((a, b) => a.localeCompare(b, "en"));
}

/**
 * The thought's text: the shape the hand captures used, exactly, so the first
 * pass over a hand-built brain rewrites the tickets that changed and not every
 * one of them. Header line, facet line, URL, blank, the description with
 * autolinks stripped. `Labels: none` and `Parent: none` are spelled, as the hand
 * did; the project too, for an issue that has none.
 */
export function renderIssue(issue: LinearIssue): string {
  const labels = labelNames(issue);
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

/** Linear's relation types to the contract's, from the holder's side and from the other side. */
const RELATION_HELD: Record<string, Link["relation"] | undefined> = { blocks: "blocks", related: "relates_to", duplicate: "duplicate_of" };
const RELATION_INVERSE: Record<string, Link["relation"] | undefined> = { blocks: "blocked_by", related: "relates_to" };

/** The links an issue's structured layer states — every cross-reference, the parent, the relations — normalised (one per pair, sorted, none to itself). */
export function issueLinks(issue: LinearIssue): Link[] {
  const links: Link[] = autolinkTargets(issue.description ?? "").map((target) => ({ relation: "references", target }));
  if (issue.parent) links.push({ relation: "child_of", target: issue.parent.identifier });
  for (const r of issue.relations?.nodes ?? []) {
    const relation = RELATION_HELD[r.type];
    if (relation && r.relatedIssue) links.push({ relation, target: r.relatedIssue.identifier });
  }
  for (const r of issue.inverseRelations?.nodes ?? []) {
    const relation = RELATION_INVERSE[r.type];
    if (relation && r.issue) links.push({ relation, target: r.issue.identifier });
  }
  return normaliseLinks(links, issue.identifier).links;
}

/** The entities the issue's structured layer names: its project, its labels. */
export function issueMentions(issue: LinearIssue): Mention[] {
  const mentions: Mention[] = issue.labels.nodes.map((l) => ({ name: l.name, type: "topic" as const }));
  if (issue.project) mentions.push({ name: issue.project.name, type: "project" });
  return normaliseMentions(mentions);
}

/** The scope the allowlist clears: the project, or the words for an issue without one. */
export function issueScope(issue: LinearIssue): string {
  return issue.project?.name ?? "linear:no-project";
}

/** The adapter. */
export const linearAdapter: Adapter<LinearIssue> = {
  system: LINEAR_SYSTEM,
  map(issue: LinearIssue): Ingested {
    if (!new RegExp(`^${IDENTIFIER_PATTERN}$`).test(issue.identifier)) {
      throw new AdapterRefusal({ system: LINEAR_SYSTEM, key: issue.identifier }, "the identifier is not one Linear issues");
    }
    return {
      identity: { system: LINEAR_SYSTEM, key: issue.identifier },
      scope: issueScope(issue),
      canonical: { form: stableJson(issue), mediaType: LINEAR_MEDIA_TYPE },
      text: renderIssue(issue),
      links: issueLinks(issue),
      mentions: issueMentions(issue),
      facets: issueFacets(issue),
      createdAt: issue.createdAt,
      watermark: { key: WATERMARK_KEY, value: issue.updatedAt },
    };
  },
};

// ---------------------------------------------------------------------------
// Self-check — the pure rules, no network, no database.
// ---------------------------------------------------------------------------

/** The issue the self-check and db/sync-linear.ts's self-check share. */
export const SAMPLE_ISSUE: LinearIssue = {
  identifier: "SMD-1936", title: " The SQL-safety guard rail ", description: "## Problem\n\nSee <issue id=\"x\" href=\"https://linear.app/…\">SMD-1730</issue> and SMD-1250, then <issue id=\"y\" href=\"h\">SMD-1730</issue> again.\n",
  url: "https://linear.app/siggymd/issue/SMD-1936/the-sql-safety", createdAt: "2026-09-21T00:00:00.000Z", updatedAt: "2026-09-22T01:00:00.000Z", archivedAt: null,
  priorityLabel: "Low", state: { name: "Backlog", type: "backlog" }, project: { id: "p1", name: "Open Brain — Release Engineering & Fork Maintenance" }, parent: null,
  labels: { nodes: [{ name: "infrastructure" }] },
};

export function selfCheck(): number {
  let bad = 0;
  const ok = (cond: boolean, label: string) => { if (!cond) { console.error(`FAIL ${label}`); bad++; } };

  const issue = SAMPLE_ISSUE;
  const out = linearAdapter.map(issue);
  ok(out.identity.system === "linear" && out.identity.key === "SMD-1936", "identity is the system and the identifier");
  ok(out.scope === issue.project!.name, "the scope is the project");
  ok(!/<issue/.test(out.text) && /See SMD-1730 and SMD-1250, then SMD-1730 again\./.test(out.text), "the text carries zero autolink markup and every identifier");
  ok(out.text === renderIssue(issue), "the text is the one renderer's");
  ok(/<issue id=/.test(out.canonical.form) && out.canonical.form === stableJson(issue) && JSON.parse(out.canonical.form).description === issue.description, "the canonical keeps the markup — the description as Linear held it, byte for byte inside stable JSON");
  ok(stableJson({ b: 1, a: { d: 2, c: [ { f: 1, e: 2 } ] } }) === '{"a":{"c":[{"e":2,"f":1}],"d":2},"b":1}', "stableJson orders keys at every depth");
  ok(JSON.stringify(out.links) === JSON.stringify([{ relation: "references", target: "SMD-1730" }]), `two autolinks to one issue are one references link, a bare identifier in prose is none (${JSON.stringify(out.links)})`);
  ok(JSON.stringify(out.mentions) === JSON.stringify([{ name: issue.project!.name, type: "project" }, { name: "infrastructure", type: "topic" }]), `the project and the labels are mentions (${JSON.stringify(out.mentions)})`);
  ok(out.facets.source === "linear" && out.facets.issue === "SMD-1936" && out.createdAt === issue.createdAt, "facets and createdAt carried");
  ok(out.watermark?.key === WATERMARK_KEY && out.watermark.value === issue.updatedAt && out.facets[WATERMARK_KEY] === issue.updatedAt, "the watermark is the issue's updatedAt, under the facet key the sync's plan reads (SMD-1958)");
  // The selection the fetchers share names every key of the type — a key added
  // to LinearIssue and not to ISSUE_FIELDS would arrive undefined from every
  // fetcher and render as its absence (SMD-1958).
  const selected = new Set(ISSUE_FIELDS.replace(/\{[^{}]*(\{[^{}]*\}[^{}]*)*\}/g, "").replace(/\([^)]*\)/g, "").split(/\s+/).filter(Boolean));
  const keys = Object.keys({ ...SAMPLE_ISSUE, relations: undefined, inverseRelations: undefined });
  ok(keys.every((k) => selected.has(k)) && selected.has("relations") && selected.has("inverseRelations"), `ISSUE_FIELDS selects every key of a LinearIssue (${keys.filter((k) => !selected.has(k)).join(",") || "none missing"})`);

  const rich: LinearIssue = {
    ...issue, identifier: "SMD-1867", description: "x <issue id=\"a\" href=\"h\">SMD-1865</issue> <issue id=\"s\" href=\"h\">SMD-1867</issue>",
    parent: { identifier: "SMD-949" },
    relations: { nodes: [{ type: "blocks", relatedIssue: { identifier: "SMD-1814" } }, { type: "related", relatedIssue: { identifier: "SMD-1865" } }, { type: "duplicate", relatedIssue: { identifier: "SMD-1" } }, { type: "similar", relatedIssue: { identifier: "SMD-2" } }, { type: "blocks", relatedIssue: null }] },
    inverseRelations: { nodes: [{ type: "blocks", issue: { identifier: "SMD-1813" } }, { type: "related", issue: { identifier: "SMD-1958" } }, { type: "duplicate", issue: { identifier: "SMD-3" } }] },
  };
  const links = issueLinks(rich);
  ok(JSON.stringify(links) === JSON.stringify([
    { relation: "blocked_by", target: "SMD-1813" },
    { relation: "blocks", target: "SMD-1814" },
    { relation: "child_of", target: "SMD-949" },
    { relation: "duplicate_of", target: "SMD-1" },
    { relation: "references", target: "SMD-1865" },
    { relation: "relates_to", target: "SMD-1865" },
    { relation: "relates_to", target: "SMD-1958" },
  ]), `parent, held and inverse relations, references — sorted, no similar, no inverse duplicate, no self-link, no null end (${JSON.stringify(links)})`);
  ok(issueLinks(issue).length === 1 && issueLinks({ ...issue, description: null, parent: null }).length === 0, "an issue with no structure yields no links");
  ok(autolinkTargets("<issue id=\"1\">SMD-1</issue> <issues>SMD-9</issues> <issue>lowercase-1</issue>").join(",") === "SMD-1", "only the autolink element, only identifiers");
  ok(stripAutolinks("a <issue id=\"1\" href=\"h\">SMD-1</issue> b <issue>SMD-2</issue>") === "a SMD-1 b SMD-2", "every autolink element becomes its identifier");
  ok(stripAutolinks("<issues> keep </issues>") === "<issues> keep </issues>", "…and only that element (a longer tag name is not it)");
  ok(issueScope({ ...issue, project: null }) === "linear:no-project", "an issue without a project has a scope of its own to clear");
  let refused = "";
  try { linearAdapter.map({ ...issue, identifier: "not an id" }); } catch (e) { refused = (e as Error).name; }
  ok(refused === "AdapterRefusal", "an identifier outside Linear's grammar is refused, not stored");
  ok(JSON.stringify(issueMentions({ ...issue, labels: { nodes: [{ name: "b" }, { name: "a" }, { name: " a " }] } }).map((m) => m.name)) === JSON.stringify([issue.project!.name, "a", "b"]), "mentions are one per name, trimmed, in one order");

  if (bad === 0) console.log("ingest-linear.ts self-check PASS");
  return bad === 0 ? 0 : 1;
}

if (import.meta.main) {
  if (process.argv.includes("--self-check")) process.exit(selfCheck());
  console.error("ingest-linear.ts is a library — the Linear adapter for db/ingest-records.ts and db/sync-linear.ts. `--self-check` runs its pure rules.");
  process.exit(2);
}
