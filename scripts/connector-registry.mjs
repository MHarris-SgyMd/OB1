#!/usr/bin/env node
/**
 * connector-registry.mjs — read, validate and render docs/connector-registry.json,
 * the connector taxonomy's one machine-readable source (SMD-1933).
 *
 * The taxonomy classifies every artifact that touches an external system by
 * five facets — family × transport × direction × cardinality × round-trip — per
 * capability, and collapses the artifacts into one connector per vendor whose
 * direction (source / sink / bidirectional) is DERIVED from its capabilities,
 * never declared twice. docs/connector-taxonomy.md is the spec; the two tables
 * it carries between marker comments are rendered from the registry by this
 * file, so the prose and the data cannot drift.
 *
 *   bun scripts/connector-registry.mjs            # rewrite the tables in the spec
 *   bun scripts/connector-registry.mjs --check    # print the problems, exit 1 on any
 *   node scripts/connector-registry.mjs           # the same; plain fs, no Bun API
 *
 * check-fork-consistency.mjs (check 18) runs registryProblems() over the real
 * tree and holds the rendered block equal to the committed one. The coverage
 * rule is the one that bites: an artifact whose metadata.json names a service
 * that is not a model provider, the hosting or the brain's own surface, or
 * carries a connector-shaped tag, or sits in an SMD-1867 row of the SMD-1924
 * disposition table, must be classified here or excused here by name with its
 * reason — so a new vendored connector cannot land unclassified, and a
 * registry entry nothing marks as external-touching is refused too.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export const REGISTRY_PATH = "docs/connector-registry.json";
export const SPEC_PATH = "docs/connector-taxonomy.md";
export const DISPOSITION_PATH = "docs/vendored-disposition.md";
export const START = "<!-- connector-tables:start — generated from docs/connector-registry.json by scripts/connector-registry.mjs; do not edit by hand -->";
export const END = "<!-- connector-tables:end -->";

/**
 * The closed and near-closed sets, pinned here as well as in the registry: a
 * value off one of these is a spec change (the ticket's facet-stability rule),
 * so it edits this file and the registry together, and check 18 refuses a
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
/** A metadata.json tag that says "this touches an external system" until the registry or an excuse says otherwise. */
export const TRIGGER_TAGS = ["import", "capture", "digest", "webhook", "export", "sync", "messaging", "email", "bot"];
export const CATEGORIES = ["recipes", "schemas", "dashboards", "integrations", "skills", "primitives", "extensions"];
const VENDOR = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PATH = new RegExp(`^(?:${CATEGORIES.join("|")})/[a-z0-9]+(?:-[a-z0-9]+)*$`);

const sameSet = (a, b) => Array.isArray(a) && a.length === b.length && [...a].sort().join("\u0000") === [...b].sort().join("\u0000");
const nonEmpty = (v) => typeof v === "string" && v.trim().length > 0;

export function readRegistry(root) {
  return JSON.parse(readFileSync(join(root, REGISTRY_PATH), "utf8"));
}

