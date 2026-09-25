/**
 * entity-gate.ts — which names the graph refuses, and which types it corrects
 * (SMD-1935).
 *
 * The extractor mints context-stripped fragments as entities: "migration 021"
 * becomes a `person` named `021`, the Ollama port a `place` named `11434`, a
 * branch glob a `place` named `siggymd/**`. The capture-time `people` facet
 * does the same with package names and ticket ids (`@hono/mcp`, `SMD-1497`).
 * One rule answers both writers:
 *
 *   1. A name that normalises to digits, dots, colons and spaces is refused: a
 *      migration number, a port, an address, a CIDR (`10/8` folds to `10 8`).
 *   2. A name that is the type vocabulary itself (`person`, `places`, `entity`)
 *      is refused.
 *   3. A `person` or `place` with an identifier's shape is RETYPED, not
 *      refused: a ticket id to `project`, a URL, package, path, host, file,
 *      snake_case name, glob or host:port to `tool`. SMD-1937 measured the
 *      refusal on 201 graded mentions: it dropped seven real entities (code
 *      artifacts the extractor typed `place`, and the maintainer's decision is
 *      that code artifacts are entities) for one junk mention. The URL shape is
 *      one step past what SMD-1937 measured, for `http://127.0.0.1:65536/v1`
 *      typed `place` on the dogfood brain.
 *   4. Anything else keeps the extractor's type.
 *
 * The DATABASE is the one definition: migration 056's `entity_type_gate()`,
 * applied by record_thought_entities to every pass and by
 * apply_entity_type_gate() to the rows written before it. This module is its
 * twin for the writers that never reach that function — the `people` facet in
 * metadata.ts — and test-schema asserts the two answer alike over a probe
 * list. Both read ASCII classes only (`[A-Za-z0-9]`, never `\w`, which
 * Postgres reads by locale and JavaScript as ASCII), so the patterns mean one
 * thing in both engines.
 *
 * No imports: the server loads this through metadata.ts, and entities.ts pulls
 * in db/config.mjs.
 */

/**
 * The numeric rule, as a POSIX pattern over `normalized_name`: digits, then
 * any run of digits, dots, colons and spaces — "021", "11434", "127.0.0.1",
 * "10 000"; "pg16" and "smd 1938" have letters and stay. db/graph-centrality.ts
 * reads it too, for a brain not yet at 056.
 */
export const NUMERIC_NAME_RE = "^[0-9][0-9 .:]*$";

/** The type vocabulary, minted as a name: SMD-1982's grades found `person`, `place` and `organization`. Compared after normalisation. */
export const ENTITY_VOCABULARY: readonly string[] = [
  "person", "persons", "people", "organization", "organizations", "organisation", "organisations",
  "project", "projects", "tool", "tools", "topic", "topics", "place", "places", "entity", "entities",
];

/**
 * An identifier's shape, read on the name as written (trimmed): the type a
 * `person` or `place` of that shape becomes. First match wins; a ticket id is
 * a named piece of work (the graph types 376 of them `project`), the rest are
 * code artifacts or addresses, `tool` under the maintainer's decision.
 */
export const IDENTIFIER_SHAPES: readonly { why: string; pattern: string; type: "project" | "tool" }[] = [
  { why: "a ticket id", pattern: "^[A-Za-z]+-[0-9]+$", type: "project" },
  { why: "a URL", pattern: "^[A-Za-z][A-Za-z0-9+.-]*://", type: "tool" },
  { why: "a package or a path", pattern: "^@?[A-Za-z0-9_.-]+/[A-Za-z0-9_.*/-]*$", type: "tool" },
  { why: "a host, a domain or a file", pattern: "^[A-Za-z0-9_-]+(\\.[A-Za-z0-9_-]+)+$", type: "tool" },
  { why: "snake_case or a glob", pattern: "^\\S*[_*]\\S*$", type: "tool" },
  { why: "a host:port", pattern: "^\\S+:[0-9]+$", type: "tool" },
];

const NUMERIC = new RegExp(NUMERIC_NAME_RE);
const SHAPES = IDENTIFIER_SHAPES.map((s) => ({ ...s, re: new RegExp(s.pattern) }));
const VOCABULARY = new Set(ENTITY_VOCABULARY);
/** normalize_entity_name's outer strip: whitespace, quotes and punctuation. */
const OUTER = new Set([..." \t\n\r\"'`.,;:!?()[]{}<>"]);

/**
 * Migration 016's normalize_entity_name, read in JavaScript: NFKC, lower
 * case, `-_/\#` runs to a space, the outer strip, whitespace collapsed; null
 * for nothing left. Postgres's lower() folds by the database's locale, so the
 * two agree on ASCII and may part on a letter a locale folds differently.
 */
export function normalizeEntityName(name: string): string | null {
  const folded = name.normalize("NFKC").toLowerCase().replace(/[-_/\\#]+/g, " ");
  const chars = [...folded];
  let a = 0;
  let b = chars.length;
  while (a < b && OUTER.has(chars[a])) a++;
  while (b > a && OUTER.has(chars[b - 1])) b--;
  const out = chars.slice(a, b).join("").replace(/\s+/g, " ");
  return out === "" ? null : out;
}

/** Why the gate refuses a name, or null: rules 1 and 2, whatever the type. */
export function refusalOf(name: string): string | null {
  const n = normalizeEntityName(name);
  if (n === null) return "an empty name";
  if (NUMERIC.test(n)) return "a number";
  if (VOCABULARY.has(n)) return "a type-vocabulary word";
  return null;
}

/**
 * The type the graph stores a name under, or null to refuse it: migration
 * 056's entity_type_gate(), in JavaScript. A type outside person and place is
 * passed through as given — the vocabulary check is the writer's.
 */
export function entityTypeGate(name: string, type: string): string | null {
  if (refusalOf(name) !== null) return null;
  if (type !== "person" && type !== "place") return type;
  const raw = name.trim();
  return SHAPES.find((s) => s.re.test(raw))?.type ?? type;
}

/**
 * The `people` facet with the gate applied: the strings the gate keeps as a
 * `person`, as written and in order. A retyped name is dropped, since the
 * facet holds people only; so is an item that is not a string (`21` is the
 * numeric rule's case in JSON). A non-array is returned as it came — the
 * facet's shape is the extractor's to get wrong, and its reader already
 * tolerates that (thought_stats checks Array.isArray).
 */
export function gatePeople(people: unknown): unknown {
  if (!Array.isArray(people)) return people;
  return people.filter((p) => typeof p === "string" && entityTypeGate(p, "person") === "person");
}
