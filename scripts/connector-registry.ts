#!/usr/bin/env bun
/**
 * connector-registry.ts — read, validate and render docs/connector-registry.json,
 * the connector taxonomy's one machine-readable source (SMD-1933).
 *
 * The taxonomy classifies every artifact that touches an external system by
 * five facets — family × transport × direction × cardinality × round-trip — per
 * capability, and collapses the artifacts into one connector per vendor whose
 * direction (source / sink / bidirectional) is DERIVED from its capabilities,
 * never declared twice. docs/connector-taxonomy.md is the spec; the family
 * schemas and the two tables it carries between marker comments are rendered
 * from the registry by this file, so the prose and the data cannot drift.
 *
 *   bun scripts/connector-registry.ts            # rewrite the generated block in the spec
 *   bun scripts/connector-registry.ts --check    # print the problems, exit 1 on any
 *
 * check-fork-consistency.ts (check 19) runs registryProblems() over the real
 * tree and holds the rendered block equal to the committed one. Two rules
 * bite. The declaration: a classified artifact's metadata.json `connectors`
 * equals the vendors its capabilities name, and a contribution that declares
 * one is classified. The net under it, for a contribution that declared
 * nothing: a service no not-a-connector pattern covers, a connector-shaped
 * tag or a connector's name as a tag, or a fold-in row of the SMD-1924
 * disposition table marks it, and a marked contribution is classified here or
 * excused here by name with its reason — so a new vendored connector cannot
 * land unclassified.
 */
