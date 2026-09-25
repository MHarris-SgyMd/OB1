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
 * `watermark {key, value, asOf?}` (`null` for either is absent — what a
 * Python emitter writes for None). The round-trip rule holds by construction:
 * the canonical IS the line's `form`, stored byte for byte; the text is the
 * emitter's projection of it. `derived` is not taken from a file — a part
 * that is a thought of its own is a line of its own.
 *
 * A malformed line refuses the WHOLE file, naming the line and the field
 * (ItemsRefusal), and the pipeline writes nothing — a file half written is a
 * file the emitter cannot re-run cleanly, where a file refused is fixed and
 * run again. The rules are the contract's own (SYSTEM_RE, IDENTITY_MAX,
 * LINK_RELATIONS, ENTITY_TYPES, normaliseLinks / normaliseMentions) plus what
 * a `text` or `jsonb` column cannot hold — a NUL, a lone surrogate, a byte
 * that is not UTF-8, a value nested past what a parser's stack takes —
 * checked here rather than discovered at the cast, which would abort the run
 * on line N of M with N-1 written; plus what the pipeline's own knobs could
 * not act on — a scope with a `/` (`--allow` reads one as a path) or a `,`
 * (its separator), a key or
 * scope with surrounding whitespace (a link's target and an `--allow` entry
 * are trimmed, so neither could ever match). Two lines of one identity are
 * refused together: they would land on one row, the second silently over the
 * first. A system the pipeline reads itself (`fork`, `commit`, `linear`,
 * `memory`, `markdown`, `items`) is refused: a file's row on the board sync's
 * id for a ticket would overwrite the sync's row with no `held` to say so.
 *
 * The items are external content and pass SMD-1813's allowlist as the two
 * adapter sources do: each names its `scope`, and the pipeline ingests only a
 * scope the operator cleared (`--allow` / OB1_INGEST_ALLOW), default nothing.
 */

import { decodeUtf8Strict, IDENTITY_MAX, LINK_RELATIONS, normaliseLinks, normaliseMentions, SYSTEM_RE, type Ingested, type Link, type Mention } from "./ingest-contract.ts";
import { ENTITY_TYPES } from "../server-portable/entities.ts";

/** The keys a line may carry — `Ingested`'s, less `derived`. */
export const ITEM_KEYS = ["identity", "scope", "canonical", "text", "links", "mentions", "facets", "createdAt", "watermark"] as const;
/** The keys a line must carry. */
export const REQUIRED_KEYS = ["identity", "scope", "canonical", "text", "links", "mentions", "facets"] as const;
/**
 * The pipeline's own sources (ingest-records.ts SOURCES — its self-check
 * holds the two lists equal). A file may not claim one: the fork's records
 * have no adapter and their rows are the tree's; `linear` and `markdown` are
 * the adapters' id spaces, where a file's row would land on the board sync's
 * row for a ticket and overwrite it — same id, so `held` never trips (first
 * review pass, run-it); `items` is this flag's name, not a system.
 */
export const RESERVED_SYSTEMS = ["fork", "commit", "linear", "memory", "markdown", "items"] as const;
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
/** The byte-order mark a Windows redirection puts before the first line; not JSON, and invisible in a message. */
const BOM = "﻿";

/** Why a line cannot be an item: the file (as the flag named it), the line, the field and the reason — the message spells all four. */
export class ItemsRefusal extends Error {
  constructor(public readonly label: string, public readonly line: number, public readonly field: string, public readonly reason: string) {
    super(`${label}: line ${line}: ${field}: ${reason}`);
    this.name = "ItemsRefusal";
  }
}

