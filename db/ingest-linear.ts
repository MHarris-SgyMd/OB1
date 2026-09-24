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

import { AdapterRefusal, IDENTITY_MAX, normaliseLinks, normaliseMentions, stableJson, type Adapter, type Derived, type Ingested, type Link, type Mention } from "./ingest-contract.ts";

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

// ---------------------------------------------------------------------------
// Dated sections → derived observations (SMD-2059; SMD-1951's finding)
// ---------------------------------------------------------------------------

/** A level-2 heading that carries an ISO date anywhere in it: `## Update 2026-09-19 (board audit)`, `## Corrected 2026-09-22 — …`, `## Upstream survey, 2026-09-11`, `## Update 2026-09-19T10:00` (the date part; digits may not run on). Whether the date EXISTS is `isCalendarDate`'s question. */
const DATED_HEADING_RE = /^## (.*\b(\d{4}-\d{2}-\d{2})(?!\d).*)$/;
/** Where a section ends: the next heading of level one or two (a `###` inside it belongs to it). */
const SECTION_END_RE = /^#{1,2} /;
/** A fenced code block's edge; inside one a `## ` or `# ` line is code, not a heading (first review pass, independent read: a bash comment ended a section, a quoted heading opened one). */
const FENCE_RE = /^(```|~~~)/;

/** `2026-09-31` and `2026-13-45` match the shape and are not dates; written as `created_at` they would abort the ingester's run at the cast (first review pass, independent read). */
export function isCalendarDate(s: string): boolean {
  const [y, m, d] = s.split("-").map(Number);
  const t = Date.UTC(y, m - 1, d);
  return new Date(t).toISOString().slice(0, 10) === s;
}
/** A Markdown link, to its label — the brain's rows show Linear hands some cross-references this way, others as autolink elements. */
const MD_LINK_RE = /\[([^\]]*)\]\([^)]*\)/g;
/** The slug's length bound: with the identifier and `#` it stays well inside IDENTITY_MAX. */
export const SECTION_SLUG_MAX = 80;
export const SECTION_MEDIA_TYPE = "text/markdown";

/** One dated section of a description: the heading (markup stripped), its date, the raw Markdown from the heading line to the section's end, and the body under the heading. */
export type IssueSection = { heading: string; date: string; raw: string; body: string; slug: string };

/** Markup out of a heading or a body: autolink elements and Markdown links to their text. */
function plainText(s: string): string {
  return stripAutolinks(s).replace(MD_LINK_RE, "$1");
}

/** A heading as an identity part: lower case, words joined by `-`, bounded. */
export function sectionSlug(heading: string): string {
  return plainText(heading).toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, SECTION_SLUG_MAX).replace(/-+$/, "");
}

/**
 * The dated sections of a description, in order. Deterministic: headings only —
 * a bold `**Corrected …**` paragraph is prose and stays in the ticket; a `## `
 * line inside a fenced code block is code. Two sections of one slug in one
 * description are told apart by a counter in order of appearance (so deleting
 * the first renames the second — a renamed heading is a new part, the old
 * row stays). A heading whose date does not exist is not a dated heading.
 * Lines are split on LF or CRLF; a CRLF description's raw is re-joined with LF.
 */
export function issueSections(issue: LinearIssue): IssueSection[] {
  const lines = (issue.description ?? "").split(/\r?\n/);
  const out: IssueSection[] = [];
  const slugs = new Map<string, number>();
  let fenced = false;
  for (let i = 0; i < lines.length; i++) {
    if (FENCE_RE.test(lines[i])) { fenced = !fenced; continue; }
    if (fenced) continue;
    const m = DATED_HEADING_RE.exec(lines[i]);
    if (!m || !isCalendarDate(m[2])) continue;
    let j = i + 1;
    let inner = false;
    while (j < lines.length) {
      if (FENCE_RE.test(lines[j])) inner = !inner;
      else if (!inner && SECTION_END_RE.test(lines[j])) break;
      j++;
    }
    const raw = lines.slice(i, j).join("\n").replace(/\s+$/, "");
    const body = lines.slice(i + 1, j).join("\n").trim();
    const base = sectionSlug(m[1]) || `section-${m[2]}`;
    const n = (slugs.get(base) ?? 0) + 1;
    slugs.set(base, n);
    out.push({ heading: plainText(m[1]).trim(), date: m[2], raw, body, slug: n === 1 ? base : `${base}-${n}` });
    i = j - 1;
  }
  return out;
}

/** The identity of a section within the linear system: the ticket's identifier, `#`, the slug. */
export function sectionKey(identifier: string, slug: string): string {
  return `${identifier}#${slug}`;
}