import { readFileSync, writeFileSync, existsSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { CATEGORIES, NOT_CONTRIBUTIONS, contributionDirs } from "./contributions.ts";

export const REGISTRY_PATH = "docs/connector-registry.json";
export const SPEC_PATH = "docs/connector-taxonomy.md";
export const DISPOSITION_PATH = "docs/vendored-disposition.md";
export const START = "<!-- connector-tables:start — generated from docs/connector-registry.json by scripts/connector-registry.ts; do not edit by hand -->";
export const END = "<!-- connector-tables:end -->";

/**
 * The closed and near-closed sets, pinned here as well as in the registry: a
 * value off one of these is a spec change (the ticket's facet-stability rule),
 * so it edits this file and the registry together, and check 19 refuses a
 * registry that redefines a set on its own.
 */
export const FACET_SETS = {
  direction: { stability: "closed", values: ["source", "sink"] },
  round_trip: { stability: "closed", values: ["read-only", "writable"] },
  transport: { stability: "near-closed", values: ["push", "pull", "batch"] },
  cardinality: { stability: "near-closed", values: ["1:1", "1:many", "many:1"] },
};
export const FETCHERS = ["low-code-node", "native-driver", "mcp-server", "browser-extension"];
export const CONNECTOR_DIRECTIONS = ["source", "sink", "bidirectional"];
/** The five facets a capability names, plus its fetcher; `note` is the only optional key. */
export const CAPABILITY_KEYS = ["vendor", "family", "transport", "direction", "cardinality", "round_trip", "fetcher"];
/** A family's schema: what the seam needs from a fetcher, and how the brain projects it (SMD-1867's five outputs). */
export const FAMILY_TEXT_FIELDS = ["item", "grouping_key", "canonical", "text", "identity", "dividing_line"];
export const FAMILY_LIST_FIELDS = ["edges", "metadata", "typical_transport"];
/**
 * A metadata.json tag that says "this touches an external system" until the
 * registry or an excuse says otherwise — the net under the `connectors` field
 * for a contribution that never declared one. The brain's own vocabulary
 * (`capture`, `export`, `sync`) is not here: it marked backups and skills over
 * the MCP surface and grew the excuse list for nothing.
 */
export const TRIGGER_TAGS = ["import", "digest", "webhook", "messaging", "email", "bot"];
/**
 * A disposition row folds into SMD-1867 when its Disposition CELL says so with
 * the table's arrow — "→ fold-in **SMD-1867**" or "→ SMD-1867 candidate"; a
 * cell that recounts ("remove — was the SMD-1867 candidate") and the
 * Justification cell ("not an SMD-1867 adapter") are prose and are not read.
 */
export const FOLD_IN_RE = /→ (?:fold-in \*\*SMD-1867\*\*|SMD-1867 candidate)/;
/** A vendor key. The same pattern the metadata schema gives `connectors` items — check 19 holds the two equal. */
export const VENDOR_PATTERN = "^[a-z0-9]+(-[a-z0-9]+)*$";
const VENDOR = new RegExp(VENDOR_PATTERN);
/** A registry path is a contribution directory: any name the walk admits (contributions.ts), under one of the categories. */
const PATH = new RegExp(`^(?:${CATEGORIES.join("|")})/[^/]+$`);
/**
 * The words that may precede a provider and still leave the string a provider's:
 * "Any OpenAI-compatible gateway", "Optional: OpenRouter (…)", "Local Ollama".
 * A vendor's name is not one of them, so "Notion OpenRouter" names a vendor.
 */
export const QUALIFIERS = ["any", "an", "a", "the", "optional", "optionally", "local", "self-hosted", "hosted", "your", "own"];

const sameSet = (a, b) => Array.isArray(a) && a.length === b.length && [...a].sort().join("\u0000") === [...b].sort().join("\u0000");
const nonEmpty = (v) => typeof v === "string" && v.trim().length > 0;
const listOf = (v) => (Array.isArray(v) ? v : []);
const artifactsOf = (registry) => listOf(registry?.artifacts);
/** The vendors an artifact's capabilities name, once each, sorted. */
const registryVendors = (a) => [...new Set(listOf(a?.capabilities).map((c) => c?.vendor).filter(nonEmpty))].sort();

export function readRegistry(root) {
  return JSON.parse(readFileSync(join(root, REGISTRY_PATH), "utf8"));
}

/**
 * The contribution paths the SMD-1924 disposition table folds into SMD-1867: a
 * `| \`name\` | <disposition> |` row whose Disposition cell carries the fold-in
 * marker (FOLD_IN_RE), under a `### \`category/\`` heading for one of the
 * contribution categories (`### \`docs/drafts/\`` is not one). Any other
 * heading ends the table's context, so a `## Notes` or `### Removals` appended
 * below it names nothing.
 */
export function dispositionPaths(text) {
  const out = [];
  let cat = null;
  let fenced = false;
  for (const line of text.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; continue; } // a `# comment` inside a fenced example is not a heading
    if (fenced) continue;
    if (/^#{1,6}\s/.test(line)) {
      const h = /^###\s+`([^`]+?)\/?`/.exec(line);
      cat = h && CATEGORIES.includes(h[1]) ? h[1] : null;
      continue;
    }
    if (!cat || !line.startsWith("|")) continue;
    const cells = line.split(/(?<!\\)\|/); // an escaped `\|` stays inside its cell
    const name = /^\s*`([^`]+)`\s*$/.exec(cells[1] ?? "");
    if (name && FOLD_IN_RE.test(cells[2] ?? "")) out.push(`${cat}/${name[1]}`);
  }
  return out;
}

/**
 * The metadata.json of every contribution that has one: parsed, or `null` when
 * the file does not parse — check 1 names that file, and the coverage rules
 * pass no verdict on a contribution whose metadata they cannot read.
 */
export function readMetadata(dirs) {
  const out = new Map();
  for (const d of dirs) {
    const file = join(d.dir, "metadata.json");
    if (!existsSync(file)) continue;
    try { out.set(d.rel, JSON.parse(readFileSync(file, "utf8"))); } catch { out.set(d.rel, null); }
  }
  return out;
}

/** The contributions on disk — one walk (scripts/contributions.ts) for the CLI and check 19. */
export function contributionsOnDisk(root) {
  const dirs = contributionDirs(root);
  return { existingDirs: dirs.map((d) => d.rel), metadataByPath: readMetadata(dirs) };
}

/**
 * One exec per pattern, two answers. `live`: the patterns that match the
 * service string anywhere (liveness, which the stale rule reads). `covering`:
 * the patterns whose match BEGINS the first or the second word — the ones that
 * explain the string: "OpenRouter or Anthropic", "Any OpenAI-compatible LLM
 * gateway (…)", "Optional: OpenRouter (…)" are a provider first and qualified
 * after; "Notion API (summaries via OpenRouter)", "Notion (OpenRouter)" and
 * "Gmail/OpenAI" name a vendor first and a provider after a bracket or a slash,
 * and are not covered — one external system per `requires.services` entry, the
 * system's name first.
 */
export function patternHits(service, patterns) {
  const words = [];
  for (const w of service.matchAll(/\S+/g)) { words.push(w); if (words.length === 2) break; }
  // A match begins word one; or begins word two when word one is a qualifier, not a name.
  const heads = new Set();
  if (words[0]) heads.add(words[0].index);
  if (words[1] && QUALIFIERS.includes(words[0][0].toLowerCase().replace(/[^a-z-]/g, ""))) heads.add(words[1].index);
  const live = [], covering = [];
  for (const p of patterns) {
    // Every match, not the leftmost: "Any OpenAI-compatible OpenAI gateway" hits at word two (a head) and again later.
    const hits = [...service.matchAll(p.re)];
    if (hits.length === 0) continue;
    live.push(p);
    if (hits.some((h) => heads.has(h.index))) covering.push(p);
  }
  return { live, covering };
}

/**
 * Compile not_connectors.services; a pattern that does not compile is reported,
 * not thrown, and a missing or empty pattern is refused — `new RegExp("")`
 * matches every service and would excuse the whole tree in silence.
 */
function servicePatterns(registry, problems) {
  const out = [];
  for (const [i, p] of listOf(registry.not_connectors?.services).entries()) {
    const where = `${REGISTRY_PATH} not_connectors.services[${i}]`;
    if (!nonEmpty(p?.reason)) problems.push({ where, kind: "pattern-reason", msg: "a service pattern carries no reason" });
    if (!nonEmpty(p?.pattern)) { problems.push({ where, kind: "pattern-invalid", msg: "a service pattern is missing or empty — an empty pattern matches every service" }); continue; }
    let re;
    try { re = new RegExp(p.pattern, "gi"); } catch (e) { problems.push({ where, kind: "pattern-invalid", msg: `pattern ${JSON.stringify(p.pattern)} does not compile: ${e.message}` }); continue; } // "g" for matchAll; read only through patternHits
    // A pattern that matches the empty string — "openrouter|" (a one-character typo), ".*", "x?" — matches at index 0
    // of every service and would excuse the whole tree as quietly as an empty pattern would.
    if (new RegExp(p.pattern, "i").test("")) { problems.push({ where, kind: "pattern-invalid", msg: `pattern ${JSON.stringify(p.pattern)} matches the empty string, so it would cover every service — a trailing \`|\`, a \`.*\` or an optional-only body` }); continue; }
    out.push({ re, pattern: p.pattern, where });
  }
  return out;
}

