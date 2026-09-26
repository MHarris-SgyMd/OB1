# 179. The entity graph refuses a number or a type word the extractor names and retypes an identifier-shaped person or place, at the writer and over the rows before it; the people facet takes the same rule (SMD-1935)

**What changed.** Migration 056 and a JavaScript twin:

- **`entity_type_gate(name, type)`**, IMMUTABLE and STRICT, is the rule. It
  returns the type the graph stores a name under, or NULL to refuse it:
  - refused: a name whose `normalize_entity_name()`, trimmed, is digits, then
    any run of digits, dots, colons and spaces (`NUMERIC_NAME_RE`; `10/8` and
    `127.0.0.1:11434` fold into it), or a type-vocabulary word (`person`,
    `people`, `tools`, `entity` …);
  - retyped: a person or place with a ticket id's shape to `project`; with a
    URL's, a package's or path's, or a host:port's to `tool`; a place (not a
    person — a handle takes these: `john.smith`, `@john_doe`) with a host's,
    domain's, file's, snake_case name's or glob's to `tool`. Read on the name
    trimmed of ASCII whitespace, every class spelled out;
  - otherwise the type given.
- **`record_thought_entities`** is redefined on 053's body. An extraction's
  entities are written under the gate's type; a refused one is not written,
  and a relation naming it is dropped and counted as a relation to any
  unlisted entity is. The result gains `refused_entities` and
  `retyped_entities`, one per answered (type, name). A `source:` pass is not
  gated: it states its names on the source's authority. Sentinel
  `ob1:name-gate`.
- **`apply_entity_type_gate()`** applies the rule to the rows written before
  it, each entity judged on its name (its first-seen spelling). It leaves an
  entity a structured pass names, and one a human curated — a name merged
  into it — whose merged names would otherwise come back split from it as
  entities of the old type. A refused entity's edges, mentions and row are
  deleted. A retyped one merges into the entity of the new type the writer
  would resolve its name to — the one a human merged the name into, else the
  one of that name — by `merge_entities`' steps (016's function refuses a
  merge across types): the mentions the target lacks move, edges are
  re-pointed (a symmetric relation re-ordered, a duplicate or self-edge
  dropped), aliases and the seen-at pair fold in. With no such entity it
  moves. The two target probes are index-served (`@>` on 016's GIN index,
  then the unique key), and the writer's `merged_from` redirect is spelled
  `@>` too, where `= ANY` scanned every entity of the type. The file runs it
  once and keeps the first run's `{refused, dropped mentions and edges,
  moved, merged}` in `ob1_config` under `entity_name_gate_056`; it is
  idempotent, and a writer call already running 053's body at the commit —
  or a label a source stops stating — is why it can be run again. A guard
  refuses a schema without 016 or 053 by name.
- **`server-portable/entity-gate.ts`** is the twin: `entityTypeGate`,
  `normalizeEntityName` (016's rule), the shapes, the trim and the
  vocabulary, with no imports so the server can load it. `NUMERIC_NAME_RE`
  moves here; `entities.ts` re-exports it.
- **`metadata.ts`**: `extractMetadata` keeps only the `people` the gate keeps
  as a person — the facet has no other type to retype to. The capture path
  and the board sync (`sync-linear.ts`) both get it.
- **`extract-entities.ts`** sums the two counts into its closing line, when
  the writer returned them.

**Why.** On the dogfood brain at 053, 107 of 3,384 entities were numbers
(17 of the 50 persons, 8 of the 31 places), 9 were type words, and 12 persons
and places were identifiers. SMD-1937 measured the ticket's proposed gate on
201 blind-graded mentions first: the number and vocabulary rules are right,
but refusing an identifier-shaped person or place dropped 7 real entities —
five code artifacts typed `place` (the maintainer decided code artifacts are
entities), `hono/mcp` and `openrouter.ai` — for 1 junk mention. So a shape corrects the type. A ticket id becomes a project
because the graph types 376 of them `project`. The URL shape is one step past
SMD-1937's measured shapes, for `http://127.0.0.1:65536/v1` typed `place`.

**Held.** One definition, in the database. test-schema [52] holds the twin
to it: 60 probes asked of both engines, and the SQL body checked to spell
every pattern, the trim and every vocabulary word `entity-gate.ts` does. Every
class is spelled out (`[^ \t\n\r\f\v]`, never `\S`: Postgres reads `\s` by
locale); the normalisers may still part on U+2028 or U+0085, which only the
people facet's numeric refusal reads.

**Measured after.** 056 applied to a fresh copy of the dogfood brain at
418fe8b5 (pass 3 touches no row there: no entity has a merged_from): 116 refused (165 mentions, 153 edges), 8 moved, 4 merged
(`hono/mcp` the person into the tool, `SMD-1804` the person into the project,
two hosts); 3,384 → 3,264 entities, persons 50 → 30, places 31 → 12, no
numeric name left (no numeric or vocabulary entity there had a structured
mention), and a second run changes nothing.

**Review passes.**

