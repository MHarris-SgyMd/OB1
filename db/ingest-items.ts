#!/usr/bin/env bun
/**
 * ingest-items.ts — the FILE adapter of the ingestion contract (SMD-2136):
 * items already mapped, one per line, from a parser in any language.
 *
 * The two adapters beside this one (ingest-linear.ts, ingest-markdown.ts) are
 * TypeScript maps from a source item to an `Ingested`; the pipeline
 * (db/ingest-records.ts) writes what they yield. SMD-2126 routes the import
 * recipes onto the same pipeline, and three of the four are Python with
 * parsers worth keeping — a ChatGPT export's tree walk, an `.xlsx` reader,
 * the Readwise API's paging. This module is the seam: the parser stays what
 * it is and EMITS the contract's items as JSON, one object per line
 * (`json.dumps(item)`), and `bun db/ingest-records.ts --items <file.jsonl>`
 * (or `--items -` from a pipe) validates and writes them. No database client
 * in the recipe, no TypeScript rewrite under db/, and the write path — the
 * row with 003's fingerprint, the actor envelope, the canonical in
 * thought_sources, 053's links as a set, the structured mentions, the vector
 * left for reembed.ts — is the pipeline's, unchanged.
 *
 * What a line is: a JSON object with exactly the keys `Ingested` names for an
 * item — `identity {system, key}`, `scope`, `canonical {form, mediaType}`,
 * `text`, `links`, `mentions`, `facets`, and optionally `createdAt` and
 * `watermark {key, value, asOf?}`. The round-trip rule holds by construction:
 * the canonical IS the line's `form`, stored byte for byte; the text is the
 * emitter's projection of it. `derived` is not taken from a file — a part
 * that is a thought of its own is a line of its own.
 *
 * A malformed line refuses the WHOLE file, naming the line and the field
 * (ItemsRefusal), and the pipeline writes nothing — a file half written is a
 * file the emitter cannot re-run cleanly, where a file refused is fixed and
 * run again. The rules are the contract's own (SYSTEM_RE, IDENTITY_MAX,
 * LINK_RELATIONS, ENTITY_TYPES, normaliseLinks / normaliseMentions) plus what
 * a `text` or `jsonb` column cannot hold — a NUL, a lone surrogate — checked
 * here rather than discovered at the cast, which would abort the run on line
 * N of M with N-1 written. Two lines of one identity are refused together:
 * they would land on one row, the second silently over the first.
 *
 * The items are external content and pass SMD-1813's allowlist as the two
 * adapter sources do: each names its `scope`, and the pipeline ingests only a
 * scope the operator cleared (`--allow` / OB1_INGEST_ALLOW), default nothing.
 */

import { IDENTITY_MAX, LINK_RELATIONS, normaliseLinks, normaliseMentions, SYSTEM_RE, type Ingested, type Link, type Mention } from "./ingest-contract.ts";
import { ENTITY_TYPES } from "../server-portable/entities.ts";

/** The keys a line may carry — `Ingested`'s, less `derived`. */
export const ITEM_KEYS = ["identity", "scope", "canonical", "text", "links", "mentions", "facets", "createdAt", "watermark"] as const;
/** The keys a line must carry. */
export const REQUIRED_KEYS = ["identity", "scope", "canonical", "text", "links", "mentions", "facets"] as const;
/** The pipeline's own record sources — the fork's changes, its commits, the memory files. No adapter writes them and a file may not claim them: their rows are the tree's, not an emitter's. */
export const RESERVED_SYSTEMS = ["fork", "commit", "memory"] as const;
/** The metadata keys the pipeline owns: `source` is the system's, the two actor keys are 050's trigger's. A watermark under one of them would be overwritten and the clock guard inert. */
export const PIPELINE_META_KEYS = ["source", "actor_kind", "actor_name"] as const;
/** normaliseMentions' bound on a name. */
export const MENTION_NAME_MAX = 200;
/** A media type as RFC 6838 spells one: `type/subtype`, the two in the token alphabet. */
const MEDIA_TYPE_RE = /^[A-Za-z0-9][\w!#$&^.+-]{0,126}\/[A-Za-z0-9][\w!#$&^.+-]{0,126}$/;
/** A UTF-16 code unit with no partner: a high surrogate not followed by a low one, or a low one not preceded by a high one. Without the `u` flag a class matches code units, which is the point; `String.prototype.isWellFormed` says the same and needs a lib the tree's tsconfig does not name. */
const LONE_SURROGATE_RE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
/** An ISO-8601 instant with an offset: date, `T`, hh:mm, optional seconds and fraction, `Z` or ±hh:mm. */
const INSTANT_RE = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)(?::(\d\d)(?:\.\d{1,9})?)?(?:Z|([+-])(\d\d):(\d\d))$/;