/**
 * Why a contribution counts as external-touching, per path. The declaration
 * first: a non-empty `connectors` list in its metadata (the field the schema
 * carries for exactly this). Then the net under it, for a contribution that
 * never declared one: the services its metadata names that no not_connectors
 * pattern covers, the trigger tags it carries, a tag naming a declared
 * connector (so a recipe tagged `telegram` whose only service is a model
 * provider is still marked), and the fold-in SMD-1867 rows of the disposition
 * table whose directory exists (`existingDirs`; a row whose directory is gone
 * is registryProblems' finding, not a silent drop). Empty for a path nothing
 * marks. `patterns` is servicePatterns()'s output; every pattern a service
 * matches ANYWHERE is returned as live — liveness, which the stale rule reads,
 * is not coverage, which patternHits decides — so a pattern a broader one
 * shadows is still live. Tags compare lower-cased, as the patterns match
 * case-insensitively. A metadata that did not parse (`null`, check 1's
 * finding) marks nothing; one whose `services` or `tags` is not a list marks
 * nothing by them rather than throwing.
 */
export function triggersFor({ metadataByPath, foldIns, patterns, connectorKeys, existingDirs }) {
  const out = new Map();
  const livePatterns = new Set(); // returned, not written onto the caller's objects: the stale rule reads it
  const add = (path, why) => out.set(path, [...(out.get(path) ?? []), why]);
  for (const [path, meta] of metadataByPath) {
    if (meta === null) continue;
    const declared = listOf(meta?.connectors).filter((c) => typeof c === "string");
    if (declared.length) add(path, `declares connectors: [${declared.join(", ")}]`);
    for (const s of listOf(meta?.requires?.services)) {
      if (typeof s !== "string") continue;
      const { live, covering } = patternHits(s, patterns);
      for (const p of live) livePatterns.add(p);
      if (covering.length === 0) add(path, `requires.services names ${JSON.stringify(s)}${live.length ? " (a not-a-connector pattern matches it, but not at its first or second word — one system per entry, its name first)" : ""}`);
    }
    const tags = listOf(meta?.tags).filter((t) => typeof t === "string").map((t) => t.toLowerCase());
    const shaped = tags.filter((t) => TRIGGER_TAGS.includes(t));
    if (shaped.length) add(path, `tagged ${shaped.join(", ")}`);
    const vendors = tags.filter((t) => connectorKeys.has(t) && !shaped.includes(t));
    if (vendors.length) add(path, `tagged with the connector name${vendors.length > 1 ? "s" : ""} ${vendors.join(", ")}`);
  }
  const dirs = new Set(existingDirs);
  // A fold-in row marks a directory that exists — unless its metadata is there and did not parse (null): no verdict, as above.
  for (const path of foldIns) if (dirs.has(path) && metadataByPath.has(path) && metadataByPath.get(path) !== null) add(path, `a fold-in SMD-1867 row of ${DISPOSITION_PATH}`);
  return { triggers: out, livePatterns };
}

