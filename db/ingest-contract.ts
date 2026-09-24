/**
 * ingest-contract.ts — what every capture source maps to (SMD-1867).
 *
 * Every wiki-like source carries two things beside its text: presentation
 * markup, which is noise for retrieval, and structure — links, parents,
 * memberships, labels — which the source knows with full precision and which
 * 016's extractor would otherwise re-infer from prose, imperfectly and at a
 * model call per thought (SMD-1865 found it on Linear; SMD-949's connectors
 * would each have re-solved it). This file is the one contract an adapter
 * implements: a pure function from one source item to the five things below.
 * The pipeline (db/ingest-records.ts) owns what is common — the row, the
 * fingerprint, the canonical store, the idempotent edge write, the
 * structured-vs-extracted resolution rule (migration 053), the actor envelope
 * — so an adapter is a reader, never a writer.
 *
 * The round-trip rule, load-bearing: the CANONICAL is the stored truth and the
 * text and the edges are derived from it, never the other way. A read/retrieve
 * corpus could strip and store; a two-way connector cannot — a page written
 * back to Obsidian or Notion from a cleaned text is a shredded page. So an
 * adapter keeps the source form byte for byte, and `roundTrips` is the test
 * every adapter passes: export(canonical) === input.
 *
 * The PHI allowlist (SMD-1813) is a precondition at this boundary: content
 * pulled in is stored un-isolated, embedded and sent to a model provider.
 * Every item names its `scope` (a Linear project, a vault root) and the
 * pipeline ingests only scopes the operator cleared — by configuration, not by
 * a README — defaulting to nothing; the refusal is visible.
 */

import { ENTITY_TYPES, type EntityType } from "../server-portable/entities.ts";

/** The relations a source's structured layer may state between two of its items — 053's `link` facet admits exactly these. */
export const LINK_RELATIONS = ["references", "child_of", "blocks", "blocked_by", "relates_to", "duplicate_of"] as const;
export type LinkRelation = (typeof LINK_RELATIONS)[number];

/** A source system's name: one lower-case word, as thought_sources.system and a link's `system` spell it. */
export const SYSTEM_RE = /^[a-z][a-z0-9_-]*$/;

/** The identity of an item within a system — what survives a rename or a move on the source side (SMD-1813). */
export type Identity = { system: string; key: string };

/** A typed relation from the item to another item OF THE SAME SYSTEM, named by its identity key, never by a thought id. */
export type Link = { relation: LinkRelation; target: string };

/** An entity the source's structured layer names (a project, a label): a mention with no model call, under `extraction_key = source:<system>`. */
export type Mention = { name: string; type: EntityType };

/** The source form, byte for byte, and what it is. */
export type Canonical = { form: string; mediaType: string };

/** What an adapter yields for one item. */
export type Ingested = {
  identity: Identity;
  /** The unit the allowlist clears — a project, a vault. */
  scope: string;
  canonical: Canonical;
  /** The clean projection: what is stored as content and embedded. */
  text: string;
  links: Link[];
  mentions: Mention[];
  /** Metadata for the row: tags, properties, status, people, dates. `source` is the pipeline's; an adapter's own `source` key is overwritten. */
  facets: Record<string, unknown>;
  /** When the item came to be on the source side; the pipeline leaves created_at to now() when absent. */
  createdAt?: string;
  /**
   * The source's own clock for the item, as one of the facets: the key and the
   * value this mapping carries (Linear: `linear_updated_at`). The pipeline
   * does not write an item over a row whose stored value is NEWER — a dump
   * built on Monday, re-ingested on Friday over a brain the sync kept current,
   * would otherwise move every ticket that moved back to Monday's text, and
   * the next sync pass forward again (SMD-1958). Values compare as strings, so
   * the clock is an ISO-8601 instant in UTC or another form that sorts as it
   * orders. Absent, the pipeline compares the text and the facets alone.
   */
  watermark?: { key: string; value: string };
};

/** A source adapter: a name and a pure map. It reads; the pipeline writes. */
export type Adapter<Item> = {
  system: string;
  map(item: Item): Ingested;
};

/**
 * What an adapter throws for an item it cannot represent faithfully — a file
 * that is not UTF-8, one holding NUL — so the pipeline records a refusal for
 * that item and continues, rather than storing a canonical it cannot round-trip.
 */