/**
 * Each dated section as a thought of its own: an `observation` dated by the
 * heading, `child_of` the ticket, its cross-references as `references`, the
 * section's Markdown as its canonical, its text the ticket's identifier and
 * title, the heading, then the body with markup stripped. The facet that
 * names the ticket is `ticket`, NOT `issue`: `issue` is the board sync's claim
 * on a ticket ROW, and a derived row carrying it would join the ticket's twin
 * group and be chained as an older paste of the ticket. Two sections whose
 * text comes out identical yield ONE part (the first): a second row could
 * not hold the same text (003's fingerprint), and the sync would re-key one
 * row between the two identities every pass (first review pass, independent
 * read).
 */
export function derivedSections(issue: LinearIssue): Derived[] {
  const out: Derived[] = [];
  const texts = new Set<string>();
  for (const s of issueSections(issue)) {
    const key = sectionKey(issue.identifier, s.slug);
    if (key.length > IDENTITY_MAX) continue; // unreachable with the slug bound; the contract's limit stated where it would bite
    const body = plainText(s.body).trim();
    const text = `${issue.identifier} — ${issue.title.trim()} · ${s.heading}${body ? `\n\n${body}` : ""}`;
    if (texts.has(text)) continue;
    texts.add(text);
    const links: Link[] = [{ relation: "child_of", target: issue.identifier }, ...autolinkTargets(s.body).map((target) => ({ relation: "references" as const, target }))];
    out.push({
      identity: { system: LINEAR_SYSTEM, key },
      canonical: { form: s.raw, mediaType: SECTION_MEDIA_TYPE },
      text,
      links: normaliseLinks(links, key).links,
      mentions: [],
      facets: { ticket: issue.identifier, section: s.heading, observed_at: s.date, type: "observation", url: issue.url, [WATERMARK_KEY]: issue.updatedAt },
      createdAt: `${s.date}T00:00:00.000Z`,
    });
  }
  return out;
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
      derived: derivedSections(issue),
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
  let topLevel = ISSUE_FIELDS.replace(/\([^)]*\)/g, "");
  while (/\{/.test(topLevel)) { // innermost braces out first, however deep the selection nests
    const next = topLevel.replace(/\{[^{}]*\}/g, "");
    if (next === topLevel) { ok(false, "ISSUE_FIELDS has unbalanced braces"); break; } // a failure, not a hang (second review pass)
    topLevel = next;
  }
  const selected = new Set(topLevel.split(/\s+/).filter((t) => /^\w+$/.test(t)));
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

  // Dated sections → derived observations (SMD-2059).
  ok(out.derived !== undefined && out.derived.length === 0, "an issue with no dated section derives nothing");
  const sectioned: LinearIssue = {
    ...issue, identifier: "SMD-1951",
    description: "## Problem\n\nThe plan.\n\n## Update 2026-09-19 (board audit)\n\nStill open; see <issue id=\"a\" href=\"h\">SMD-1949</issue> and [SMD-1809](https://linear.app/x/SMD-1809).\n\n### Detail\n\nA sub-heading belongs to the section.\n\n## Notes\n\nUndated, stays.\n\n## Corrected 2026-09-22 — the spikes are hypotheses\n\nRelabelled.\n\n## Update 2026-09-19 (board audit)\n\nA second update the same day.",
  };
  const sections = issueSections(sectioned);
  ok(sections.length === 3 && sections.map((s) => s.slug).join(" ") === "update-2026-09-19-board-audit corrected-2026-09-22-the-spikes-are-hypotheses update-2026-09-19-board-audit-2", `three dated sections, slugged, the repeated heading counted (${sections.map((s) => s.slug).join(" ")})`);
  ok(sections[0].date === "2026-09-19" && sections[0].heading === "Update 2026-09-19 (board audit)" && /### Detail/.test(sections[0].raw) && /A sub-heading belongs/.test(sections[0].body) && !/## Notes/.test(sections[0].raw), "a section runs to the next level-1 or level-2 heading; a ### inside it belongs to it; the raw keeps the heading line");
  ok(/<issue id=/.test(sections[0].raw) && !/<issue/.test(sections[0].heading), "the raw keeps the markup, the heading is stripped");
  const d = derivedSections(sectioned);
  ok(d.length === 3 && d[0].identity.key === "SMD-1951#update-2026-09-19-board-audit" && d[2].identity.key === "SMD-1951#update-2026-09-19-board-audit-2", `each section is an identity of its own under the ticket (${d.map((x) => x.identity.key).join(" ")})`);
  ok(d[0].text === "SMD-1951 — The SQL-safety guard rail · Update 2026-09-19 (board audit)\n\nStill open; see SMD-1949 and SMD-1809.\n\n### Detail\n\nA sub-heading belongs to the section.", `the text is the ticket's identifier and trimmed title, the heading, the body with autolinks and Markdown links flattened (${JSON.stringify(d[0].text.split("\n")[0])})`);
  ok(d[0].canonical.form === sections[0].raw && d[0].canonical.mediaType === SECTION_MEDIA_TYPE, "the canonical is the section's Markdown as written");
  ok(JSON.stringify(d[0].links) === JSON.stringify([{ relation: "child_of", target: "SMD-1951" }, { relation: "references", target: "SMD-1949" }]), `child_of the ticket and references for the autolinks — a Markdown link is prose, not a structured cross-reference (${JSON.stringify(d[0].links)})`);
  ok(d[0].facets.type === "observation" && d[0].facets.ticket === "SMD-1951" && d[0].facets.issue === undefined && d[0].facets.observed_at === "2026-09-19" && d[0].facets[WATERMARK_KEY] === issue.updatedAt && d[0].createdAt === "2026-09-19T00:00:00.000Z", "an observation dated by the heading, naming the ticket under `ticket` (never `issue`, the sync's row claim), carrying the parent's watermark");
  ok(d.every((x) => x.mentions.length === 0), "a section names no entities of its own — the ticket's project and labels are the ticket's");
  ok(derivedSections({ ...sectioned, description: "## Update (2026-09-19): measured\n\nx\n\n**Corrected 2026-09-22** in prose." }).length === 1, "a date in parentheses counts; a bold paragraph is prose and is not split");
  ok(derivedSections({ ...sectioned, description: "## Update 2026-09-19\n## Update 2026-09-20" })[0].text.endsWith("· Update 2026-09-19") && derivedSections({ ...sectioned, description: "## Update 2026-09-19\n## Update 2026-09-20" }).length === 2, "a section with no body is its heading alone; back-to-back headings are two sections");
  ok(sectionSlug("Update 2026-09-19 — what [SMD-1879](https://linear.app/x) found: Ärger!") === "update-2026-09-19-what-smd-1879-found-a-rger", `a slug is lower-case words, Markdown links to their label, non-ASCII folded (${sectionSlug("Update 2026-09-19 — what [SMD-1879](https://linear.app/x) found: Ärger!")})`);
  ok(sectionSlug("x".repeat(200)).length === SECTION_SLUG_MAX, "a slug is bounded");
  // First review pass (independent read): fences, impossible dates, CRLF, same-text sections.
  const fenced = issueSections({ ...sectioned, description: "## Update 2026-09-19\n\n```bash\n# run this\n## not a heading\nbun x.ts\n```\n\nAfter.\n\n## Notes\n\n```md\n## Update 2026-09-20\n```\n\nx" });
  ok(fenced.length === 1 && /After\./.test(fenced[0].body) && /```bash\n# run this/.test(fenced[0].raw) && !/## Notes/.test(fenced[0].raw), `a \`# \` or \`## \` line inside a fenced code block is code: it neither ends a section nor opens one (${fenced.length} section(s), body ends "${fenced[0]?.body.slice(-6)}")`);
  ok(issueSections({ ...sectioned, description: "## Update 2026-13-45\n\nx\n\n## Update 2026-09-31\n\ny\n\n## Update 2026-02-29\n\nz" }).length === 0 && isCalendarDate("2024-02-29") && !isCalendarDate("2026-02-29"), "a heading whose date does not exist is not a dated heading — it would abort the ingester's run at the timestamp cast");
  ok(issueSections({ ...sectioned, description: "## Update 2026-09-19 (a)\r\n\r\nx\r\n" }).length === 1 && issueSections({ ...sectioned, description: "## Update 2026-09-19T10:00 measured\n\nx" })[0]?.date === "2026-09-19" && issueSections({ ...sectioned, description: "## Build 2026-09-1999\n\nx" }).length === 0, "CRLF lines are read; an ISO timestamp's date part counts; digits running on do not");
  const twins = derivedSections({ ...sectioned, description: "## Update 2026-09-19\n\nDone.\n\n## Update 2026-09-19\n\nDone." });
  ok(twins.length === 1 && twins[0].identity.key === "SMD-1951#update-2026-09-19", "two sections whose text comes out identical yield one part — a second row could not hold the text, and the sync would re-key one row between two identities every pass");

  if (bad === 0) console.log("ingest-linear.ts self-check PASS");
  return bad === 0 ? 0 : 1;
}

if (import.meta.main) {
  if (process.argv.includes("--self-check")) process.exit(selfCheck());
  console.error("ingest-linear.ts is a library — the Linear adapter for db/ingest-records.ts and db/sync-linear.ts. `--self-check` runs its pure rules.");
  process.exit(2);
}