| Pass | Finding | Caught | Fix |
| --- | --- | --- | --- |
| 1 | the SQL shapes read `btrim()` and `\S`, the twin `trim()` and Unicode `\s`: `SMD-1804` with a trailing tab stayed a person in the writer, and 7 whitespace spellings parted | run-it | one trim pattern both engines run, every class spelled out, 11 probes (4 controls) |
| 1 | a retype carried `merged_from`, a human's merge within the old type, into the new one, where it redirected an unrelated tool's mentions and pruned it | run-it | filtered (pass 2 replaced it) |
| 1 | a `source:` pass was gated: a Linear label `2024` or `Tools` refused, its mentions deleted by the pass | cold read | the writer gates extractions only; the pass skips what a structured pass names |
| 1 | the people facet dropped every retyped name — `john.smith`, `@john_doe` | run-it | narrowed (pass 2 made it the graph's rule) |
| 1 | the two counts counted answer elements | run-it | `count(DISTINCT …)` |
| 1 | the lock was said to keep every answer out; a call already running 053's body writes by 053's rule | cold read | stated, with the re-run |
| 1 | the header said 11 identifiers and listed 8; the commit named [42] for the restore in [41] | cold read | 12, listed; recorded here |
| 2 | pass 1's `merged_from` filter read a snapshot, so a row the loop moved went unseen, and two tools could hold one merged name — the pass-1 symptom again | run-it | a retyped row's `merged_from` goes |
| 2 | the pass merged by name alone where the writer resolves `merged_from` first, recreating a row a human merged away | run-it | the target the writer would pick |
| 2 | the graph retyped `john.smith` the person to a tool while the facet kept it; `open_brain:5432` read snake_case first and stayed in the facet | run-it | the handle shapes retype a place only; host:port read first; the facet is the graph's rule |
| 2 | a leading form feed or vertical tab survives 016's strip: `\f021` was kept | run-it | the normalised name trimmed, both engines |
| 2 | the prose still said every pass is gated, and the numbers predated pass 1 (persons "58" miscounted) | cold read | reworded; re-measured |
| 2 | smaller: the pass's `retyped_entities` meant moves (now `moved_entities`); the count keys on the answered type; the text check did not bound the vocabulary; an invisible no-break space in a test | cold read | fixed, each |
| 3 | the NOTICE reached no one — Bun's client surfaces none, the server logs from WARNING — so the rows deleted were counted nowhere | run-it | the first run's counts in `ob1_config` |
| 3 | the target lookup's `= ANY(...) OR` scanned every entity of the type per retyped row (~2 ms a row at 80,000 entities, under the lock); the writer's redirect the same per call | run-it | two index probes; `@>` in the writer |
| 3 | dropping `merged_from` on a retype split a curated entity from the names merged into it | run-it | a curated entity stands |
| 3 | the merged-first order had no killing assertion — the id tiebreak picked the same target | run-it | ids swapped |
| 3 | main's 055 took [51] and [20i]; the window line merged clean at 26 and needs 27 | run-it | [52], [20j], 27 (the merge) |
| 3 | smaller: the pass's comment, "a retype loses nothing", the re-extraction claim, a probe comment; extract-entities printed a gate's zeros against a brain without 056; a `--grant` role lacks UPDATE (before this branch) | cold read | fixed, each; SMD-2216 filed |
| 4 | the record's assertion read a row written on an empty graph — a constant, or DO UPDATE, passed | cold read | the file's run over the fixture, its exact counts, kept across a re-apply |
| 4 | a curated entity's own name, answered again, lands on a new entity of the new type; a curated numeric name stays | run-it | stated (the writer's redirect is per type) |
| 4 | smaller: "seven code artifacts" (five, `hono/mcp`, `openrouter.ai`); 053's pass tags in 056's body; the pass's `@>` unchecked; which role re-runs the pass | cold read | fixed, each |
| 5 | none: a cold read of the branch and the boyscout (the dropped `v_target := NULL` probed neutral, the rewrap word-for-word), and main's #173/#175 against it | cold read, run-it | — |

**Not taken.**
- *A numeric name a structured source states, or a curated entity keeps.* A
  Linear label `2024` stays, so the ticket's `name ~ '^[0-9]+$'` can return
  rows after 056. graph-centrality's read-side numeric rule (`--keep-numeric`)
  still filters them, and a brain from before 056.
- *Binding "migration 021" to a `migration:021` reference.* No such type.
- *Re-extracting the affected thoughts.* The pass applies the gate to the
  stored rows without the model — on each entity's first-seen spelling, where
  a re-extraction judges each answer's, and leaving curated entities.
- *A prompt change, or an `ENTITY_PROMPT_VERSION` bump.* The gate sits at the
  writer, so a p2 answer stores what a p3 would; a prompt change needs
  eval-entities' measurement.
- *Short tokens with no shape* (`Edge0` as a place), *generic words, roles,
  and names no window holds* (SMD-1937's remaining junk): no shape rule
  reaches them, so "place holds only places" is met in part.
- *Rewriting stored `metadata.people`.* Every row write is an audit event;
  the facet is clean from the next capture or content edit (a retag once
  SMD-1975 lands).
- *Narrower rules for a general brain.* The shapes were measured on an
  engineering corpus: a place `Route-66` becomes a project and `St.Louis` a
  tool, and an extracted topic `1984` or `9/11` is refused, the ticket's rule.
  A retype keeps the entity; the refusal does not.
- *Keeping a structured row in a merge.* The pass skips any entity a
  structured pass names, so no structured row is merged.

**Follow-ups.** SMD-2216: a `--grant` role lacks UPDATE on the two tables
053's writer upserts, so it can run neither the writer nor the pass.

**Boyscout.** The README's 056 paragraph rewrapped; graph-centrality's docblock
said the extractor mints numbers, present tense; a dead `v_target := NULL` and an
unread column in [52].