/** The connectors the artifacts imply: vendor → { directions, capabilities: [{ path, ...cap }] }. */
export function derivedConnectors(registry) {
  const out = new Map();
  for (const a of artifactsOf(registry)) for (const c of listOf(a?.capabilities)) {
    if (!nonEmpty(c?.vendor)) continue;
    const v = out.get(c.vendor) ?? { directions: new Set(), capabilities: [] };
    if (FACET_SETS.direction.values.includes(c.direction)) v.directions.add(c.direction); // a typo is capability-value's finding, not a third direction
    v.capabilities.push({ path: a.path, ...c });
    out.set(c.vendor, v);
  }
  return out;
}
export const connectorDirection = (directions) => (directions.size === 2 ? "bidirectional" : [...directions][0] ?? null);

/**
 * What is wrong with a registry, as `{ where, kind, msg }` — nothing when it is
 * sound: the four pinned facet sets and the fetcher set as pinned; every family
 * with its schema, a reserved one used by no capability; every artifact a
 * directory that exists, listed once, with capabilities that name exactly the
 * five facets and a fetcher from the sets and a declared family; the connectors
 * exactly the vendors used, each with the direction its capabilities derive;
 * the declaration — every classified artifact's metadata `connectors` exactly
 * its vendors; and coverage — every marked contribution classified or excused,
 * never both, every excuse and every service pattern live, no pattern covering
 * a classified vendor's own service, the disposition table present and whole.
 */