/** Why a line cannot be an item: the file (as the flag named it), the line, the field and the reason — the message spells all four. */
export class ItemsRefusal extends Error {
  constructor(public readonly label: string, public readonly line: number, public readonly field: string, public readonly reason: string) {
    super(`${label}: line ${line}: ${field}: ${reason}`);
    this.name = "ItemsRefusal";
  }
}

/**
 * An ISO-8601 instant a timestamptz cast accepts, and no other. `Date.parse`
 * is not the judge: it takes `2026-02-30T00:00:00Z` as March the 2nd and a
 * bare date as midnight UTC, and a value it rounded would be written as
 * created_at without a word (ingest-linear.ts's isCalendarDate, for the same
 * reason). The shape is matched, then each field is bounded and the calendar
 * date round-tripped through Date.UTC.
 */
export function isInstant(s: string): boolean {
  const m = INSTANT_RE.exec(s);
  if (!m) return false;
  const [, y, mo, d, h, mi, se, , oh, om] = m;
  if (Number(h) > 23 || Number(mi) > 59 || (se !== undefined && Number(se) > 59)) return false;
  if (oh !== undefined && (Number(oh) > 23 || Number(om) > 59)) return false;
  const t = Date.UTC(Number(y), Number(mo) - 1, Number(d));
  return new Date(t).toISOString().slice(0, 10) === `${y}-${mo}-${d}`;
}

/**
 * Why a string cannot be stored as it is, or null: a NUL, which PostgreSQL
 * `text` and `jsonb` both refuse, or a lone surrogate, which has no UTF-8 —
 * decodeUtf8Strict's two cases (ingest-contract.ts), for a string that
 * arrived already decoded by JSON.parse and would fail at the cast instead.
 */