/** PostgreSQL's bound on a time zone displacement's hours (datetime.h MAX_TZDISP_HOUR). */
const TZ_HOUR_MAX = 15;
/**
 * One strict profile of ISO-8601 — `YYYY-MM-DDThh:mm[:ss[.f]]` with `Z` or
 * `±hh:mm` — every value of which a timestamptz cast accepts as the instant
 * it reads as. A cast takes more shapes (a space for the `T`, `+0530`, a bare
 * date); this takes the one an emitter can be told to write. `Date.parse` is
 * not the judge: it takes `2026-02-30T00:00:00Z` as March the 2nd and a bare
 * date as midnight UTC, and a value it rounded would be written as
 * created_at without a word (ingest-linear.ts's isCalendarDate, for the same
 * reason). The shape is matched, then each field is bounded — the offset's
 * hour to 15, PostgreSQL's MAX_TZDISP_HOUR (`+16:00` is "time zone
 * displacement out of range" at the cast), the year to 1 and up (there is
 * no year 0: `0000-01-01` is "date/time field value out of range"; second
 * review pass, both readers) — and the calendar date round-tripped through
 * setUTCFullYear, which takes a year under 100 as itself where Date.UTC
 * takes it as 19xx (first review pass, cold read).
 */
export function isInstant(s: string): boolean {
  const m = INSTANT_RE.exec(s);
  if (!m) return false;
  const [, y, mo, d, h, mi, se, , oh, om] = m;
  if (Number(y) < 1 || Number(h) > 23 || Number(mi) > 59 || (se !== undefined && Number(se) > 59)) return false;
  if (oh !== undefined && (Number(oh) > TZ_HOUR_MAX || Number(om) > 59)) return false;
  const dt = new Date(0);
  dt.setUTCFullYear(Number(y), Number(mo) - 1, Number(d));
  return dt.toISOString().slice(0, 10) === `${y}-${mo}-${d}`;
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

/**
 * Every string inside a JSON value with the path to it, for the storability
 * check over facets and the rest. Iterative, with its own stack: a value
 * nested two hundred thousand deep is a line to refuse, not a RangeError to
 * die of (first review pass, run-it).
 */
function* strings(root: unknown, rootPath: string): Generator<[string, string]> {
  const stack: [unknown, string][] = [[root, rootPath]];
  while (stack.length) {
    const [v, path] = stack.pop()!;
    if (isString(v)) yield [path, v];
    else if (Array.isArray(v)) for (let i = v.length - 1; i >= 0; i--) stack.push([v[i], `${path}[${i}]`]);
    else if (isObject(v)) {
      const entries = Object.entries(v);
      for (let i = entries.length - 1; i >= 0; i--) { const [k, x] = entries[i]; stack.push([x, `${path}.${k}`]); stack.push([k, `${path}.${k}`]); }
    }
  }
}

/** The level a line's value may not reach, the line's object being level 0 (its `facets` level 1). PostgreSQL's jsonb reader is recursive and stops at its stack limit — a few thousand levels — with an error at the cast; no facet nests past a handful, so the bound is small and the refusal is this module's, with the line (first review pass, run-it). */
export const DEPTH_MAX = 64;

/** Whether a JSON value nests past `max` levels — iterative, so the question itself cannot overflow. */
function tooDeep(root: unknown, max: number): boolean {
  const stack: [unknown, number][] = [[root, 0]];
  while (stack.length) {
    const [v, depth] = stack.pop()!;
    if (typeof v !== "object" || v === null) continue;
    if (depth >= max) return true;
    for (const x of Array.isArray(v) ? v : Object.values(v)) stack.push([x, depth + 1]);
  }
  return false;
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
  if (tooDeep(value, DEPTH_MAX)) return refuse("(line)", `nested too deeply — a value at level ${DEPTH_MAX} or below, the line's object being level 0; a jsonb value has a depth bound too, met at the cast; flatten the facets`);
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
  if ((RESERVED_SYSTEMS as readonly string[]).includes(system)) return refuse("identity.system", `"${system}" is one of the pipeline's own sources (${RESERVED_SYSTEMS.join(", ")}), which it reads itself; a file names the system it was parsed from`);
  if (!isString(key) || key.trim() === "") return refuse("identity.key", "a non-empty string — what survives a rename on the source side");
  if (key !== key.trim()) return refuse("identity.key", "leading or trailing whitespace — a link's target is trimmed (normaliseLinks), so a row under this key could never be linked");
  if (key.length > IDENTITY_MAX) return refuse("identity.key", `${key.length} characters; thought_sources.identity holds ${IDENTITY_MAX}`);

  // scope
  const scope = value.scope;
  if (!isString(scope) || scope.trim() === "") return refuse("scope", "a non-empty string — the unit --allow clears (an export, a vault, a workspace)");
  if (scope !== scope.trim()) return refuse("scope", "surrounding whitespace — --allow trims its entries, so this scope could never be cleared");
  if (scope.includes("/")) return refuse("scope", "holds a `/`, which --allow reads as a path (the markdown vault's scope) and resolves, so this scope could never be cleared; spell it with `:` (chatgpt:export)");
  if (scope.includes(",")) return refuse("scope", "holds a `,`, which --allow reads as its separator between scopes, so this scope could never be cleared; spell it with `:` or `-`");

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

  // createdAt — `null` is absent, as a Python emitter spells None.
  const createdAt = value.createdAt ?? undefined;
  if (createdAt !== undefined && (!isString(createdAt) || !isInstant(createdAt))) return refuse("createdAt", "an ISO-8601 instant with an offset (2026-09-25T10:00:00Z) — a calendar date that exists; a bare date or a rolled-over one is not taken; omit the key (or write null) when the source has none");

  // watermark — `null` is absent too.
  let watermark: Ingested["watermark"];
  const w = value.watermark ?? undefined;
  if (w !== undefined) {
    if (!isObject(w)) return refuse("watermark", "an object {key, value, asOf?} — the source's clock for the item, as one of the facets; omit the key (or write null) when the source has none");
    for (const k of Object.keys(w)) if (k !== "key" && k !== "value" && k !== "asOf") return refuse(`watermark.${k}`, "not a key of a watermark — {key, value, asOf?}");
    if (!isString(w.key) || w.key.trim() === "") return refuse("watermark.key", "a non-empty string — the facet the clock is written under");
    if ((PIPELINE_META_KEYS as readonly string[]).includes(w.key)) return refuse("watermark.key", `"${w.key}" is the pipeline's own metadata key; the clock would be overwritten and the guard inert`);
    if (!isString(w.value) || w.value === "") return refuse("watermark.value", "a non-empty string that sorts as it orders — the values compare as text, so an ISO-8601 instant in UTC is the usual form");
    if (w.asOf != null && (!isString(w.asOf) || !isInstant(w.asOf))) return refuse("watermark.asOf", "an ISO-8601 instant with an offset — when this view of the source was taken");
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
    scope,
    canonical: { form: canonical.form, mediaType: canonical.mediaType },
    text: value.text,
    links: norm.links,
    mentions: normaliseMentions(mentions),
    facets: { ...(value.facets as Record<string, unknown>) },
    ...(isString(createdAt) ? { createdAt } : {}),
    ...(watermark ? { watermark } : {}),
  };
  return { item, linksDropped: norm.dropped };
}

/** What a file yields: the items in file order, each with its line, the links set aside, and how many items each system contributed. */
export type ParsedItems = { items: Ingested[]; lines: number[]; linksDropped: number; systems: Record<string, number> };

/**
 * A file's lines as text, line by line. Given BYTES (what the CLI reads —
 * `readFileSync` with an encoding would replace a byte that is not UTF-8 with
 * U+FFFD and the canonical would no longer be the source's; first review
 * pass, run-it), each line is decoded strictly and a line that is not UTF-8
 * or holds a NUL byte is the refusal, with its number. A `\r` before the
 * newline is dropped (a CRLF file); a byte-order mark before the first line
 * is dropped too (what a Windows redirection writes).
 */
function linesOf(input: string | Uint8Array, label: string): string[] {
  let lines: string[];
  if (isString(input)) lines = input.split(/\r?\n/);
  else {
    lines = [];
    let start = 0;
    for (let i = 0; i <= input.length; i++) {
      if (i < input.length && input[i] !== 0x0a) continue;
      const end = i > start && input[i - 1] === 0x0d ? i - 1 : i;
      const decoded = decodeUtf8Strict(input.subarray(start, end));
      if (!decoded.ok) throw new ItemsRefusal(label, lines.length + 1, "(line)", decoded.reason);
      lines.push(decoded.text);
      start = i + 1;
    }
  }
  if (lines.length && lines[0].startsWith(BOM)) lines[0] = lines[0].slice(BOM.length);
  return lines;
}

/** A UTF-16 byte-order mark: the whole file is the wrong encoding, and "holds a NUL byte" would be true and unhelpful (second review pass, run-it). */
function utf16Mark(input: string | Uint8Array): boolean {
  return !isString(input) && input.length >= 2 && ((input[0] === 0xff && input[1] === 0xfe) || (input[0] === 0xfe && input[1] === 0xff));
}

/**
 * A JSONL text — or its bytes — as items. Line numbers are the file's: a
 * blank line is skipped (a trailing newline is the common case) and still
 * counted, so the number a refusal names is the line an editor shows. The
 * first malformed line refuses the whole text; two lines of one identity
 * refuse it too, naming both.
 */
export function parseItems(input: string | Uint8Array, label: string = "--items"): ParsedItems {
  const items: Ingested[] = [];
  const lines: number[] = [];
  const systems: Record<string, number> = {};
  const holders = new Map<string, number>();
  let linksDropped = 0;
  if (utf16Mark(input)) throw new ItemsRefusal(label, 1, "(line)", "the file is UTF-16 (its first two bytes are a UTF-16 byte-order mark); write it as UTF-8");
  const raw = linesOf(input, label);
  for (let i = 0; i < raw.length; i++) {
    const line = i + 1;
    if (raw[i].trim() === "") continue;
    let parsed: ParsedItem;
    try {
      const value: unknown = JSON.parse(raw[i]);
      parsed = parseItem(value, line, label);
    } catch (e) {
      if (e instanceof ItemsRefusal) throw e;
      if (e instanceof SyntaxError) throw new ItemsRefusal(label, line, "(line)", raw[i].includes(BOM) ? "not JSON — a byte-order mark (U+FEFF, invisible) inside the line; one is dropped before the first line alone" : `not JSON — ${e.message}; one object per line, no trailing comma, no wrapping array`);
      // Bun's JSON.parse reads iteratively (forty million levels, no throw — second review pass, run-it); a runtime whose parser is not would throw here, and a value past its stack is a line to refuse, not a trace to die of.
      if (e instanceof RangeError) throw new ItemsRefusal(label, line, "(line)", `nested too deeply to read — a value at level ${DEPTH_MAX} or below is refused, and this line passed the parser's own stack first; flatten the facets`);
      throw e;
    }
    const { item, linksDropped: dropped } = parsed;
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
/** Another item of the same system, for a first line the malformed fixtures follow — a distinct identity, so a mutated rule fails on its own field and never as a duplicate (first review pass, run-it). */
const OTHER_LINE = JSON.stringify({ ...SAMPLE_ITEM, identity: { system: "chatgpt", key: "conv-0000" }, text: "Another conversation's summary." });

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
  ["a reserved system: memory", JSON.stringify({ ...SAMPLE_ITEM, identity: { system: "memory", key: "k" } }), "identity.system", /pipeline's own sources/],
  ["a reserved system: linear (the sync's id space)", JSON.stringify({ ...SAMPLE_ITEM, identity: { system: "linear", key: "SMD-1" } }), "identity.system", /pipeline's own sources/],
  ["a reserved system: items (the flag, not a system)", JSON.stringify({ ...SAMPLE_ITEM, identity: { system: "items", key: "k" } }), "identity.system", /pipeline's own sources/],
  ["an empty key", JSON.stringify({ ...SAMPLE_ITEM, identity: { system: "chatgpt", key: " " } }), "identity.key", /non-empty/],
  ["a padded key", JSON.stringify({ ...SAMPLE_ITEM, identity: { system: "chatgpt", key: " k " } }), "identity.key", /whitespace/],
  ["a key past IDENTITY_MAX", JSON.stringify({ ...SAMPLE_ITEM, identity: { system: "chatgpt", key: "k".repeat(IDENTITY_MAX + 1) } }), "identity.key", new RegExp(`${IDENTITY_MAX + 1} characters`)],
  ["an empty scope", JSON.stringify({ ...SAMPLE_ITEM, scope: "" }), "scope", /non-empty/],
  ["a whitespace scope", JSON.stringify({ ...SAMPLE_ITEM, scope: "  " }), "scope", /non-empty/],
  ["a padded scope", JSON.stringify({ ...SAMPLE_ITEM, scope: " chatgpt:export " }), "scope", /surrounding whitespace/],
  ["a scope with a slash", JSON.stringify({ ...SAMPLE_ITEM, scope: "chatgpt/export" }), "scope", /reads as a path/],
  ["a scope with a comma", JSON.stringify({ ...SAMPLE_ITEM, scope: "chatgpt,export" }), "scope", /separator/],
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
  ["createdAt a number", JSON.stringify({ ...SAMPLE_ITEM, createdAt: 1700000000 }), "createdAt", /ISO-8601 instant/],
  ["watermark not an object", JSON.stringify({ ...SAMPLE_ITEM, watermark: "2026" }), "watermark", /\{key, value, asOf\?\}/],
  ["a watermark with no value", JSON.stringify({ ...SAMPLE_ITEM, watermark: { key: "k" } }), "watermark.value", /sorts as it orders/],
  ["a watermark under the pipeline's key", JSON.stringify({ ...SAMPLE_ITEM, watermark: { key: "source", value: "v" } }), "watermark.key", /pipeline's own metadata key/],
  ["a watermark asOf that is not an instant", JSON.stringify({ ...SAMPLE_ITEM, watermark: { key: "k", value: "v", asOf: "yesterday" } }), "watermark.asOf", /ISO-8601 instant/],
  ["a NUL in the text", JSON.stringify({ ...SAMPLE_ITEM, text: "a\u0000b" }), "text", /NUL/],
  ["a NUL in the form", JSON.stringify({ ...SAMPLE_ITEM, canonical: { form: "a\u0000b", mediaType: "text/plain" } }), "canonical.form", /NUL/],
  ["a lone surrogate in a facet", "{" + SAMPLE_LINE.slice(1).replace("\"title\":\"Postgres pooling\"", "\"title\":\"\\ud800 pooling\""), "facets.title", /lone surrogate/],
  ["a NUL in a facet key", JSON.stringify({ ...SAMPLE_ITEM, facets: { "a\u0000b": 1 } }), "facets.a\u0000b", /NUL/],
  ["a NUL in a link target", JSON.stringify({ ...SAMPLE_ITEM, links: [{ relation: "references", target: "a\u0000b" }] }), "links[0].target", /NUL/],
  ["a lone surrogate in a facets array", "{" + JSON.stringify({ ...SAMPLE_ITEM, facets: { tags: ["ok", "LONE pooling"] } }).slice(1).replace("\"LONE pooling\"", "\"\\ud800 pooling\""), "facets.tags[1]", /lone surrogate/],
  ["a NUL in a mention name", JSON.stringify({ ...SAMPLE_ITEM, mentions: [{ name: "a\u0000b", type: "topic" }] }), "mentions[0].name", /NUL/],
  ["a BOM inside a line", `${BOM}${SAMPLE_LINE}`, "(line)", /byte-order mark/],
  ["createdAt in year 0", JSON.stringify({ ...SAMPLE_ITEM, createdAt: "0000-01-01T00:00:00Z" }), "createdAt", /ISO-8601 instant/],
  ["createdAt with an offset past 15 hours", JSON.stringify({ ...SAMPLE_ITEM, createdAt: "2026-09-25T10:00:00+16:00" }), "createdAt", /ISO-8601 instant/],
  ["a facet nested past any stack", `{"identity":{"system":"chatgpt","key":"deep"},"scope":"s:x","canonical":{"form":"f","mediaType":"text/plain"},"text":"t","links":[],"mentions":[],"facets":{"a":${"[".repeat(200000)}${"]".repeat(200000)}}}`, "(line)", /nested too deeply/],
  ["a facet nested to the bound exactly", `{"identity":{"system":"chatgpt","key":"deep"},"scope":"s:x","canonical":{"form":"f","mediaType":"text/plain"},"text":"t","links":[],"mentions":[],"facets":{"a":${"[".repeat(DEPTH_MAX - 1)}${"]".repeat(DEPTH_MAX - 1)}}}`, "(line)", /level 64 or below/],
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
  const nulls = parseItem({ ...SAMPLE_ITEM, createdAt: null, watermark: null }, 1).item;
  ok(nulls.createdAt === undefined && nulls.watermark === undefined && !("createdAt" in nulls) && !("watermark" in nulls), "createdAt: null and watermark: null are absent — what a Python emitter writes for None");
  ok(parseItem({ ...SAMPLE_ITEM, watermark: { key: "k", value: "v", asOf: null } }, 1).item.watermark?.asOf === undefined, "…and asOf: null too");
  const norm = parseItem({ ...SAMPLE_ITEM, links: [{ relation: "references", target: "conv-8f3a" }, { relation: "references", target: "b" }, { relation: "references", target: "b" }, { relation: "blocks", target: " " }] }, 1);
  ok(norm.item.links.length === 1 && norm.linksDropped === 3, `normaliseLinks: the self link, the duplicate and the empty target are set aside and counted (${norm.linksDropped})`);
  ok(parseItem({ ...SAMPLE_ITEM, mentions: [{ name: " PostgreSQL ", type: "tool" }, { name: "postgresql", type: "tool" }] }, 1).item.mentions.length === 1, "normaliseMentions: trimmed, one per (type, name) folded by case");
  ok(parseItem({ ...SAMPLE_ITEM, watermark: { key: "k", value: "v", asOf: "2026-09-03T00:00:00+02:00" } }, 1).item.watermark?.asOf === "2026-09-03T00:00:00+02:00", "an asOf with an offset is an instant");
  ok(parseItem({ ...SAMPLE_ITEM, facets: { source: "elsewhere" } }, 1).item.facets.source === "elsewhere", "a facets.source is carried as given — the pipeline overwrites it with the system (ingest-contract.ts)");
  ok(parseItem({ ...SAMPLE_ITEM, scope: "chatgpt:export:2026/09".replace("/", "-") }, 1).item.scope === "chatgpt:export:2026-09", "a scope spelled with colons and dashes passes");
  // The line's object is level 0 and `facets` level 1, so k brackets under facets.a put the innermost at level k + 1: 62 reach level 63 and pass, 63 reach level 64 and are refused (the fixture above).
  const deepOk = { ...SAMPLE_ITEM, facets: JSON.parse(`{"a":${"[".repeat(DEPTH_MAX - 2)}1${"]".repeat(DEPTH_MAX - 2)}}`) };
  ok(parseItem(deepOk, 1).item.facets !== undefined, `a line whose deepest value is at level ${DEPTH_MAX - 1} passes; level ${DEPTH_MAX} is refused`);
  ok(parseItem({ ...SAMPLE_ITEM, mentions: [{ name: "n".repeat(MENTION_NAME_MAX), type: "topic" }], identity: { system: "chatgpt", key: "k".repeat(IDENTITY_MAX) } }, 1).item.identity.key.length === IDENTITY_MAX, `a name of exactly ${MENTION_NAME_MAX} and a key of exactly ${IDENTITY_MAX} pass — the bounds are inclusive`);

  // Each malformed kind: refused, on the line given, naming the field. The
  // first line is another identity, so a rule mutated away fails on ITS
  // field, never as a duplicate of line 1.
  for (const [label, line, field, reason] of MALFORMED) {
    let got: ItemsRefusal | null = null;
    try { parseItems(`${OTHER_LINE}\n${line}\n`, "x.jsonl"); }
    catch (e) { if (e instanceof ItemsRefusal) got = e; else throw e; }
    ok(got !== null && got.line === 2 && got.field === field && reason.test(got.reason) && got.message.startsWith(`x.jsonl: line 2: ${field}: `), `${label}: refused on line 2 naming ${JSON.stringify(field)} (${got ? `${got.line} ${JSON.stringify(got.field)}: ${got.reason.slice(0, 60)}` : "not refused"})`);
  }

  // The file: order kept, blank lines skipped without shifting numbers, the systems counted, duplicates refused together.
  const two = parseItems(`\n${SAMPLE_LINE}\n\n${JSON.stringify({ ...SAMPLE_ITEM, identity: { system: "readwise", key: "h-1" } })}\n`, "x.jsonl");
  ok(two.items.length === 2 && two.lines.join(",") === "2,4" && two.systems.chatgpt === 1 && two.systems.readwise === 1, `two items on lines 2 and 4 (blank lines skipped, numbers the file's), one per system (${two.lines.join(",")})`);
  ok(parseItems("").items.length === 0 && parseItems("\n\n").items.length === 0 && parseItems(new Uint8Array(0)).items.length === 0, "an empty file is zero items, not a refusal — as text or as bytes");
  const crlf = parseItems(`${SAMPLE_LINE}\r\n${OTHER_LINE}\r\n`, "x.jsonl");
  ok(crlf.items.length === 2 && crlf.lines.join(",") === "1,2" && crlf.items[1].text === "Another conversation's summary.", "CRLF line endings are lines, the \\r not part of the line (as text)");
  const crlfBytes = parseItems(new TextEncoder().encode(`${SAMPLE_LINE}\r\n${OTHER_LINE}\r\n`), "x.jsonl");
  ok(crlfBytes.items.length === 2 && crlfBytes.lines.join(",") === "1,2" && crlfBytes.items[0].canonical.form === SAMPLE_ITEM.canonical.form, "…and as bytes, the canonical byte for byte");
  ok(parseItems(`${BOM}${SAMPLE_LINE}\n`).items.length === 1 && parseItems(new TextEncoder().encode(`${BOM}${SAMPLE_LINE}\n`)).items.length === 1, "a byte-order mark before the first line is dropped, as text or as bytes");
  const unterminated = parseItems(new TextEncoder().encode(`${SAMPLE_LINE}\n${OTHER_LINE}`), "x.jsonl");
  ok(unterminated.items.length === 2 && unterminated.lines.join(",") === "1,2", "a bytes file with no trailing newline keeps its last line (second review pass: the mutant that lost it survived)");
  let lastBad: ItemsRefusal | null = null;
  try { parseItems(new TextEncoder().encode(`${SAMPLE_LINE}\n{oops`), "x.jsonl"); } catch (e) { if (e instanceof ItemsRefusal) lastBad = e; else throw e; }
  ok(lastBad?.line === 2 && /not JSON/.test(lastBad.reason), "…and a bad unterminated last line is refused as line 2");
  let utf16: ItemsRefusal | null = null;
  try { parseItems(new Uint8Array([0xff, 0xfe, 0x7b, 0x00, 0x7d, 0x00, 0x0a, 0x00]), "x.jsonl"); } catch (e) { if (e instanceof ItemsRefusal) utf16 = e; else throw e; }
  ok(utf16?.line === 1 && /UTF-16/.test(utf16.reason), "a UTF-16 file is named as such, not as a NUL byte");
  let dup: ItemsRefusal | null = null;
  try { parseItems(`${SAMPLE_LINE}\n${JSON.stringify({ ...SAMPLE_ITEM, text: "another text" })}\n`, "x.jsonl"); }
  catch (e) { if (e instanceof ItemsRefusal) dup = e; else throw e; }
  ok(dup?.line === 2 && dup.field === "identity" && /line 1's too/.test(dup.reason), `two lines of one identity are refused, the second naming the first (${dup?.reason.slice(0, 50)})`);
  ok(parseItems(`${SAMPLE_LINE}\n${JSON.stringify({ ...SAMPLE_ITEM, identity: { system: "other", key: "conv-8f3a" } })}\n`).items.length === 2, "…the same key under another system is another identity");
  ok(parseItems(`${JSON.stringify({ ...SAMPLE_ITEM, identity: { system: "ab", key: "c" } })}\n${JSON.stringify({ ...SAMPLE_ITEM, identity: { system: "a", key: "bc" } })}\n`).items.length === 2, "…and (ab, c) is not (a, bc): the identity key has a separator");
  let third: ItemsRefusal | null = null;
  try { parseItems(`${SAMPLE_LINE}\n${JSON.stringify({ ...SAMPLE_ITEM, identity: { system: "chatgpt", key: "k2" } })}\n{oops\n`, "--items x.jsonl"); }
  catch (e) { if (e instanceof ItemsRefusal) third = e; else throw e; }
  ok(third?.line === 3 && third.message === "--items x.jsonl: line 3: (line): " + third.reason, `a bad third line refuses the file naming line 3, in the flag's own words (${third?.message.slice(0, 40)})`);
  // Bytes that are not UTF-8, or a NUL byte: refused with the line, never repaired to U+FFFD.
  const badBytes = new Uint8Array([...new TextEncoder().encode(`${SAMPLE_LINE}\n`), 0x7b, 0x22, 0xff, 0x22, 0x7d, 0x0a]);
  let notUtf8: ItemsRefusal | null = null;
  try { parseItems(badBytes, "x.jsonl"); } catch (e) { if (e instanceof ItemsRefusal) notUtf8 = e; else throw e; }
  ok(notUtf8?.line === 2 && notUtf8.field === "(line)" && /not valid UTF-8/.test(notUtf8.reason), `a byte that is not UTF-8 refuses its line rather than becoming U+FFFD (${notUtf8?.reason.slice(0, 40)})`);
  let nulByte: ItemsRefusal | null = null;
  try { parseItems(new TextEncoder().encode(`${SAMPLE_LINE}\n{"a":"b\u0000c"}\n`), "x.jsonl"); } catch (e) { if (e instanceof ItemsRefusal) nulByte = e; else throw e; }
  ok(nulByte?.line === 2 && /NUL/.test(nulByte.reason), "a raw NUL byte refuses its line");

  // The instant rule.
  ok(isInstant("2026-09-25T10:00:00Z") && isInstant("2026-09-25T10:00Z") && isInstant("2026-09-25T10:00:00.123456789+05:30") && isInstant("2026-02-28T23:59:59-00:00") && isInstant("0042-01-01T00:00:00Z"), "instants: seconds and fraction optional, Z or ±hh:mm, a year under 100 as itself");
  ok(!isInstant("2026-09-25") && !isInstant("2026-09-25T10:00:00") && !isInstant("2026-02-30T00:00:00Z") && !isInstant("2026-13-01T00:00:00Z") && !isInstant("2026-09-25T24:00:00Z") && !isInstant("2026-09-25T10:60:00Z") && !isInstant("2026-09-25T10:00:60Z") && !isInstant("2026-09-25T10:00:00.1234567890Z") && !isInstant("2026-09-25T10:00:00+16:00") && !isInstant("2026-09-25T10:00:00+24:00") && !isInstant("0000-01-01T00:00:00Z") && !isInstant(" 2026-09-25T10:00:00Z"), "not instants: a bare date, no offset, February the 30th, month 13, hour 24, minute 60, second 60, a ten-digit fraction, offset 16 and 24, year 0, a leading space");
  ok(isInstant("2026-09-25T10:00:00+15:59") && isInstant("0001-01-01T00:00:00Z"), "…and offset 15:59 and year 1 are the bounds' last accepted values");
  ok(unstorable("plain") === null && /NUL/.test(unstorable("a\u0000b") ?? "") && /surrogate/.test(unstorable("a\ud800") ?? "") && unstorable("😀") === null, "unstorable: NUL and a lone surrogate, and a paired surrogate is fine");

  if (bad === 0) console.log("ingest-items.ts self-check PASS");
  return bad === 0 ? 0 : 1;
}

if (import.meta.main) {
  if (process.argv.includes("--self-check")) process.exit(selfCheck());
  console.error("ingest-items.ts is a library — the file adapter for db/ingest-records.ts --items. `--self-check` runs its pure rules.");
  process.exit(2);
}