export function registryProblems({ registry, existingDirs, metadataByPath, dispositionText }) {
  const problems = [];
  const push = (where, kind, msg) => problems.push({ where, kind, msg });
  const R = REGISTRY_PATH;
  if (!registry || typeof registry !== "object") { push(R, "shape", "not a JSON object"); return problems; }

  // ── the sets ──
  for (const [facet, pinned] of Object.entries(FACET_SETS)) {
    const f = registry.facets?.[facet];
    if (!f || !sameSet(f.values, pinned.values) || f.stability !== pinned.stability)
      push(`${R} facets.${facet}`, "facet-set", `must be the ${pinned.stability} set [${pinned.values.join(", ")}] — a different set is a spec change and edits scripts/connector-registry.ts's FACET_SETS too`);
  }
  if (registry.facets?.family?.values !== "families" || registry.facets?.family?.stability !== "open") push(`${R} facets.family`, "facet-set", "family is the open set whose values are the `families` block");
  for (const facet of Object.keys(registry.facets ?? {})) if (!(facet in FACET_SETS) && facet !== "family") push(`${R} facets.${facet}`, "facet-set", "a sixth facet is a spec change");
  if (!sameSet(Object.keys(registry.fetchers ?? {}), FETCHERS)) push(`${R} fetchers`, "fetcher-set", `must name exactly [${FETCHERS.join(", ")}]`);

  // ── the families ──
  const families = registry.families && typeof registry.families === "object" ? registry.families : {};
  if (Object.keys(families).length === 0) push(`${R} families`, "family-schema", "no families declared");
  for (const [name, fam] of Object.entries(families)) {
    const where = `${R} families["${name}"]`;
    if (fam?.reserved) {
      if (fam.direction !== "sink" || !nonEmpty(fam.note)) push(where, "family-schema", "a reserved family says `direction: sink` and carries a note on why it is held");
      continue;
    }
    for (const k of FAMILY_TEXT_FIELDS) if (!nonEmpty(fam?.[k])) push(where, "family-schema", `schema field \`${k}\` is missing or empty`);
    for (const k of FAMILY_LIST_FIELDS) if (!Array.isArray(fam?.[k]) || fam[k].length === 0 || !fam[k].every(nonEmpty)) push(where, "family-schema", `schema field \`${k}\` must be a non-empty list`);
    if (!FACET_SETS.cardinality.values.includes(fam?.default_cardinality)) push(where, "family-schema", `default_cardinality must be one of ${FACET_SETS.cardinality.values.join("|")}`);
    if (Array.isArray(fam?.typical_transport)) for (const t of fam.typical_transport) if (!FACET_SETS.transport.values.includes(t)) push(where, "family-schema", `typical_transport names ${JSON.stringify(t)}, not a transport`);
  }

  // ── the artifacts ──
  const seen = new Map();
  const dirs = new Set(existingDirs);
  if (registry.artifacts !== undefined && !Array.isArray(registry.artifacts)) push(`${R} artifacts`, "shape", "artifacts must be a list of { path, capabilities }, one entry per artifact");
  const artifacts = artifactsOf(registry);
  for (const a of artifacts) {
    const where = `${R} artifacts["${a?.path}"]`;
    if (!nonEmpty(a?.path) || !PATH.test(a.path)) { push(where, "artifact-path", `path must be <category>/<slug>, got ${JSON.stringify(a?.path)}`); continue; }
    const name = a.path.split("/")[1];
    if (NOT_CONTRIBUTIONS.includes(name)) { push(where, "artifact-path", `${name} is not a contribution — a placeholder, the shared auth module or an install — and cannot be classified`); continue; }
    if (seen.has(a.path)) push(where, "artifact-duplicate", "listed twice — one entry per artifact, with every capability under it");
    else seen.set(a.path, a); // the first entry is the one the declaration is judged against

    if (!dirs.has(a.path)) push(where, "artifact-missing", "no such contribution directory");
    if (!Array.isArray(a.capabilities) || a.capabilities.length === 0) { push(where, "capability-keys", "an artifact declares at least one capability"); continue; }
    const tuples = new Set();
    for (const [i, raw] of a.capabilities.entries()) {
      const cw = `${where}.capabilities[${i}]`;
      // A capability that is not an object (a bare "slack") is a keys finding, not a throw.
      const c = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
      if (c !== raw) push(cw, "capability-keys", `a capability is an object, got ${JSON.stringify(raw)}`);
      const keys = Object.keys(c);
      const missing = CAPABILITY_KEYS.filter((k) => !keys.includes(k));
      const extra = keys.filter((k) => !CAPABILITY_KEYS.includes(k) && k !== "note");
      if (missing.length || extra.length) push(cw, "capability-keys", `a capability names exactly ${CAPABILITY_KEYS.join(", ")} (and a note)${missing.length ? `; missing ${missing.join(", ")}` : ""}${extra.length ? `; extra ${extra.join(", ")}` : ""}`);
      for (const [facet, pinned] of Object.entries(FACET_SETS)) if (facet in c && !pinned.values.includes(c[facet])) push(cw, "capability-value", `${facet} ${JSON.stringify(c[facet])} is not one of ${pinned.values.join("|")}`);
      if ("fetcher" in c && !FETCHERS.includes(c.fetcher)) push(cw, "capability-value", `fetcher ${JSON.stringify(c.fetcher)} is not one of ${FETCHERS.join("|")}`);
      if ("vendor" in c && !VENDOR.test(String(c.vendor))) push(cw, "capability-value", `vendor ${JSON.stringify(c.vendor)} is not a kebab-case slug`);
      if ("family" in c) {
        if (!Object.hasOwn(families, c.family)) push(cw, "capability-family", `family ${JSON.stringify(c.family)} is not declared under families — a new family is declared with its schema first`);
        else if (families[c.family]?.reserved) push(cw, "reserved-used", `family ${JSON.stringify(c.family)} is reserved — dropping \`reserved\` is a spec change`);
      }
      const t = [c.vendor, c.family, c.transport, c.direction].join("|");
      if (tuples.has(t)) push(cw, "capability-duplicate", `repeats vendor/family/transport/direction ${t}`);
      tuples.add(t);
    }
  }

  // ── the connectors ──
  const derived = derivedConnectors(registry);
  const declared = registry.connectors && typeof registry.connectors === "object" ? registry.connectors : {};
  for (const v of derived.keys()) if (!Object.hasOwn(declared, v)) push(`${R} connectors`, "connector-set", `vendor "${v}" is used by a capability but has no connector entry`);
  for (const [v, c] of Object.entries(declared)) {
    const where = `${R} connectors["${v}"]`;
    if (!derived.has(v)) { push(where, "connector-set", "no capability names this vendor — a connector with no artifact is a stale entry"); continue; }
    if (!CONNECTOR_DIRECTIONS.includes(c?.direction)) push(where, "connector-direction", `direction must be one of ${CONNECTOR_DIRECTIONS.join("|")}`);
    const want = connectorDirection(derived.get(v).directions);
    if (want && c?.direction !== want) push(where, "connector-direction", `declares ${JSON.stringify(c?.direction)} but its capabilities derive "${want}" — direction is a capability of the vendor, derived from the artifacts, not a second declaration`);
  }

  // ── coverage ──
  const patterns = servicePatterns(registry, problems);
  const connectorKeys = new Set([...Object.keys(declared), ...derived.keys()]);
  // The table is a trigger that can go dark in silence — a heading level or a column moved yields no
  // rows and every current fold-in is also marked by its declaration — so a missing table and a table
  // that yields no fold-in are findings, not an empty list.
  let foldIns = [];
  if (typeof dispositionText !== "string") push(DISPOSITION_PATH, "disposition-missing", "the disposition table is missing — it is one of the coverage triggers");
  else {
    foldIns = dispositionPaths(dispositionText);
    if (foldIns.length === 0) push(DISPOSITION_PATH, "disposition-dark", "the table yields no fold-in SMD-1867 row — the category headings (`### \\`recipes/\\``) or the Disposition column moved, and the trigger went dark");
    else {
      // A partial darkening — one category's heading or column moved — leaves the others lit; the raw
      // marker count against the rows read says how many went dark.
      const raw = (dispositionText.match(new RegExp(FOLD_IN_RE.source, "g")) ?? []).length;
      if (raw !== foldIns.length) push(DISPOSITION_PATH, "disposition-dark", `${raw} fold-in markers in the text but ${foldIns.length} rows read — a heading, a column or a fence hides the rest`);
    }
  }
  for (const path of foldIns) if (!dirs.has(path)) push(`${DISPOSITION_PATH} (${path})`, "disposition-stale", "a fold-in SMD-1867 row names a contribution that no longer exists — the row marks nothing; note the removal in the table");
  const { triggers, livePatterns } = triggersFor({ metadataByPath, foldIns, patterns, connectorKeys, existingDirs: [...dirs] });
  const excused = registry.not_connectors?.artifacts && typeof registry.not_connectors.artifacts === "object" ? registry.not_connectors.artifacts : {};
  const readable = (path) => metadataByPath.has(path) && metadataByPath.get(path) !== null; // absent or unparseable: check 1's finding, no verdict here
  const declaredConnectors = (path) => listOf(metadataByPath.get(path)?.connectors).filter((c) => typeof c === "string").sort();
  for (const [path, why] of triggers) {
    const isReg = seen.has(path);
    const isEx = Object.hasOwn(excused, path);
    if (isReg && isEx) push(`${R} not_connectors.artifacts["${path}"]`, "coverage-both", "both classified and excused — one or the other");
    if (!isReg && !isEx) push(path, "coverage-unregistered", `touches an external system (${why.join("; ")}) and is neither classified in ${R} nor excused there by name with a reason — see ${SPEC_PATH}`);
  }
  // The declaration and the classification are one fact stated twice, held equal: a registered
  // artifact's metadata.json `connectors` is exactly the vendors its capabilities name.
  for (const [path, a] of seen) {
    if (!readable(path)) continue;
    const vendors = registryVendors(a);
    const declared = declaredConnectors(path);
    if (JSON.stringify(declared) !== JSON.stringify(vendors)) push(`${path}/metadata.json`, "connectors-field", `\`connectors\` is [${declared.join(", ")}] but ${R} classifies this artifact under [${vendors.join(", ")}] — declare exactly its connectors`);
  }
  for (const [path, reason] of Object.entries(excused)) {
    const where = `${R} not_connectors.artifacts["${path}"]`;
    if (!nonEmpty(reason)) push(where, "excuse-reason", "an excuse carries its reason");
    // Existence is the directory's; a directory with no metadata.json is check 1's finding, and its excuse waits.
    if (!dirs.has(path)) push(where, "excuse-stale", "no such contribution — drop the excuse");
    else if (readable(path) && !triggers.has(path)) push(where, "excuse-stale", "nothing marks this artifact as external-touching any more — drop the excuse");
    else if (readable(path) && declaredConnectors(path).length) push(where, "excuse-declares", `excused as no connector, yet its metadata.json declares connectors [${declaredConnectors(path).join(", ")}] — classify it or drop the declaration`);
  }
  for (const p of patterns) if (!livePatterns.has(p)) push(p.where, "pattern-stale", `pattern ${JSON.stringify(p.pattern)} matches no service in the tree — drop it`);
  // The positive control against an over-broad pattern ("open", "a"): the services that mark the registered
  // artifacts are the vendors' own names, and no pattern may cover one of them.
  for (const [path] of seen) {
    if (!readable(path)) continue;
    for (const s of listOf(metadataByPath.get(path)?.requires?.services)) {
      if (typeof s !== "string") continue;
      const { covering } = patternHits(s, patterns);
      for (const p of covering) {
        const first = (s.match(/\S+/) ?? [""])[0].toLowerCase();
        if (registryVendors(seen.get(path)).some((v) => first.startsWith(v.split("-")[0]))) push(p.where, "pattern-broad", `pattern ${JSON.stringify(p.pattern)} covers ${JSON.stringify(s)}, a classified vendor's own service on ${path} — too broad to be a not-a-connector`);
      }
    }
  }

  return problems;
}

