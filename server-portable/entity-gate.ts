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
 *      refused. A ticket id becomes a `project`; a URL, a package or path, or a
 *      host:port a `tool`, whichever of the two types it was given; a host,
 *      domain or file, or a snake_case name or glob, becomes a `tool` from a
 *      `place` only, since a person's handle takes those shapes (`john.smith`,
 *      `@john_doe`; second review pass). SMD-1937 measured refusing instead on
 *      201 graded mentions: it dropped seven real entities — five code
 *      artifacts the extractor typed `place` (the maintainer's decision is that
 *      code artifacts are entities), `hono/mcp` and `openrouter.ai` — for one
 *      junk mention. The URL shape is one step
 *      past what SMD-1937 measured, for `http://127.0.0.1:65536/v1` typed
 *      `place` on the dogfood brain.
 *   4. Anything else keeps the extractor's type.
 *
 * In the `people` facet a retype has nowhere to go, so a name the gate does
 * not keep as a person is dropped.
 *
 * The rule reads the MODEL's guesses. A `source:` pass states its names on
 * the source's authority (a Linear label `2024` is a label) and is not gated.
 *
 * The DATABASE is the one definition: migration 056's `entity_type_gate()`,
 * applied by record_thought_entities to every extraction and by
 * apply_entity_type_gate() to the rows written before it. This module is its
 * twin for the writers that never reach that function — the `people` facet in
 * metadata.ts — and test-schema asserts the two answer alike over a probe
 * list. The patterns spell their classes out — `[A-Za-z0-9]`, never `\w`;
 * whitespace as ASCII_SPACE, never `\s` or `\S`, which Postgres reads by
 * locale and JavaScript by Unicode — and the trim is one pattern both
 * engines run, so the shapes mean one thing in both (first review pass: a
 * trailing tab took `SMD-1804\t` past the SQL rule and not the twin). The
 * normaliser collapses ASCII whitespace; a name holding other whitespace
 * (U+2028, U+0085) may still normalise apart, since Postgres's `\s` follows
 * the locale — the numeric rule can then refuse in one engine and not the
 * other.
 *
 * No imports: the server loads this through metadata.ts, and entities.ts pulls
 * in db/config.mjs.
 */

/**
 * The numeric rule, as a POSIX pattern over `normalized_name`: digits, then
 * any run of digits, dots, colons and spaces — "021", "11434", "127.0.0.1",
 * "10 000"; "pg16" and "smd 1938" have letters and stay. db/graph-centrality.ts
 * reads it too, for the numeric names 056 leaves: a brain before it, a name
 * a structured pass states, and an entity a human curated.
 */
export const NUMERIC_NAME_RE = "^[0-9][0-9 .:]*$";

/** The type vocabulary, minted as a name: SMD-1982's grades found `person`, `place` and `organization`. Compared after normalisation. */
export const ENTITY_VOCABULARY: readonly string[] = [
  "person", "persons", "people", "organization", "organizations", "organisation", "organisations",
  "project", "projects", "tool", "tools", "topic", "topics", "place", "places", "entity", "entities",
];

/** The whitespace the shapes and the trim know: ASCII's six. */
const ASCII_SPACE = " \\t\\n\\r\\f\\v";

/** The trim both engines apply before a shape is read: leading and trailing ASCII whitespace. */
export const TRIM_RE = `^[${ASCII_SPACE}]+|[${ASCII_SPACE}]+$`;

/**
 * An identifier's shape, read on the name as written (trimmed): the type a
 * `person` or `place` of that shape becomes, the first that applies. A
 * ticket id is a named piece of work (the graph types 376 of them `project`),
 * the rest are code artifacts or addresses, `tool` under the maintainer's
 * decision. `person`: whether a `person` of the shape is retyped too — the
 * shapes SMD-1935 names for people (a ticket id, a package, an IP or port),
 * and the URL; not the dotted or underscored ones a handle takes.
 */
export const IDENTIFIER_SHAPES: readonly { why: string; pattern: string; type: "project" | "tool"; person: boolean }[] = [
  { why: "a ticket id", pattern: "^[A-Za-z]+-[0-9]+$", type: "project", person: true },
  { why: "a URL", pattern: "^[A-Za-z][A-Za-z0-9+.-]*://", type: "tool", person: true },
  { why: "a package or a path", pattern: "^@?[A-Za-z0-9_.-]+/[A-Za-z0-9_.*/-]*$", type: "tool", person: true },
  { why: "a host:port", pattern: `^[^${ASCII_SPACE}]+:[0-9]+$`, type: "tool", person: true },
  { why: "a host, a domain or a file", pattern: "^[A-Za-z0-9_-]+(\\.[A-Za-z0-9_-]+)+$", type: "tool", person: false },
  { why: "snake_case or a glob", pattern: `^[^${ASCII_SPACE}]*[_*][^${ASCII_SPACE}]*$`, type: "tool", person: false },
];

const NUMERIC = new RegExp(NUMERIC_NAME_RE);
const SHAPES = IDENTIFIER_SHAPES.map((s) => ({ ...s, re: new RegExp(s.pattern) }));
const TRIM = new RegExp(TRIM_RE, "g");
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
  const out = chars.slice(a, b).join("").replace(/[ \t\n\r\f\v]+/g, " ");
  return out === "" ? null : out;
}

/**
 * Why the gate refuses a name, or null — whatever the type. The normalised
 * name is trimmed of spaces first: 016's outer strip knows no form feed, so
 * `\f021` normalises to ` 021` (second review pass).
 */
export function refusalOf(name: string): string | null {
  const n = normalizeEntityName(name)?.replace(/^ +| +$/g, "");
  if (!n) return "an empty name";
  if (NUMERIC.test(n)) return "a number";
  if (VOCABULARY.has(n)) return "a type-vocabulary word";
  return null;
}

/**
 * The type the graph stores a name under, or null to refuse it: migration
 * 056's entity_type_gate(), in JavaScript. A type outside person and place is
 * passed through as given — which types exist is the writer's list.
 */
export function entityTypeGate(name: string, type: string): string | null {
  if (refusalOf(name) !== null) return null;
  if (type !== "person" && type !== "place") return type;
  const raw = name.replace(TRIM, "");
  return SHAPES.find((s) => (type === "place" || s.person) && s.re.test(raw))?.type ?? type;
}

/**
 * The `people` facet with the gate applied, as written and in order: the
 * names the gate keeps as a `person`. A retyped one is dropped — the facet
 * holds people only — and so is an item that is not a string (`21` is the
 * numeric rule's case in JSON). A non-array is returned as it came — the
 * facet's shape is the extractor's to get wrong, and its reader already
 * tolerates that (thought_stats checks Array.isArray).
 */
export function gatePeople(people: unknown): unknown {
  if (!Array.isArray(people)) return people;
  return people.filter((p) => typeof p === "string" && entityTypeGate(p, "person") === "person");
}