/** The contribution paths the SMD-1924 disposition table folds into SMD-1867 — a `| \`name\` |` row under a `### \`category/\`` heading that names the ticket. */
export function dispositionPaths(text) {
  const out = [];
  let cat = null;
  for (const line of text.split("\n")) {
    const h = /^###\s+`([^`]+?)\/?`/.exec(line);
    if (h) { cat = h[1]; continue; }
    const row = /^\|\s*`([^`]+)`\s*\|/.exec(line);
    if (row && cat && line.includes("SMD-1867")) out.push(`${cat}/${row[1]}`);
  }
  return out;
}

/**
 * The contributions on disk, with the skip rules check-fork's contributionDirs
 * applies (`_template`, `_shared`, `node_modules` are not contributions; any
 * other directory is one, metadata.json or not): `existingDirs` is every
 * contribution path, `metadataByPath` the parsed metadata of those that have one.
 */
export function contributionsOnDisk(root) {
  const existingDirs = [];
  const metadataByPath = new Map();
  for (const cat of CATEGORIES) {
    const base = join(root, cat);
    if (!existsSync(base)) continue;
    for (const name of readdirSync(base).sort()) {
      if (name === "_template" || name === "_shared" || name === "node_modules") continue;
      const dir = join(base, name);
      if (!statSync(dir).isDirectory()) continue;
      const rel = `${cat}/${name}`;
      existingDirs.push(rel);
      const file = join(dir, "metadata.json");
      if (!existsSync(file)) continue;
      try { metadataByPath.set(rel, JSON.parse(readFileSync(file, "utf8"))); } catch { metadataByPath.set(rel, {}); }
    }
  }
  return { existingDirs, metadataByPath };
}

const listOf = (v) => (Array.isArray(v) ? v : []);
const artifactsOf = (registry) => listOf(registry?.artifacts);

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
    try { out.push({ re: new RegExp(p.pattern, "i"), pattern: p.pattern, hits: 0, where }); } catch (e) { problems.push({ where, kind: "pattern-invalid", msg: `pattern ${JSON.stringify(p.pattern)} does not compile: ${e.message}` }); }
  }
  return out;
}

/**
 * Why a contribution counts as external-touching, per path: the services its
 * metadata names that no not_connectors pattern covers, the trigger tags it
 * carries, a tag naming a declared connector (the vendor's own name — so a
 * recipe tagged `telegram` whose only service is a model provider is still
 * marked), and the SMD-1867 rows of the disposition table. Empty for a path
 * nothing marks. `patterns` is servicePatterns()'s output; every pattern a
 * service matches is counted on it, so a pattern a broader one shadows is still
 * live and a pattern nothing matches can be reported stale. A metadata whose
 * `services` or `tags` is not a list (check 1's finding) marks nothing here
 * rather than throwing.
 */
export function triggersFor({ metadataByPath, dispositionPaths: disp, patterns, connectorKeys = new Set() }) {
  const out = new Map();
  const add = (path, why) => out.set(path, [...(out.get(path) ?? []), why]);
  for (const [path, meta] of metadataByPath) {
    for (const s of listOf(meta?.requires?.services)) {
      if (typeof s !== "string") continue;
      const hits = patterns.filter((p) => p.re.test(s));
      if (hits.length) for (const p of hits) p.hits++; else add(path, `requires.services names ${JSON.stringify(s)}`);
    }
    const tags = listOf(meta?.tags).filter((t) => typeof t === "string");
    const shaped = tags.filter((t) => TRIGGER_TAGS.includes(t));
    if (shaped.length) add(path, `tagged ${shaped.join(", ")}`);
    const vendors = tags.filter((t) => connectorKeys.has(t) && !shaped.includes(t));
    if (vendors.length) add(path, `tagged with the connector name${vendors.length > 1 ? "s" : ""} ${vendors.join(", ")}`);
  }
  for (const path of disp) if (metadataByPath.has(path)) add(path, `an SMD-1867 row of ${DISPOSITION_PATH}`);
  return out;
}

/** The connectors the artifacts imply: vendor → { directions, capabilities: [{ path, ...cap }] }. */
export function derivedConnectors(registry) {
  const out = new Map();
  for (const a of artifactsOf(registry)) for (const c of listOf(a?.capabilities)) {
    if (!nonEmpty(c?.vendor)) continue;
    const v = out.get(c.vendor) ?? { directions: new Set(), capabilities: [] };
    if (nonEmpty(c.direction)) v.directions.add(c.direction);
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
 * and coverage — every external-touching contribution registered or excused,
 * never both, every registered one marked by something, every excuse and every
 * service pattern live.
 */
export function registryProblems({ registry, existingDirs, metadataByPath, dispositionText = "" }) {
  const problems = [];
  const push = (where, kind, msg) => problems.push({ where, kind, msg });
  const R = REGISTRY_PATH;
  if (!registry || typeof registry !== "object") { push(R, "shape", "not a JSON object"); return problems; }

  // ── the sets ──
  for (const [facet, pinned] of Object.entries(FACET_SETS)) {
    const f = registry.facets?.[facet];
    if (!f || !sameSet(f.values, pinned.values) || f.stability !== pinned.stability)
      push(`${R} facets.${facet}`, "facet-set", `must be the ${pinned.stability} set [${pinned.values.join(", ")}] — a different set is a spec change and edits scripts/connector-registry.mjs's FACET_SETS too`);
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
    if (seen.has(a.path)) push(where, "artifact-duplicate", "listed twice — one entry per artifact, with every capability under it");
    seen.set(a.path, a);
    if (!dirs.has(a.path)) push(where, "artifact-missing", "no such contribution directory");
    if (!Array.isArray(a.capabilities) || a.capabilities.length === 0) { push(where, "capability-keys", "an artifact declares at least one capability"); continue; }
    const tuples = new Set();
    for (const [i, c] of a.capabilities.entries()) {
      const cw = `${where}.capabilities[${i}]`;
      const keys = Object.keys(c ?? {});
      const missing = CAPABILITY_KEYS.filter((k) => !keys.includes(k));
      const extra = keys.filter((k) => !CAPABILITY_KEYS.includes(k) && k !== "note");
      if (missing.length || extra.length) push(cw, "capability-keys", `a capability names exactly ${CAPABILITY_KEYS.join(", ")} (and a note)${missing.length ? `; missing ${missing.join(", ")}` : ""}${extra.length ? `; extra ${extra.join(", ")}` : ""}`);
      for (const [facet, pinned] of Object.entries(FACET_SETS)) if (facet in (c ?? {}) && !pinned.values.includes(c[facet])) push(cw, "capability-value", `${facet} ${JSON.stringify(c[facet])} is not one of ${pinned.values.join("|")}`);
      if ("fetcher" in (c ?? {}) && !FETCHERS.includes(c.fetcher)) push(cw, "capability-value", `fetcher ${JSON.stringify(c.fetcher)} is not one of ${FETCHERS.join("|")}`);
      if ("vendor" in (c ?? {}) && !VENDOR.test(String(c.vendor))) push(cw, "capability-value", `vendor ${JSON.stringify(c.vendor)} is not a kebab-case slug`);
      if ("family" in (c ?? {})) {
        if (!(c.family in families)) push(cw, "capability-family", `family ${JSON.stringify(c.family)} is not declared under families — a new family is declared with its schema first`);
        else if (families[c.family].reserved) push(cw, "reserved-used", `family ${JSON.stringify(c.family)} is reserved — dropping \`reserved\` is a spec change`);
      }
      const t = [c?.vendor, c?.family, c?.transport, c?.direction].join("|");
      if (tuples.has(t)) push(cw, "capability-duplicate", `repeats vendor/family/transport/direction ${t}`);
      tuples.add(t);
    }
  }

  // ── the connectors ──
  const derived = derivedConnectors(registry);
  const declared = registry.connectors && typeof registry.connectors === "object" ? registry.connectors : {};
  for (const v of derived.keys()) if (!(v in declared)) push(`${R} connectors`, "connector-set", `vendor "${v}" is used by a capability but has no connector entry`);
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
  const triggers = triggersFor({ metadataByPath, dispositionPaths: dispositionPaths(dispositionText), patterns, connectorKeys });
  const excused = registry.not_connectors?.artifacts && typeof registry.not_connectors.artifacts === "object" ? registry.not_connectors.artifacts : {};
  for (const [path, why] of triggers) {
    const isReg = seen.has(path);
    const isEx = path in excused;
    if (isReg && isEx) push(`${R} not_connectors.artifacts["${path}"]`, "coverage-both", "both classified and excused — one or the other");
    if (!isReg && !isEx) push(path, "coverage-unregistered", `touches an external system (${why.join("; ")}) and is neither classified in ${R} nor excused there by name with a reason — see ${SPEC_PATH}`);
  }
  for (const path of seen.keys()) if (!triggers.has(path)) push(`${R} artifacts["${path}"]`, "coverage-unmarked", "nothing marks this artifact as external-touching — tag it with its connector's name (the vendor key) or name the vendor's service in its metadata.json requires.services, so the sweep and the registry agree");
  for (const [path, reason] of Object.entries(excused)) {
    const where = `${R} not_connectors.artifacts["${path}"]`;
    if (!nonEmpty(reason)) push(where, "excuse-reason", "an excuse carries its reason");
    if (!metadataByPath.has(path)) push(where, "excuse-stale", "no such contribution — drop the excuse");
    else if (!triggers.has(path)) push(where, "excuse-stale", "nothing marks this artifact as external-touching any more — drop the excuse");
  }
  for (const p of patterns) if (p.hits === 0) push(p.where, "pattern-stale", `pattern ${JSON.stringify(p.pattern)} matches no service in the tree — drop it`);

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
  lines.push(`${artifactsOf(registry).length} artifacts, ${rows.length} capability rows, ${vendors.length} connectors (${bidi} bidirectional), ${inUse.size} of ${Object.keys(families).filter((f) => !families[f]?.reserved).length} declared families in use.`);
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
  const registry = readRegistry(root);
  const { existingDirs, metadataByPath } = contributionsOnDisk(root);
  const problems = registryProblems({
    registry,
    existingDirs,
    metadataByPath,
    dispositionText: existsSync(join(root, DISPOSITION_PATH)) ? readFileSync(join(root, DISPOSITION_PATH), "utf8") : "",
  });
  const specFile = join(root, SPEC_PATH);
  const text = readFileSync(specFile, "utf8");
  const span = tablesSpan(text);
  const rendered = renderClassification(registry);
  if (process.argv.includes("--check")) {
    if (!span) problems.push({ where: SPEC_PATH, kind: "spec-markers", msg: "the generated-tables markers are missing or doubled" });
    else if (span.block !== rendered) problems.push({ where: SPEC_PATH, kind: "spec-stale", msg: "the tables differ from what the registry renders — run `bun scripts/connector-registry.mjs`" });
    for (const p of problems) console.error(`  ${p.where}\n    ${p.msg}`);
    console.log(problems.length ? `FAIL — ${problems.length} problem(s)` : "PASS — the connector registry is sound and the spec's tables are current.");
    process.exit(problems.length ? 1 : 0);
  }
  if (problems.length) {
    for (const p of problems) console.error(`  ${p.where}\n    ${p.msg}`);
    console.error(`refusing to render from a registry with ${problems.length} problem(s)`);
    process.exit(1);
  }
  if (!span) { console.error(`${SPEC_PATH}: the generated-tables markers are missing or doubled`); process.exit(1); }
  const next = `${span.before}\n${rendered}\n${span.after}`;
  if (next === text) { console.log(`${SPEC_PATH}: tables already current.`); return; }
  writeFileSync(specFile, next);
  console.log(`${SPEC_PATH}: tables rewritten from ${REGISTRY_PATH}.`);
}

// Run as a CLI only when this file is the entry: both sides realpath'd (a symlinked checkout), and an
// argv[1] that does not resolve (a REPL, an import) is "not the entry", not a crash — fork-index.mjs's idiom.
const isMain = (() => { try { return Boolean(process.argv[1]) && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]); } catch { return false; } })();
if (isMain) main();