const cell = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");

/**
 * The generated part of the spec: the family schemas, one connector per vendor
 * with its derived direction, and one row per capability — all from the
 * registry, so the prose around them can be edited and the data cannot drift.
 */
export function renderClassification(registry) {
  const derived = derivedConnectors(registry);
  const vendors = [...derived.keys()].sort();
  const rows = artifactsOf(registry).flatMap((a) => listOf(a?.capabilities).map((c) => ({ path: a.path, ...c })));
  const bidi = vendors.filter((v) => derived.get(v).directions.size === 2).length;
  const families = registry.families && typeof registry.families === "object" ? registry.families : {};
  const inUse = new Set(rows.map((r) => r.family));
  const lines = [];
  lines.push(`${artifactsOf(registry).length} artifacts, ${rows.length} capability rows, ${vendors.length} connectors (${bidi} bidirectional: ${vendors.filter((v) => derived.get(v).directions.size === 2).map((v) => `\`${v}\``).join(", ") || "none"}), ${inUse.size} of ${Object.keys(families).filter((f) => !families[f]?.reserved).length} declared families in use.`);
  lines.push("");
  lines.push(`Coverage net — the connector-shaped tags that mark an undeclared contribution: ${TRIGGER_TAGS.map((t) => `\`${t}\``).join(", ")}; a declared connector's name as a tag marks it too.`);
  lines.push("");
  lines.push("### Family schemas");
  lines.push("");
  lines.push("What a fetcher of any kind hands the seam (the **canonical**), and how the brain projects it into SMD-1867's five outputs. The item, the grouping key and the identity rule are the family's, never the fetcher's.");
  for (const [name, f] of Object.entries(families)) {
    lines.push("");
    lines.push(`#### \`${name}\`${f.reserved ? " (reserved, sink only)" : ""}`);
    lines.push("");
    if (f.reserved) {
      lines.push(`- **Item.** ${cell(f.item)}`);
      lines.push(`- **Status.** ${cell(f.note)}`);
      continue;
    }
    const instances = rows.filter((r) => r.family === name);
    const vendorsOf = [...new Set(instances.map((r) => r.vendor))].sort();
    lines.push(`- **Item.** ${cell(f.item)} · default cardinality \`${f.default_cardinality}\` · typical transport ${f.typical_transport.map((t) => `\`${t}\``).join(", ")}`);
    lines.push(`- **Grouping key.** ${cell(f.grouping_key)}`);
    lines.push(`- **Canonical.** ${cell(f.canonical)}`);
    lines.push(`- **Text.** ${cell(f.text)}`);
    lines.push(`- **Edges.** ${f.edges.map(cell).join("; ")}`);
    lines.push(`- **Metadata.** ${f.metadata.map((m) => `\`${cell(m)}\``).join(", ")}`);
    lines.push(`- **Identity.** ${cell(f.identity)}`);
    if (f.sink_shape) lines.push(`- **Sink shape.** ${cell(f.sink_shape)}`);
    lines.push(`- **Dividing line.** ${cell(f.dividing_line)}`);
    if (f.note) lines.push(`- **Note.** ${cell(f.note)}`);
    lines.push(`- **Instances today.** ${vendorsOf.length ? vendorsOf.map((v) => `\`${v}\``).join(", ") : "none"}`);
  }
  lines.push("");
  lines.push("### Connectors (one per vendor; direction derived from the capabilities)");
  lines.push("");
  lines.push("| Connector | Direction | Source capabilities | Sink capabilities |");
  lines.push("|---|---|---|---|");
  for (const v of vendors) {
    const d = derived.get(v);
    const side = (dir) => d.capabilities.filter((c) => c.direction === dir).map((c) => `\`${c.path}\` (${c.family} · ${c.transport} · ${c.fetcher})`).join("; ") || "—";
    lines.push(`| \`${v}\` | ${connectorDirection(d.directions)} | ${cell(side("source"))} | ${cell(side("sink"))} |`);
  }
  lines.push("");
  lines.push("### Capabilities (one row per artifact capability)");
  lines.push("");
  lines.push("| Artifact | Vendor | Family | Transport | Direction | Cardinality | Round-trip | Fetcher |");
  lines.push("|---|---|---|---|---|---|---|---|");
  for (const r of rows) lines.push(`| \`${r.path}\` | \`${r.vendor}\` | ${r.family} | ${r.transport} | ${r.direction} | ${r.cardinality} | ${r.round_trip} | ${r.fetcher} |`);
  return lines.join("\n");
}