export function unstorable(s: string): string | null {
  if (s.includes("\u0000")) return "holds a NUL character, which PostgreSQL text cannot";
  if (LONE_SURROGATE_RE.test(s)) return "holds a lone surrogate (an unpaired \\uD800–\\uDFFF escape), which has no UTF-8 form";
  return null;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isString = (v: unknown): v is string => typeof v === "string";

/** Every string inside a JSON value with the path to it, for the storability check over facets and the rest. */
function* strings(v: unknown, path: string): Generator<[string, string]> {
  if (isString(v)) yield [path, v];
  else if (Array.isArray(v)) for (let i = 0; i < v.length; i++) yield* strings(v[i], `${path}[${i}]`);
  else if (isObject(v)) for (const [k, x] of Object.entries(v)) { yield [`${path}.${k}`, k]; yield* strings(x, `${path}.${k}`); }
}

/** What one parsed line yields: the item, and the links normaliseLinks set aside (self, duplicate, empty target). */
export type ParsedItem = { item: Ingested; linksDropped: number };

/**
 * One line's JSON value as an item, or an ItemsRefusal naming the field. The
 * shape first (an object; the keys it may and must carry), then each field
 * in the contract's terms, then what no column can hold, then the
 * normalisation the two adapters' outputs get.
 */
export function parseItem(value: unknown, line: number, label: string = "--items"): ParsedItem {
  const refuse = (field: string, reason: string): never => { throw new ItemsRefusal(label, line, field, reason); };
  if (!isObject(value)) return refuse("(line)", `a line is one JSON object, not ${value === null ? "null" : Array.isArray(value) ? "an array" : `a ${typeof value}`}`);
  for (const k of Object.keys(value)) {
    if (!(ITEM_KEYS as readonly string[]).includes(k)) return refuse(k, k === "derived" ? "a part that is a thought of its own is a line of its own; `derived` is not taken from a file" : `not a key of an item — the keys are ${ITEM_KEYS.join(", ")}`);
  }
  for (const k of REQUIRED_KEYS) if (!(k in value)) return refuse(k, "missing");

  // identity
  const identity = value.identity;
  if (!isObject(identity)) return refuse("identity", "an object {system, key}");
  for (const k of Object.keys(identity)) if (k !== "system" && k !== "key") return refuse(`identity.${k}`, "not a key of an identity — {system, key}");
  const { system, key } = identity;
  if (!isString(system) || !SYSTEM_RE.test(system)) return refuse("identity.system", `one lower-case word matching ${SYSTEM_RE} — as thought_sources.system spells it`);
  if ((RESERVED_SYSTEMS as readonly string[]).includes(system)) return refuse("identity.system", `"${system}" is one of the pipeline's own record sources (${RESERVED_SYSTEMS.join(", ")}); a file names the system it was parsed from`);
  if (!isString(key) || key.trim() === "") return refuse("identity.key", "a non-empty string — what survives a rename on the source side");
  if (key.length > IDENTITY_MAX) return refuse("identity.key", `${key.length} characters; thought_sources.identity holds ${IDENTITY_MAX}`);

  // scope
  if (!isString(value.scope) || value.scope.trim() === "") return refuse("scope", "a non-empty string — the unit --allow clears (an export, a vault, a workspace)");

  // canonical
  const canonical = value.canonical;
  if (!isObject(canonical)) return refuse("canonical", "an object {form, mediaType}");
  for (const k of Object.keys(canonical)) if (k !== "form" && k !== "mediaType") return refuse(`canonical.${k}`, "not a key of a canonical — {form, mediaType}");
  if (!isString(canonical.form)) return refuse("canonical.form", "a string — the source form, byte for byte, as the emitter read it");
  if (!isString(canonical.mediaType) || !MEDIA_TYPE_RE.test(canonical.mediaType)) return refuse("canonical.mediaType", "a media type, type/subtype (application/json, text/markdown)");

  // text
  if (!isString(value.text)) return refuse("text", "a string — the clean projection that is stored and embedded");
  if (value.text.trim() === "") return refuse("text", "blank — a thought with no text is nothing to search; leave the item out");

  // links
  if (!Array.isArray(value.links)) return refuse("links", "an array of {relation, target}, empty when the item states none");
  const links: Link[] = [];
  for (let i = 0; i < value.links.length; i++) {
    const l = value.links[i];
    if (!isObject(l)) return refuse(`links[${i}]`, "an object {relation, target}");
    for (const k of Object.keys(l)) if (k !== "relation" && k !== "target") return refuse(`links[${i}].${k}`, "not a key of a link — {relation, target}");
    if (!isString(l.relation) || !(LINK_RELATIONS as readonly string[]).includes(l.relation)) return refuse(`links[${i}].relation`, `one of ${LINK_RELATIONS.join(", ")}`);
    if (!isString(l.target)) return refuse(`links[${i}].target`, "a string — the target's identity key within the same system, never a thought id");
    links.push({ relation: l.relation as Link["relation"], target: l.target });
  }

  // mentions
  if (!Array.isArray(value.mentions)) return refuse("mentions", "an array of {name, type}, empty when the item names none");
  const mentions: Mention[] = [];
  for (let i = 0; i < value.mentions.length; i++) {
    const m = value.mentions[i];
    if (!isObject(m)) return refuse(`mentions[${i}]`, "an object {name, type}");
    for (const k of Object.keys(m)) if (k !== "name" && k !== "type") return refuse(`mentions[${i}].${k}`, "not a key of a mention — {name, type}");
    if (!isString(m.type) || !(ENTITY_TYPES as readonly string[]).includes(m.type)) return refuse(`mentions[${i}].type`, `one of ${ENTITY_TYPES.join(", ")}`);
    if (!isString(m.name) || m.name.trim() === "") return refuse(`mentions[${i}].name`, "a non-empty string");
    if (m.name.trim().length > MENTION_NAME_MAX) return refuse(`mentions[${i}].name`, `${m.name.trim().length} characters; a name is at most ${MENTION_NAME_MAX}`);
    mentions.push({ name: m.name, type: m.type as Mention["type"] });
  }

  // facets
  if (!isObject(value.facets)) return refuse("facets", "an object — the row's metadata (tags, a title, dates); {} when the item has none");

  // createdAt
  if ("createdAt" in value && (!isString(value.createdAt) || !isInstant(value.createdAt))) return refuse("createdAt", "an ISO-8601 instant with an offset (2026-09-25T10:00:00Z) — a calendar date that exists; a bare date or a rolled-over one is not taken");

  // watermark
  let watermark: Ingested["watermark"];
  if ("watermark" in value) {
    const w = value.watermark;
    if (!isObject(w)) return refuse("watermark", "an object {key, value, asOf?} — the source's clock for the item, as one of the facets");
    for (const k of Object.keys(w)) if (k !== "key" && k !== "value" && k !== "asOf") return refuse(`watermark.${k}`, "not a key of a watermark — {key, value, asOf?}");
    if (!isString(w.key) || w.key.trim() === "") return refuse("watermark.key", "a non-empty string — the facet the clock is written under");
    if ((PIPELINE_META_KEYS as readonly string[]).includes(w.key)) return refuse("watermark.key", `"${w.key}" is the pipeline's own metadata key; the clock would be overwritten and the guard inert`);
    if (!isString(w.value) || w.value === "") return refuse("watermark.value", "a non-empty string that sorts as it orders — an ISO-8601 instant in UTC");
    if ("asOf" in w && (!isString(w.asOf) || !isInstant(w.asOf))) return refuse("watermark.asOf", "an ISO-8601 instant with an offset — when this view of the source was taken");
    watermark = { key: w.key, value: w.value, ...(isString(w.asOf) ? { asOf: w.asOf } : {}) };
  }

  // What no column holds, anywhere in the line: text, canonical.form and
  // identity.key go to `text` columns; facets, link targets, mention names
  // and the watermark to jsonb. One walk, the first offender named by path.
  for (const [path, s] of strings(value, "")) {
    const why = unstorable(s);
    if (why) return refuse(path.replace(/^\./, ""), why);
  }

  const norm = normaliseLinks(links, key);
  const item: Ingested = {
    identity: { system, key },
    scope: value.scope,
    canonical: { form: canonical.form, mediaType: canonical.mediaType },
    text: value.text,
    links: norm.links,
    mentions: normaliseMentions(mentions),
    facets: { ...(value.facets as Record<string, unknown>) },
    ...(isString(value.createdAt) ? { createdAt: value.createdAt } : {}),
    ...(watermark ? { watermark } : {}),
  };
  return { item, linksDropped: norm.dropped };
}

/** What a file yields: the items in file order, each with its line, the links set aside, and how many items each system contributed. */
export type ParsedItems = { items: Ingested[]; lines: number[]; linksDropped: number; systems: Record<string, number> };

/**
 * A JSONL text as items. Line numbers are the file's — a blank line is
 * skipped (a trailing newline is the common case) and still counted, so the
 * number a refusal names is the line an editor shows. The first malformed
 * line refuses the whole text; two lines of one identity refuse it too,
 * naming both.
 */
export function parseItems(text: string, label: string = "--items"): ParsedItems {
  const items: Ingested[] = [];
  const lines: number[] = [];
  const systems: Record<string, number> = {};
  const holders = new Map<string, number>();
  let linksDropped = 0;
  const raw = text.split(/\r?\n/);
  for (let i = 0; i < raw.length; i++) {
    const line = i + 1;
    if (raw[i].trim() === "") continue;
    let value: unknown;
    try { value = JSON.parse(raw[i]); }
    catch (e) { throw new ItemsRefusal(label, line, "(line)", `not JSON — ${(e as Error).message}; one object per line, no trailing comma, no wrapping array`); }
    const { item, linksDropped: dropped } = parseItem(value, line, label);
    const idKey = `${item.identity.system}\u0000${item.identity.key}`;
    const holder = holders.get(idKey);
    if (holder !== undefined) throw new ItemsRefusal(label, line, "identity", `${item.identity.system} ${JSON.stringify(item.identity.key)} is line ${holder}'s too — two items of one identity would land on one row, the second over the first; one line per item`);
    holders.set(idKey, line);
    items.push(item);
    lines.push(line);
    systems[item.identity.system] = (systems[item.identity.system] ?? 0) + 1;
    linksDropped += dropped;
  }
  return { items, lines, linksDropped, systems };
}

// ---------------------------------------------------------------------------
// Self-check — the pure rules, no database. The fixtures below are also what
// ingest-records.ts's self-check and db/test-live.ts [19] drive.
// ---------------------------------------------------------------------------

/** A well-formed item, as an emitter would print it: a ChatGPT conversation's summary with one link, one mention and the source's clock. */
export const SAMPLE_ITEM = {
  identity: { system: "chatgpt", key: "conv-8f3a" },
  scope: "chatgpt:export-2026-09",
  canonical: { form: "{\"id\":\"conv-8f3a\",\"title\":\"Postgres pooling\",\"messages\":[{\"role\":\"user\",\"text\":\"…\"}]}", mediaType: "application/json" },
  text: "Postgres pooling — decided: one connection per worker, the pool at the edge.",
  links: [{ relation: "references", target: "conv-1b2c" }],
  mentions: [{ name: "PostgreSQL", type: "tool" }],
  facets: { title: "Postgres pooling", type: "decision" },
  createdAt: "2026-09-01T10:00:00Z",
  watermark: { key: "chatgpt_updated_at", value: "2026-09-02T00:00:00Z" },
} as const;

/** One line of a file, as an emitter prints it. */
export const SAMPLE_LINE = JSON.stringify(SAMPLE_ITEM);

/** The malformed kinds, each a patch of SAMPLE_ITEM, the field the refusal names and a word of the reason. */
export const MALFORMED: readonly [label: string, line: string, field: string, reason: RegExp][] = [
  ["not JSON", "{not json", "(line)", /not JSON/],
  ["an array, not an object", "[1,2]", "(line)", /one JSON object, not an array/],
  ["a string, not an object", "\"x\"", "(line)", /not a string/],
  ["an unknown key", JSON.stringify({ ...SAMPLE_ITEM, scopes: "x" }), "scopes", /not a key of an item/],
  ["derived", JSON.stringify({ ...SAMPLE_ITEM, derived: [] }), "derived", /a line of its own/],
  ["a missing required key", JSON.stringify(Object.fromEntries(Object.entries(SAMPLE_ITEM).filter(([k]) => k !== "scope"))), "scope", /missing/],
  ["identity not an object", JSON.stringify({ ...SAMPLE_ITEM, identity: "chatgpt:x" }), "identity", /\{system, key\}/],
  ["a system with a capital", JSON.stringify({ ...SAMPLE_ITEM, identity: { system: "ChatGPT", key: "k" } }), "identity.system", /lower-case word/],
  ["a reserved system", JSON.stringify({ ...SAMPLE_ITEM, identity: { system: "memory", key: "k" } }), "identity.system", /pipeline's own record sources/],
  ["an empty key", JSON.stringify({ ...SAMPLE_ITEM, identity: { system: "chatgpt", key: " " } }), "identity.key", /non-empty/],
  ["a key past IDENTITY_MAX", JSON.stringify({ ...SAMPLE_ITEM, identity: { system: "chatgpt", key: "k".repeat(IDENTITY_MAX + 1) } }), "identity.key", new RegExp(`${IDENTITY_MAX + 1} characters`)],
  ["an empty scope", JSON.stringify({ ...SAMPLE_ITEM, scope: "" }), "scope", /non-empty/],
  ["canonical not an object", JSON.stringify({ ...SAMPLE_ITEM, canonical: "{}" }), "canonical", /\{form, mediaType\}/],
  ["a form that is not a string", JSON.stringify({ ...SAMPLE_ITEM, canonical: { form: { id: 1 }, mediaType: "application/json" } }), "canonical.form", /a string/],
  ["a mediaType that is not one", JSON.stringify({ ...SAMPLE_ITEM, canonical: { form: "{}", mediaType: "json" } }), "canonical.mediaType", /type\/subtype/],
  ["text not a string", JSON.stringify({ ...SAMPLE_ITEM, text: 42 }), "text", /a string/],
  ["blank text", JSON.stringify({ ...SAMPLE_ITEM, text: "  \n" }), "text", /blank/],
  ["links not an array", JSON.stringify({ ...SAMPLE_ITEM, links: {} }), "links", /an array/],
  ["a relation outside the six", JSON.stringify({ ...SAMPLE_ITEM, links: [{ relation: "mentions", target: "x" }] }), "links[0].relation", /one of references/],
  ["a link with an extra key", JSON.stringify({ ...SAMPLE_ITEM, links: [{ relation: "references", target: "x", id: 1 }] }), "links[0].id", /not a key of a link/],
  ["a target that is not a string", JSON.stringify({ ...SAMPLE_ITEM, links: [{ relation: "references", target: 7 }] }), "links[0].target", /a string/],
  ["mentions not an array", JSON.stringify({ ...SAMPLE_ITEM, mentions: "PostgreSQL" }), "mentions", /an array/],
  ["a mention type outside the list", JSON.stringify({ ...SAMPLE_ITEM, mentions: [{ name: "x", type: "thing" }] }), "mentions[0].type", /one of person/],
  ["an empty mention name", JSON.stringify({ ...SAMPLE_ITEM, mentions: [{ name: "", type: "topic" }] }), "mentions[0].name", /non-empty/],
  ["a mention name past the bound", JSON.stringify({ ...SAMPLE_ITEM, mentions: [{ name: "n".repeat(MENTION_NAME_MAX + 1), type: "topic" }] }), "mentions[0].name", /at most 200/],
  ["facets an array", JSON.stringify({ ...SAMPLE_ITEM, facets: [] }), "facets", /an object/],
  ["facets null", JSON.stringify({ ...SAMPLE_ITEM, facets: null }), "facets", /an object/],
  ["createdAt a bare date", JSON.stringify({ ...SAMPLE_ITEM, createdAt: "2026-09-01" }), "createdAt", /ISO-8601 instant/],
  ["createdAt a rolled-over date", JSON.stringify({ ...SAMPLE_ITEM, createdAt: "2026-02-30T00:00:00Z" }), "createdAt", /ISO-8601 instant/],
  ["createdAt with no offset", JSON.stringify({ ...SAMPLE_ITEM, createdAt: "2026-09-01T10:00:00" }), "createdAt", /ISO-8601 instant/],
  ["watermark not an object", JSON.stringify({ ...SAMPLE_ITEM, watermark: "2026" }), "watermark", /\{key, value, asOf\?\}/],
  ["a watermark with no value", JSON.stringify({ ...SAMPLE_ITEM, watermark: { key: "k" } }), "watermark.value", /non-empty/],
  ["a watermark under the pipeline's key", JSON.stringify({ ...SAMPLE_ITEM, watermark: { key: "source", value: "v" } }), "watermark.key", /pipeline's own metadata key/],
  ["a watermark asOf that is not an instant", JSON.stringify({ ...SAMPLE_ITEM, watermark: { key: "k", value: "v", asOf: "yesterday" } }), "watermark.asOf", /ISO-8601 instant/],
  ["a NUL in the text", JSON.stringify({ ...SAMPLE_ITEM, text: "a\u0000b" }), "text", /NUL/],
  ["a NUL in the form", JSON.stringify({ ...SAMPLE_ITEM, canonical: { form: "a\u0000b", mediaType: "text/plain" } }), "canonical.form", /NUL/],
  ["a lone surrogate in a facet", "{" + SAMPLE_LINE.slice(1).replace("\"title\":\"Postgres pooling\"", "\"title\":\"\\ud800 pooling\""), "facets.title", /lone surrogate/],
  ["a NUL in a facet key", JSON.stringify({ ...SAMPLE_ITEM, facets: { "a\u0000b": 1 } }), "facets.a\u0000b", /NUL/],
];

export function selfCheck(): number {
  let bad = 0;
  const ok = (cond: boolean, label: string) => { if (!cond) { console.error(`FAIL ${label}`); bad++; } };

  // The good line: every field carried, the links and mentions normalised, the canonical the line's form byte for byte.
  const one = parseItem(JSON.parse(SAMPLE_LINE), 1, "x.jsonl");
  const it = one.item;
  ok(it.identity.system === "chatgpt" && it.identity.key === "conv-8f3a" && it.scope === SAMPLE_ITEM.scope, "identity and scope carried");
  ok(it.canonical.form === SAMPLE_ITEM.canonical.form && it.canonical.mediaType === "application/json", "the canonical is the line's form, byte for byte — the round trip holds by construction");
  ok(it.text === SAMPLE_ITEM.text && JSON.stringify(it.facets) === JSON.stringify(SAMPLE_ITEM.facets) && it.createdAt === "2026-09-01T10:00:00Z", "text, facets and createdAt carried");
  ok(JSON.stringify(it.links) === '[{"relation":"references","target":"conv-1b2c"}]' && JSON.stringify(it.mentions) === '[{"name":"PostgreSQL","type":"tool"}]' && one.linksDropped === 0, "links and mentions carried, normalised");
  ok(it.watermark?.key === "chatgpt_updated_at" && it.watermark.value === "2026-09-02T00:00:00Z" && it.watermark.asOf === undefined, "the watermark carried, no asOf unless given");
  ok((it as Record<string, unknown>).derived === undefined && !("asOf" in (it.watermark ?? {})), "no key invented");
  const minimal = parseItem({ identity: { system: "s", key: "k" }, scope: "s", canonical: { form: "f", mediaType: "text/plain" }, text: "t", links: [], mentions: [], facets: {} }, 1).item;
  ok(minimal.createdAt === undefined && minimal.watermark === undefined && minimal.links.length === 0, "the optional keys absent stay absent — the pipeline leaves created_at to now()");
  const norm = parseItem({ ...SAMPLE_ITEM, links: [{ relation: "references", target: "conv-8f3a" }, { relation: "references", target: "b" }, { relation: "references", target: "b" }, { relation: "blocks", target: " " }] }, 1);
  ok(norm.item.links.length === 1 && norm.linksDropped === 3, `normaliseLinks: the self link, the duplicate and the empty target are set aside and counted (${norm.linksDropped})`);
  ok(parseItem({ ...SAMPLE_ITEM, mentions: [{ name: " PostgreSQL ", type: "tool" }, { name: "postgresql", type: "tool" }] }, 1).item.mentions.length === 1, "normaliseMentions: trimmed, one per (type, name) folded by case");
  ok(parseItem({ ...SAMPLE_ITEM, watermark: { key: "k", value: "v", asOf: "2026-09-03T00:00:00+02:00" } }, 1).item.watermark?.asOf === "2026-09-03T00:00:00+02:00", "an asOf with an offset is an instant");
  ok(parseItem({ ...SAMPLE_ITEM, facets: { source: "elsewhere" } }, 1).item.facets.source === "elsewhere", "a facets.source is carried as given — the pipeline overwrites it with the system (ingest-contract.ts)");

  // Each malformed kind: refused, on the line given, naming the field.
  for (const [label, line, field, reason] of MALFORMED) {
    let got: ItemsRefusal | null = null;
    try { parseItems(`${SAMPLE_LINE}\n${line}\n`, "x.jsonl"); }
    catch (e) { if (e instanceof ItemsRefusal) got = e; else throw e; }
    ok(got !== null && got.line === 2 && got.field === field && reason.test(got.reason) && got.message.startsWith(`x.jsonl: line 2: ${field}: `), `${label}: refused on line 2 naming ${JSON.stringify(field)} (${got ? `${got.line} ${JSON.stringify(got.field)}: ${got.reason.slice(0, 60)}` : "not refused"})`);
  }

  // The file: order kept, blank lines skipped without shifting numbers, the systems counted, duplicates refused together.
  const two = parseItems(`\n${SAMPLE_LINE}\n\n${JSON.stringify({ ...SAMPLE_ITEM, identity: { system: "readwise", key: "h-1" } })}\n`, "x.jsonl");
  ok(two.items.length === 2 && two.lines.join(",") === "2,4" && two.systems.chatgpt === 1 && two.systems.readwise === 1, `two items on lines 2 and 4 (blank lines skipped, numbers the file's), one per system (${two.lines.join(",")})`);
  ok(parseItems("").items.length === 0 && parseItems("\n\n").items.length === 0, "an empty file is zero items, not a refusal");
  let dup: ItemsRefusal | null = null;
  try { parseItems(`${SAMPLE_LINE}\n${JSON.stringify({ ...SAMPLE_ITEM, text: "another text" })}\n`, "x.jsonl"); }
  catch (e) { if (e instanceof ItemsRefusal) dup = e; else throw e; }
  ok(dup?.line === 2 && dup.field === "identity" && /line 1's too/.test(dup.reason), `two lines of one identity are refused, the second naming the first (${dup?.reason.slice(0, 50)})`);
  ok(parseItems(`${SAMPLE_LINE}\n${JSON.stringify({ ...SAMPLE_ITEM, identity: { system: "other", key: "conv-8f3a" } })}\n`).items.length === 2, "…the same key under another system is another identity");
  let third: ItemsRefusal | null = null;
  try { parseItems(`${SAMPLE_LINE}\n${JSON.stringify({ ...SAMPLE_ITEM, identity: { system: "chatgpt", key: "k2" } })}\n{oops\n`, "--items x.jsonl"); }
  catch (e) { if (e instanceof ItemsRefusal) third = e; else throw e; }
  ok(third?.line === 3 && third.message === "--items x.jsonl: line 3: (line): " + third.reason, `a bad third line refuses the file naming line 3, in the flag's own words (${third?.message.slice(0, 40)})`);

  // The instant rule.
  ok(isInstant("2026-09-25T10:00:00Z") && isInstant("2026-09-25T10:00Z") && isInstant("2026-09-25T10:00:00.123456789+05:30") && isInstant("2026-02-28T23:59:59-00:00"), "instants: seconds and fraction optional, Z or ±hh:mm");
  ok(!isInstant("2026-09-25") && !isInstant("2026-09-25T10:00:00") && !isInstant("2026-02-30T00:00:00Z") && !isInstant("2026-13-01T00:00:00Z") && !isInstant("2026-09-25T24:00:00Z") && !isInstant("2026-09-25T10:60:00Z") && !isInstant("2026-09-25T10:00:00+24:00") && !isInstant(" 2026-09-25T10:00:00Z"), "not instants: a bare date, no offset, February the 30th, month 13, hour 24, minute 60, offset 24, a leading space");
  ok(unstorable("plain") === null && /NUL/.test(unstorable("a\u0000b") ?? "") && /surrogate/.test(unstorable("a\ud800") ?? "") && unstorable("😀") === null, "unstorable: NUL and a lone surrogate, and a paired surrogate is fine");

  if (bad === 0) console.log("ingest-items.ts self-check PASS");
  return bad === 0 ? 0 : 1;
}

if (import.meta.main) {
  if (process.argv.includes("--self-check")) process.exit(selfCheck());
  console.error("ingest-items.ts is a library — the file adapter for db/ingest-records.ts --items. `--self-check` runs its pure rules.");
  process.exit(2);
}
