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
 *   3. A name with an identifier's shape is RETYPED, not refused. A
 *      high-precision shape a real-world proper noun does not take — a
 *      three-or-more-digit ticket id (`project`), a package or path, or a
 *      host:port (`tool`) — overrides whatever type the model gave, and
 *      snake_case overrides it for every type but a person (SMD-2300, measured
 *      on the live graph: the extractor typed `SMD-1549`/`worker_status` a
 *      `topic`, not a person or place, so the SMD-1935 person/place scope never
 *      reached them). The looser ticket id and the URL still retype a `person`
 *      or `place` only; a host, domain or file (`john.smith`, `Nature.com`)
 *      retypes a `place` only, since a person's handle and a real organization
 *      take that shape. SMD-1937 measured refusing instead on 201 graded
 *      mentions: it dropped seven real entities — five code artifacts the
 *      extractor typed `place`, `hono/mcp` and `openrouter.ai` — for one junk
 *      mention.
 *   4. Anything else keeps the extractor's type.
 *
 * In the `people` facet a retype has nowhere to go, so a name the gate does
 * not keep as a person is dropped.
 *
 * The rule reads the MODEL's guesses. A `source:` pass states its names on
 * the source's authority (a Linear label `2024` is a label) and is not gated.
 *
 * The DATABASE is the one definition: migration 065's `entity_type_gate()`
 * (SMD-1935's rule widened by SMD-2300), applied by record_thought_entities to
 * every extraction and by apply_identifier_allowlist() to the rows written
 * before it. This module is its twin for the writers that never reach that
 * function — the `people` facet in metadata.ts — and test-schema asserts the
 * two answer alike over a probe list. The patterns spell their classes out — `[A-Za-z0-9]`, never `\w`;
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
 * An identifier's shape, read on the name as written (trimmed): the type a name
 * of that shape becomes, the first that applies. A ticket id is a named piece of
 * work (the graph types 376 of them `project`), the rest are code artifacts or
 * addresses, `tool` under the maintainer's decision. `scope` is which of the
 * model's types the shape overrides — SMD-2300 widened this from person/place
 * to any, for the shapes a real-world proper noun does not take:
 *   - "any": overrides whatever type the model gave. A three-or-more-digit
 *     ticket id (`SMD-1549`; `GPT-4`, one digit, is a model, left alone), a
 *     package or path (`db/x.ts`, `origin/main`), a host:port — none of which a
 *     person, organization, place or topic is named.
 *   - "notPerson": every type but `person`, whose handle takes an underscore or
 *     a glob (`@john_doe`), so snake_case retypes the others (`thought_audit`)
 *     and leaves a person alone.
 *   - "personPlace": a `person` or `place` only — the looser ticket id and the
 *     URL SMD-1935 named for those two types.
 *   - "place": a `place` only — a host, domain or file, a shape a person's
 *     handle also takes (`john.smith`), and one a real organization takes
 *     (`Nature.com`), so it is left for the model on any other type.
 */
export const IDENTIFIER_SHAPES: readonly { why: string; pattern: string; type: "project" | "tool"; scope: "any" | "notPerson" | "personPlace" | "place" }[] = [
  { why: "a ticket id, three or more digits", pattern: "^[A-Za-z]{2,}-[0-9]{3,}$", type: "project", scope: "any" },
  { why: "a package or a path", pattern: "^@?[A-Za-z0-9_.-]+/[A-Za-z0-9_.*/-]*$", type: "tool", scope: "any" },
  { why: "a host:port", pattern: `^[^${ASCII_SPACE}]+:[0-9]+$`, type: "tool", scope: "any" },
  { why: "snake_case or a glob", pattern: `^[^${ASCII_SPACE}]*[_*][^${ASCII_SPACE}]*$`, type: "tool", scope: "notPerson" },
  { why: "a ticket id", pattern: "^[A-Za-z]+-[0-9]+$", type: "project", scope: "personPlace" },
  { why: "a URL", pattern: "^[A-Za-z][A-Za-z0-9+.-]*://", type: "tool", scope: "personPlace" },
  { why: "a host, a domain or a file", pattern: "^[A-Za-z0-9_-]+(\\.[A-Za-z0-9_-]+)+$", type: "tool", scope: "place" },
];

/** Which model types a shape's `scope` overrides. */
const SCOPE_APPLIES: Record<string, (type: string) => boolean> = {
  any: () => true,
  notPerson: (t) => t !== "person",
  personPlace: (t) => t === "person" || t === "place",
  place: (t) => t === "place",
};

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
 * 065's entity_type_gate(), in JavaScript. A high-precision identifier shape
 * (a 3+-digit ticket id, a path, a host:port, or — for any type but a person —
 * snake_case) overrides the model's type (SMD-2300); the looser ticket id, the
 * URL and the dotted host retype a person or place as SMD-1935 named; any other
 * type the model gave is kept.
 */
export function entityTypeGate(name: string, type: string): string | null {
  if (refusalOf(name) !== null) return null;
  const raw = name.replace(TRIM, "");
  return SHAPES.find((s) => SCOPE_APPLIES[s.scope](type) && s.re.test(raw))?.type ?? type;
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