/** The generated span of the spec: `{ before, block, after }`, or null when a marker is missing or doubled. */
export function tablesSpan(text) {
  const s = text.indexOf(START), e = text.indexOf(END);
  if (s < 0 || e < 0 || e < s || text.indexOf(START, s + 1) >= 0 || text.indexOf(END, e + 1) >= 0) return null;
  const from = s + START.length;
  return { before: text.slice(0, from), block: text.slice(from, e).replace(/^\n+|\n+$/g, ""), after: text.slice(e) };
}

function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const check = process.argv.includes("--check");
  const report = (problems) => { for (const p of problems) console.error(`  ${p.where}\n    ${p.msg}`); };
  // Every step reports in words and exits 1 — a raw stack trace names no `where`.
  const attempt = (where, fn) => { try { return fn(); } catch (e) { report([{ where, msg: e.message }]); process.exit(1); } };
  const registry = attempt(REGISTRY_PATH, () => readRegistry(root));
  const { existingDirs, metadataByPath } = attempt("the contribution directories", () => contributionsOnDisk(root));
  const problems = attempt(REGISTRY_PATH, () => registryProblems({
    registry,
    existingDirs,
    metadataByPath,
    dispositionText: existsSync(join(root, DISPOSITION_PATH)) ? readFileSync(join(root, DISPOSITION_PATH), "utf8") : null,
  }));
  const specFile = join(root, SPEC_PATH);
  const text = attempt(SPEC_PATH, () => readFileSync(specFile, "utf8"));
  const span = tablesSpan(text);
  if (!span) problems.push({ where: SPEC_PATH, kind: "spec-markers", msg: "the generated-tables markers are missing or doubled" });
  // The renderer assumes a sound registry: with findings above, the tables are neither rendered nor compared.
  if (problems.length) {
    report(problems);
    console.error(check ? `FAIL — ${problems.length} problem(s)` : `refusing to render: ${problems.length} problem(s) above, each at the file it names`);
    process.exit(1);
  }
  const rendered = attempt(REGISTRY_PATH, () => renderClassification(registry));
  if (check) {
    if (span.block !== rendered) { report([{ where: SPEC_PATH, msg: "the tables differ from what the registry renders — run `bun scripts/connector-registry.ts`" }]); console.error("FAIL — 1 problem(s)"); process.exit(1); }
    console.log("PASS — the connector registry is sound and the spec's tables are current.");
    return;
  }
  const next = `${span.before}\n${rendered}\n${span.after}`;
  if (next === text) { console.log(`${SPEC_PATH}: tables already current.`); return; }
  writeFileSync(specFile, next);
  console.log(`${SPEC_PATH}: tables rewritten from ${REGISTRY_PATH}.`);
}

// Run as a CLI only when this file is the entry: both sides realpath'd (a symlinked checkout), and an
// argv[1] that does not resolve (a REPL, an import) is "not the entry", not a crash — fork-index.ts's idiom.
const isMain = (() => { try { return Boolean(process.argv[1]) && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]); } catch { return false; } })();
if (isMain) main();