export class AdapterRefusal extends Error {
  constructor(public readonly identity: Identity, reason: string) {
    super(`${identity.system} ${identity.key}: ${reason}`);
    this.name = "AdapterRefusal";
  }
}

/** The one test every adapter passes: the canonical it kept IS the input, byte for byte. */
export function roundTrips(ingested: Ingested, original: string): boolean {
  return ingested.canonical.form === original;
}

/**
 * JSON with keys in one order at every depth, so two fetches of one unchanged
 * item hash alike whatever order the API listed the fields in — the canonical
 * of an item that arrives as an object rather than as bytes.
 */
export function stableJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.keys(v as Record<string, unknown>).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]));
  }
  return v;
}

/**
 * Bytes as text, only when they are UTF-8 and hold no NUL — the two inputs a
 * `text` column cannot hold byte for byte. Anything else is a reason, and the
 * adapter refuses the item rather than storing a replacement character where
 * the source had a byte (SMD-1867: lossy cases enumerated, not discovered).
 */
export function decodeUtf8Strict(bytes: Uint8Array): { ok: true; text: string } | { ok: false; reason: string } {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return { ok: false, reason: "not valid UTF-8 — a text column cannot hold it byte for byte" };
  }
  if (text.includes("\u0000")) return { ok: false, reason: "holds a NUL byte, which PostgreSQL text cannot" };
  return { ok: true, text };
}

/**
 * Links as the writer wants them: one per (relation, target), sorted so two
 * runs emit one order, none to the item itself, none with an empty target or
 * a relation outside the six. Returns what was dropped so an adapter's
 * self-check can say why.
 */
export function normaliseLinks(links: readonly Link[], self: string): { links: Link[]; dropped: number } {
  const seen = new Set<string>();
  const out: Link[] = [];
  let dropped = 0;
  for (const l of links) {
    const target = l.target.trim();
    if (!target || target === self || !LINK_RELATIONS.includes(l.relation)) { dropped++; continue; }
    const k = `${l.relation}\u0000${target}`;
    if (seen.has(k)) { dropped++; continue; }
    seen.add(k);
    out.push({ relation: l.relation, target });
  }
  out.sort((a, b) => (a.relation < b.relation ? -1 : a.relation > b.relation ? 1 : a.target < b.target ? -1 : a.target > b.target ? 1 : 0));
  return { links: out, dropped };
}

/** Mentions as the writer wants them: trimmed, typed, one per (type, name), sorted. */
export function normaliseMentions(mentions: readonly Mention[]): Mention[] {
  const seen = new Set<string>();
  const out: Mention[] = [];
  for (const m of mentions) {
    const name = m.name.trim();
    if (!name || name.length > 200 || !ENTITY_TYPES.includes(m.type)) continue;
    const k = `${m.type}\u0000${name.toLowerCase()}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ name, type: m.type });
  }
  out.sort((a, b) => (a.type < b.type ? -1 : a.type > b.type ? 1 : a.name.localeCompare(b.name, "en")));
  return out;
}

// ---------------------------------------------------------------------------
// The allowlist — SMD-1813's precondition, enforced by configuration
// ---------------------------------------------------------------------------

/** The scopes the operator cleared. Empty is the default and clears nothing. */
export type Allowlist = ReadonlySet<string>;

/** `OB1_INGEST_ALLOW` / `--allow`: comma-separated scopes, trimmed; empty or unset is the empty set. */
export function allowlistFrom(value: string | undefined | null): Allowlist {
  return new Set((value ?? "").split(",").map((s) => s.trim()).filter(Boolean));
}

/**
 * Why an item may not be ingested, or null when its scope is cleared. Exact
 * match on the scope — never a prefix, never "the whole workspace" — the rule
 * SMD-1813 asks for; the message names the knob so the refusal is actionable.
 */
export function scopeRefusal(allow: Allowlist, ingested: Pick<Ingested, "identity" | "scope">, label: string = `${ingested.identity.system} ${ingested.identity.key}`): string | null {
  if (allow.has(ingested.scope)) return null;
  return `${label}: scope "${ingested.scope}" is not on the allowlist — content pulled in is stored, embedded and sent to a model; clear the scope with --allow "${ingested.scope}" (or OB1_INGEST_ALLOW), never a whole workspace (SMD-1813)`;
}

/** The bound thought_sources.identity carries; an adapter refuses a longer key rather than fail the write. */
export const IDENTITY_MAX = 512;
