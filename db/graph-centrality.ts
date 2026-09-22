#!/usr/bin/env bun
/**
 * graph-centrality.ts — rank the entity graph by attention: what the brain
 * mentions most, what it connects most, and around one subject, what it
 * connects that subject to.
 *
 * Migration 016 stores entities, the thoughts that mention them and the edges
 * between them, one row per evidencing thought; nothing ships that reads it for
 * importance (SMD-1938). "What is relevant to X" is search_thoughts's question
 * and stays there. This answers the other one — "what does the brain hold as
 * central about X, or overall" — with three counts anyone can recompute:
 *
 *   mentions   distinct thoughts that mention the entity
 *   degree     distinct entities an edge joins it to, either end, in scope
 *   support    distinct thoughts evidencing any edge that touches it
 *
 * and around a subject, per neighbour:
 *
 *   co_mentions   distinct thoughts mentioning both the subject and the neighbour
 *   support       distinct thoughts evidencing an edge between them, any relation,
 *                 either direction — the per-relation counts are shown beside it,
 *                 and can sum past support when one thought asserts two relations
 *
 * A neighbour ranks by co_mentions + support; `--no-edges` drops the support
 * term and the degree/support columns, so the same command run twice says what
 * the edges add over co-occurrence alone (the drop-the-graph control the ticket
 * asks for). Entity ties break on mentions, then normalised name, then type —
 * never on a uuid or a timestamp; thought ties break on the thought id, which
 * is stable on one database and carries no recency. The same rows give the
 * same order on every run.
 *
 *   bun db/graph-centrality.ts --url postgres://…                  # the whole graph: top entities and thoughts
 *   bun db/graph-centrality.ts --url … "Open Brain"                # one subject's neighbourhood
 *   bun db/graph-centrality.ts --url … "Open Brain" --no-edges     # …by co-occurrence alone
 *   --limit N (20, at most 500)   --types project,tool,…   --keep-numeric   --json
 *
 * The subject resolves by 016's own rule, one rung at a time: an exact
 * `normalized_name` match (`normalize_entity_name`, so "Open-Brain" finds
 * "open brain"); else a name a human merged in (`merged_from`) or an alias the
 * model offered; else the five nearest by trigram similarity at pg_trgm's
 * default threshold or above, named as guesses. What is ranked around is the
 * entities sharing the FIRST subject's normalised name — "postgres" as a tool
 * and as a topic are both it; the other names an alias or fuzzy rung returns
 * are listed, unmarked, and not ranked around (`rankedSubjects`,
 * `Report.subject_ids`). A uuid is one entity, ranked around alone — its
 * same-name siblings under other types are then its neighbours.
 *
 * `--types` and the numeric rule together say which entities exist for the
 * run — the scope IS the graph: an entity outside it is in no list and no
 * count, so under `--types tool` a tool's degree is its degree among tools.
 * The subject is the one exception, resolved whatever its type: `--types tool
 * "Open Brain"` is the tools around a project.
 *
 * ── What this is not ────────────────────────────────────────────────────────
 * Centrality here is ATTENTION, not value, and the output says so every run:
 *   • Edges are unweighted. On real runs every edge carries confidence 1.00
 *     (SMD-1925), so the only weight an edge has is how many thoughts assert it.
 *   • Entity typing is noisy (SMD-1935): the extractor mints bare migration and
 *     port numbers as `person`/`tool`/`project` rows. Names that are only digits,
 *     dots, colons and spaces are out of scope by default (`--keep-numeric`
 *     admits them); `--types` narrows further. Out of scope means out of every
 *     count: a numeric neighbour adds no degree and appears in no list.
 *   • Hubs and clusters inflate each other: the project's own name is mentioned
 *     by most thoughts, and an epic's children all connect to it.
 *   • A freshly captured thought about a subject ranks as high as any other; no
 *     recency term is applied and none is subtracted.
 *   • The graph knows nothing of ticket status: open/closed is the caller's
 *     filter against the source.
 *   • Only what has been extracted is in the graph: the coverage line says how
 *     many thoughts db/extract-entities.ts has reached.
 *
 * Pure reads, one connection, no writes. The SQL is built by exported functions
 * over a `Runner` so db/test-schema.ts [44] runs the same text under PGlite.
 */
import { SQL } from "bun";
import { ENTITY_TYPES, NUMERIC_NAME_RE, type EntityType } from "../server-portable/entities.ts";
import { isoTimestampOrNull, UUID_RE } from "../server-portable/store.ts";
import { cleanForDisplay } from "../server-portable/consolidate.ts";

/** `(text, params) → rows` — Bun's `sql.unsafe` or PGlite's `query(...).rows`. */
export type Runner = (text: string, params: unknown[]) => Promise<Record<string, unknown>[]>;

/**
 * Below this trigram similarity a fuzzy candidate is not offered: pg_trgm's
 * own default (`pg_trgm.similarity_threshold`, what `%` tests). A one-letter
 * transposition of a ten-letter name scores about 0.43, so 0.5 missed it.
 */
export const FUZZY_FLOOR = 0.3;
export const FUZZY_LIMIT = 5;
export const DEFAULT_LIMIT = 20;

export type Scope = {
  /** Entity types in scope; the default is all six. */
  types: readonly EntityType[];
  /** Whether SMD-1935's numeric names are excluded (the default). */
  excludeNumeric: boolean;
};
export type Options = Scope & {
  limit: number;
  /** With edges off, no edge count is read or ranked on: the control. */
  edges: boolean;
};
export const DEFAULT_OPTIONS: Options = { types: ENTITY_TYPES, excludeNumeric: true, limit: DEFAULT_LIMIT, edges: true };

export type EntityRow = { id: string; entity_type: string; name: string; mentions: number; degree?: number; support?: number };
export type ThoughtRow = { id: string; created_at: string | null; excerpt: string; entities: number; edges?: number };
export type SubjectRow = { id: string; entity_type: string; name: string; normalized_name: string; mentions: number; score: number };
export type Resolution = {
  how: "id" | "exact" | "alias" | "fuzzy" | "none";
  subjects: SubjectRow[];
  /** What normalize_entity_name made of the input; null for a uuid, or a name that is only punctuation. */
  normalized: string | null;
  /** `none` because the subject IS an entity (by id, name, alias or merged-in name) and the numeric-name rule excludes it — exit 3, the message names --keep-numeric. */
  excluded: boolean;
  /** `none` with numeric-named entities near the subject that the rule hid — still no entity (exit 1); --keep-numeric would offer them as guesses. */
  hidden_guesses: number;
};
export type NeighbourRow = { id: string; entity_type: string; name: string; mentions: number; co_mentions: number; support?: number; relations?: string | null };
export type Coverage = { thoughts: number; extracted: number; entities: number; numeric_names: number; edges: number; unit_edges: number; extraction_key: string | null };

/** A Postgres array literal from strings that carry no quote, comma, brace, backslash or space — uuids, type names. */
export function pgArray(items: readonly string[]): string {
  for (const s of items) if (/[",{}\\\s]/.test(s)) throw new Error(`pgArray: ${JSON.stringify(s)} needs quoting; this helper is for uuids and type names`);
  return `{${items.join(",")}}`;
}

/**
 * The scope predicate over an ob1_entities alias, its parameters appended to
 * `params` — one definition, so every list and every count agrees on which
 * entities exist.
 */
function scopeSql(alias: string, scope: Scope, params: unknown[]): { where: string; typesSlot: number; patternSlot: number | null } {
  params.push(pgArray(scope.types));
  const typesSlot = params.length;
  let where = `${alias}.entity_type = ANY($${typesSlot}::text[])`;
  let patternSlot: number | null = null;
  if (scope.excludeNumeric) {
    params.push(NUMERIC_NAME_RE);
    patternSlot = params.length;
    where += ` AND ${alias}.normalized_name !~ $${patternSlot}`;
  }
  // The slots are returned so a query that reads the same values again
  // references them rather than counting pushes by hand (seventh review pass).
  return { where, typesSlot, patternSlot };
}

/** Mentions per in-scope entity; every query using it has a `scope` CTE before it. */
const MENTIONS_CTE = `mentions AS (SELECT te.entity_id, count(DISTINCT te.thought_id)::int AS mentions FROM thought_entities te
                        WHERE te.entity_id IN (SELECT id FROM scope) GROUP BY 1)`;
/** Every edge from both ends: (entity, the other entity, the evidencing thought, relation). */
const ENDS_CTE = `ends AS (
    SELECT from_entity_id AS entity_id, to_entity_id AS other_id, thought_id, relation FROM ob1_entity_edges
    UNION ALL
    SELECT to_entity_id, from_entity_id, thought_id, relation FROM ob1_entity_edges)`;
/** The entity tiebreak every ranking ends on, unqualified: each query has one relation carrying the two columns. */
const ENTITY_TIEBREAK = `normalized_name, entity_type`;

/** How much of the brain the graph covers, and the two measured caveats' numbers. */
export async function coverage(run: Runner, scope: Scope): Promise<Coverage> {
  // numeric_names is the rule's own effect: numeric names AMONG the ranked
  // types, since a numeric name of another type is out by type whatever the
  // rule says (third review pass).
  // The numeric count reads the slots scopeSql bound, binding the pattern
  // itself only when the rule is off and scopeSql did not (one binding per value).
  const params: unknown[] = [];
  const sc = scopeSql("e", scope, params);
  const patternSlot = sc.patternSlot ?? params.push(NUMERIC_NAME_RE);
  const [r] = await run(
    `SELECT (SELECT count(*) FROM thoughts)::int AS thoughts,
            (SELECT count(DISTINCT thought_id) FROM thought_entities)::int AS extracted,
            (SELECT count(*) FROM ob1_entities e WHERE ${sc.where})::int AS entities,
            (SELECT count(*) FROM ob1_entities WHERE normalized_name ~ $${patternSlot} AND entity_type = ANY($${sc.typesSlot}::text[]))::int AS numeric_names,
            (SELECT count(*) FROM ob1_entity_edges)::int AS edges,
            (SELECT count(*) FROM ob1_entity_edges WHERE confidence = 1)::int AS unit_edges,
            (SELECT value FROM ob1_config WHERE key = 'entity_extraction_key') AS extraction_key`,
    params);
  return r as Coverage;
}

/**
 * The subject, one rung at a time. `normalized` is what the rule made of the
 * input; null when it is only punctuation, and nothing can match it. The type
 * scope does not apply here — it says what to rank around the subject — and
 * the numeric rule does, so "021" is not a subject unless numerics are kept.
 */
export async function resolveSubject(run: Runner, subject: string, scopeIn: Scope): Promise<Resolution> {
  // Every rung runs ONCE, without the numeric rule, and marks each row in or
  // out of it; rows in the rule sort first, so a LIMIT keeps them. The ladder
  // reads the partition: rows in → the subject; only rows out → "the match
  // exists, the rule hid it", which is the stop that names --keep-numeric;
  // nothing → the next rung. One query and one rule for every rung — the
  // first, third and fifth passes had each patched one rung with a second,
  // unscoped probe, and the fuzzy rung still had none (sixth review pass).
  // The type scope does not apply here: it says what to rank around the
  // subject. The mention count is MENTIONS_CTE's, correlated — an index probe
  // per CANDIDATE row, since the ORDER BY reads it: one for an exact or alias
  // match, one per entity above the similarity floor on the fuzzy rung.
  /** A rung's rows: those in the rule (the subject, if any) and how many the rule kept out. */
  type RungResult = { hit: SubjectRow[]; out: number };
  const rung = async (how: string, score: string, params: unknown[], limit = ""): Promise<RungResult> => {
    params.push(NUMERIC_NAME_RE);
    const rows = await run(
      `SELECT s.id, s.entity_type, s.name, s.normalized_name,
              (SELECT count(DISTINCT te.thought_id) FROM thought_entities te WHERE te.entity_id = s.id)::int AS mentions,
              ${score} AS score,
              (${scopeIn.excludeNumeric ? "true" : "false"} AND s.normalized_name ~ $${params.length}) AS excluded
         FROM ob1_entities s
        WHERE ${how}
        ORDER BY excluded, score DESC, mentions DESC, ${ENTITY_TIEBREAK}${limit}`,
      params);
    const hit = rows.filter((r) => r.excluded !== true).map(({ excluded: _e, ...x }) => ({ ...x, score: Number(x.score) })) as SubjectRow[];
    return { hit, out: rows.length - hit.length };
  };
  const none = (normalized: string | null, excluded: boolean, hidden = 0): Resolution => ({ how: "none", subjects: [], normalized, excluded, hidden_guesses: hidden });
  /**
   * The rung's verdict, or null to try the next. Rows in → the subject. Only
   * rows out → on the id, exact and alias rungs the subject IS an entity the
   * rule hid (excluded, exit 3); on the fuzzy rung it is not — only guesses
   * were hidden, which the miss reports as a count (seventh review pass).
   */
  const step = (how: Resolution["how"], r: RungResult, normalized: string | null): Resolution | null =>
    r.hit.length ? { how, subjects: r.hit, normalized, excluded: false, hidden_guesses: 0 }
    : r.out === 0 ? null
    : how === "fuzzy" ? none(normalized, false, r.out) : none(normalized, true);

  if (UUID_RE.test(subject.trim())) {
    return step("id", await rung(`s.id = $1::uuid`, "1.0::float8", [subject.trim()]), null) ?? none(null, false);
  }
  const [{ n }] = await run(`SELECT normalize_entity_name($1) AS n`, [subject]);
  const normalized = (n as string | null) ?? null;
  if (normalized === null) return none(normalized, false);

  return step("exact", await rung(`s.normalized_name = $1`, "1.0::float8", [normalized]), normalized)
    ?? step("alias", await rung(`($1 = ANY(s.merged_from) OR EXISTS (SELECT 1 FROM unnest(s.aliases) a WHERE normalize_entity_name(a) = $1))`, "1.0::float8", [normalized]), normalized)
    ?? step("fuzzy", await rung(`similarity(s.normalized_name, $1) >= $2`, "similarity(s.normalized_name, $1)::float8", [normalized, FUZZY_FLOOR], ` LIMIT ${FUZZY_LIMIT}`), normalized)
    ?? none(normalized, false);
}

/**
 * The entities a report ranks around: the subjects that share the FIRST
 * subject's normalised name. The exact rung returns one name under several
 * types — all of them. The alias and fuzzy rungs can return several different
 * names (two entities the model gave the same alias; five near spellings);
 * ranking around their union would count a thought about the second as a
 * co-mention of the first and hide each as a neighbour of the others, so the
 * first name's entities alone are ranked and the rest are listed (second and
 * third review passes).
 */
export function rankedSubjects(res: Resolution): string[] {
  const lead = res.subjects[0];
  return lead ? res.subjects.filter((s) => s.normalized_name === lead.normalized_name).map((s) => s.id) : [];
}

/**
 * The whole graph's top entities, both orderings from one pass over the
 * tables: by mentions (then degree and support with edges on), and with edges
 * on by degree (then support and mentions) — the hubs. Each entity's counts are
 * computed once and ranked twice; a row comes back if it is in either top list.
 */
export async function topEntities(run: Runner, opts: Options): Promise<{ byMentions: EntityRow[]; byDegree: EntityRow[] }> {
  const params: unknown[] = [];
  const inScope = scopeSql("e", opts, params).where;
  params.push(opts.limit);
  const L = `$${params.length}`;
  const edgeCols = opts.edges ? `, coalesce(d.degree, 0) AS degree, coalesce(d.support, 0) AS support` : "";
  const edgeJoin = opts.edges
    ? `LEFT JOIN (SELECT x.entity_id, count(DISTINCT x.other_id)::int AS degree, count(DISTINCT x.thought_id)::int AS support
                   FROM ends x JOIN scope o ON o.id = x.other_id JOIN scope me ON me.id = x.entity_id GROUP BY 1) d ON d.entity_id = s.id`
    : "";
  const rows = await run(
    `WITH scope AS (SELECT e.id, e.entity_type, e.name, e.normalized_name FROM ob1_entities e WHERE ${inScope}),
          ${MENTIONS_CTE}${opts.edges ? `,\n          ${ENDS_CTE}` : ""},
          stats AS (
            SELECT s.id, s.entity_type, s.name, s.normalized_name, coalesce(m.mentions, 0) AS mentions${edgeCols}
              FROM scope s LEFT JOIN mentions m ON m.entity_id = s.id ${edgeJoin}),
          ranked AS (
            SELECT *, row_number() OVER (ORDER BY mentions DESC${opts.edges ? ", degree DESC, support DESC" : ""}, ${ENTITY_TIEBREAK})::int AS rm
                   ${opts.edges ? `, row_number() OVER (ORDER BY degree DESC, support DESC, mentions DESC, ${ENTITY_TIEBREAK})::int AS rd` : ", NULL::int AS rd"}
              FROM stats)
     SELECT id, entity_type, name, mentions${opts.edges ? ", degree, support" : ""}, rm, rd
       FROM ranked WHERE rm <= ${L}${opts.edges ? ` OR rd <= ${L}` : ""}`,
    params) as (EntityRow & { rm: number; rd: number | null })[];
  const strip = ({ rm: _rm, rd: _rd, ...e }: EntityRow & { rm: number; rd: number | null }): EntityRow => e;
  return {
    byMentions: rows.filter((r) => r.rm <= opts.limit).sort((a, b) => a.rm - b.rm).map(strip),
    byDegree: opts.edges ? rows.filter((r) => r.rd !== null && r.rd <= opts.limit).sort((a, b) => a.rd! - b.rd!).map(strip) : [],
  };
}

const EXCERPT = `regexp_replace(left(t.content, 160), '\\s+', ' ', 'g')`;
/** `created_at` as the server renders every timestamp (SMD-1328): ISO UTC whatever the session's TimeZone, null for none, `infinity` as its own text. */
const stampRows = (rows: Record<string, unknown>[]): ThoughtRow[] =>
  rows.map((r) => ({ ...r, created_at: isoTimestampOrNull(r.created_at) })) as ThoughtRow[];

/**
 * The whole graph's top thoughts: the ones that mention the most in-scope
 * entities and evidence the most in-scope edges — the thoughts that build the
 * graph, which on a ticket corpus are the epics (the hub caveat, stated).
 */
export async function topThoughts(run: Runner, opts: Options): Promise<ThoughtRow[]> {
  const params: unknown[] = [];
  const inScope = scopeSql("e", opts, params).where;
  params.push(opts.limit);
  const edgeCol = opts.edges
    ? `, (SELECT count(*) FROM ob1_entity_edges x JOIN scope a ON a.id = x.from_entity_id JOIN scope b ON b.id = x.to_entity_id WHERE x.thought_id = t.id)::int AS edges`
    : "";
  const rows = await run(
    `WITH scope AS (SELECT e.id FROM ob1_entities e WHERE ${inScope}),
          counted AS (
            SELECT t.id, t.created_at, ${EXCERPT} AS excerpt,
                   (SELECT count(DISTINCT te.entity_id) FROM thought_entities te JOIN scope s ON s.id = te.entity_id WHERE te.thought_id = t.id)::int AS entities${edgeCol}
              FROM thoughts t
             WHERE EXISTS (SELECT 1 FROM thought_entities te JOIN scope s ON s.id = te.entity_id WHERE te.thought_id = t.id))
     SELECT * FROM counted
      ORDER BY ${opts.edges ? "entities + edges DESC, " : ""}entities DESC, id
      LIMIT $${params.length}`,
    params);
  return stampRows(rows);
}

/**
 * The subject's neighbourhood: every in-scope entity that shares a thought with
 * it or an edge, ranked by co_mentions + support (co_mentions alone with edges
 * off). `relations` lists the edges between them as `relation×n`, n the
 * thoughts asserting it, both directions folded.
 */
export async function neighbourhood(run: Runner, subjectIds: readonly string[], opts: Options): Promise<NeighbourRow[]> {
  if (subjectIds.length === 0) return [];
  const params: unknown[] = [pgArray(subjectIds)];
  const inScope = scopeSql("e", opts, params).where;
  params.push(opts.limit);
  const edgeCtes = opts.edges
    ? `,
       ${ENDS_CTE},
       touching AS (SELECT x.other_id AS entity_id, x.thought_id, x.relation FROM ends x
                     WHERE x.entity_id = ANY($1::uuid[]) AND NOT (x.other_id = ANY($1::uuid[]))),
       per_relation AS (SELECT entity_id, relation, count(DISTINCT thought_id) AS n FROM touching GROUP BY 1, 2),
       ed AS (SELECT sup.entity_id, sup.support, rel.relations
                FROM (SELECT entity_id, count(DISTINCT thought_id)::int AS support FROM touching GROUP BY 1) sup
                JOIN (SELECT entity_id, string_agg(relation || '×' || n, ', ' ORDER BY n DESC, relation) AS relations FROM per_relation GROUP BY 1) rel
                  ON rel.entity_id = sup.entity_id)`
    : "";
  // Candidates first — the entities with a co-mention or an edge, which is
  // what `co` and `ed` hold, so no further filter is needed — then `mentions`,
  // a display and tiebreak column, counted for those alone (fourth review
  // pass; the whole-table aggregate was the shape the first pass removed from
  // the rungs).
  const rows = await run(
    `WITH scope AS (SELECT e.id, e.entity_type, e.name, e.normalized_name FROM ob1_entities e WHERE ${inScope}),
       subject_thoughts AS (SELECT DISTINCT te.thought_id FROM thought_entities te WHERE te.entity_id = ANY($1::uuid[])),
       co AS (SELECT te.entity_id, count(DISTINCT te.thought_id)::int AS co_mentions
                FROM thought_entities te JOIN subject_thoughts st ON st.thought_id = te.thought_id
               WHERE NOT (te.entity_id = ANY($1::uuid[])) GROUP BY 1)${edgeCtes},
       cand AS (${opts.edges
         ? `SELECT coalesce(co.entity_id, ed.entity_id) AS entity_id, coalesce(co.co_mentions, 0) AS co_mentions, coalesce(ed.support, 0) AS support, ed.relations
              FROM co FULL JOIN ed ON ed.entity_id = co.entity_id`
         : `SELECT entity_id, co_mentions FROM co`}),
       ranked AS (
         SELECT s.id, s.entity_type, s.name, s.normalized_name,
                (SELECT count(DISTINCT te.thought_id) FROM thought_entities te WHERE te.entity_id = s.id)::int AS mentions,
                c.co_mentions${opts.edges ? ", c.support, c.relations" : ""}
           FROM cand c JOIN scope s ON s.id = c.entity_id)
     SELECT id, entity_type, name, mentions, co_mentions${opts.edges ? ", support, relations" : ""}
       FROM ranked
      ORDER BY co_mentions${opts.edges ? " + support" : ""} DESC, mentions DESC, ${ENTITY_TIEBREAK}
      LIMIT $${params.length}`,
    params);
  return rows as NeighbourRow[];
}

/**
 * The thoughts that tie the subject to its neighbourhood: every thought
 * mentioning the subject, ranked by how many of the ranked neighbours it also
 * mentions plus (edges on) how many edge rows between the subject and anything
 * else it evidences.
 */
export async function subjectThoughts(run: Runner, subjectIds: readonly string[], neighbourIds: readonly string[], opts: Options): Promise<ThoughtRow[]> {
  if (subjectIds.length === 0) return [];
  const params: unknown[] = [pgArray(subjectIds), pgArray(neighbourIds), opts.limit];
  // An edge with the subject at exactly one end, the other end in scope — so a
  // numeric or out-of-type neighbour adds nothing here either.
  const edgeCol = opts.edges
    ? `, (SELECT count(*) FROM ob1_entity_edges x
           JOIN ob1_entities e ON e.id = CASE WHEN x.from_entity_id = ANY($1::uuid[]) THEN x.to_entity_id ELSE x.from_entity_id END
          WHERE x.thought_id = t.id
            AND (x.from_entity_id = ANY($1::uuid[])) <> (x.to_entity_id = ANY($1::uuid[]))
            AND ${scopeSql("e", opts, params).where})::int AS edges`
    : "";
  const rows = await run(
    `WITH counted AS (
       SELECT t.id, t.created_at, ${EXCERPT} AS excerpt,
              (SELECT count(DISTINCT te.entity_id) FROM thought_entities te WHERE te.thought_id = t.id AND te.entity_id = ANY($2::uuid[]))::int AS entities${edgeCol}
         FROM thoughts t
        WHERE EXISTS (SELECT 1 FROM thought_entities te WHERE te.thought_id = t.id AND te.entity_id = ANY($1::uuid[])))
     SELECT * FROM counted
      ORDER BY ${opts.edges ? "entities + edges DESC, " : ""}entities DESC, id
      LIMIT $3`,
    params);
  return stampRows(rows);
}

/** The caveats, with the run's own numbers where a caveat has one — printed every run, in both formats. */
export function caveats(c: Coverage, opts: Options): string[] {
  const n = c.numeric_names;
  const entities = `${n} ${n === 1 ? "entity" : "entities"} of the ranked types named only by digits, dots, colons and spaces`;
  const out = [
    `Centrality here is attention, not value or quality: what the extracted thoughts mention and connect most.`,
    `Edges are unweighted (SMD-1925): ${c.unit_edges} of ${c.edges} edge rows carry confidence 1.00, so an edge's only weight is the number of thoughts asserting it (support).`,
    opts.excludeNumeric
      ? `Entity typing is noisy (SMD-1935): ${entities} ${n === 1 ? "is" : "are"} out of scope and out of every count (--keep-numeric admits ${n === 1 ? "it" : "them"}; --types narrows further).`
      : `Entity typing is noisy (SMD-1935): --keep-numeric is on, so ${entities} count${n === 1 ? "s" : ""} like any other.`,
    `Hubs and clusters inflate each other: a name most thoughts mention, or an epic its children all connect to, lifts everything around it.`,
    `No recency term: a thought captured a minute ago about its own subject ranks as any other.`,
    `The graph holds no ticket status; open/closed is the caller's filter against the source.`,
    `Coverage: ${c.extracted} of ${c.thoughts} thoughts have extracted entities${c.extraction_key ? ` (extraction key ${c.extraction_key})` : " (no extraction key: db/extract-entities.ts has not run)"}; a thought the worker has not reached, or found no entity in, is not in the graph (extract-entities.ts --status tells the two apart).`,
  ];
  if (!opts.edges) out.push(`--no-edges: ranked by co-occurrence alone; the difference from the default run is what the edges add.`);
  return out;
}

export type Report = {
  subject: string | null;
  resolution: Resolution | null;
  /** The entities ranked around: the subjects sharing the first subject's normalised name (`rankedSubjects`); `resolution.subjects` may list more. */
  subject_ids: string[];
  options: Options;
  coverage: Coverage;
  caveats: string[];
  by_mentions?: EntityRow[];
  by_degree?: EntityRow[];
  thoughts: ThoughtRow[];
  neighbours?: NeighbourRow[];
};

/** One run, as the CLI prints it and as `--json` emits it. */
export async function report(run: Runner, subject: string | null, opts: Options): Promise<Report> {
  const cov = await coverage(run, opts);
  const base = { subject, options: opts, coverage: cov, caveats: caveats(cov, opts) };
  if (subject === null) {
    const { byMentions, byDegree } = await topEntities(run, opts);
    return { ...base, resolution: null, subject_ids: [], by_mentions: byMentions, by_degree: byDegree, thoughts: await topThoughts(run, opts) };
  }
  const resolution = await resolveSubject(run, subject, opts);
  const ids = rankedSubjects(resolution);
  const neighbours = await neighbourhood(run, ids, opts);
  const thoughts = await subjectThoughts(run, ids, neighbours.map((n) => n.id), opts);
  return { ...base, resolution, subject_ids: ids, neighbours, thoughts };
}

// ── Rendering ────────────────────────────────────────────────────────────────

type Col = { key: string; head: string; right?: boolean; width?: number };
/** One cap for the entity-name column in every table, so the same name renders the same in the whole-graph and neighbourhood reports (the edges-on/off control diffs them). */
const NAME_WIDTH = 60;

function table(rows: Record<string, unknown>[], cols: Col[]): string {
  // Names and excerpts are model output: control characters out, whitespace
  // to one space, as db/consolidate.ts renders the same columns (sixth review pass).
  const cell = (r: Record<string, unknown>, k: string) => (r[k] === null || r[k] === undefined ? "" : cleanForDisplay(String(r[k])).replace(/\s+/g, " "));
  const widths = cols.map((c) => Math.min(c.width ?? 80, Math.max(c.head.length, ...rows.map((r) => cell(r, c.key).length))));
  const line = (vals: string[]) => vals.map((v, i) => (cols[i].right ? v.padStart(widths[i]) : v.padEnd(widths[i]))).join("  ").trimEnd();
  // A cell over its column's cap is cut and marked, never cut silently.
  const fit = (v: string, w: number) => (v.length > w ? `${v.slice(0, Math.max(0, w - 1))}…` : v);
  const out = [line(cols.map((c, i) => fit(c.head, widths[i]))), line(widths.map((w) => "-".repeat(w)))];
  for (const r of rows) out.push(line(cols.map((c, i) => fit(cell(r, c.key), widths[i]))));
  return out.join("\n");
}

const E_COLS = (edges: boolean): Col[] => [
  { key: "mentions", head: "mentions", right: true },
  ...(edges ? [{ key: "degree", head: "degree", right: true }, { key: "support", head: "support", right: true }] : []),
  { key: "entity_type", head: "type" },
  { key: "name", head: "entity", width: NAME_WIDTH },
];
const T_COLS = (edges: boolean, entitiesHead: string): Col[] => [
  { key: "entities", head: entitiesHead, right: true },
  ...(edges ? [{ key: "edges", head: "edges", right: true }] : []),
  { key: "id", head: "thought" },
  { key: "created_at", head: "captured", width: 24 },
  { key: "excerpt", head: "excerpt", width: 90 },
];

export function render(r: Report): string {
  const out: string[] = [];
  const o = r.options;
  const everyType = ENTITY_TYPES.every((t) => o.types.includes(t));
  out.push(`graph-centrality — ${r.subject === null ? "the whole graph" : `around ${JSON.stringify(r.subject)}`}; scope ${everyType ? "every type" : o.types.join(",")}${o.excludeNumeric ? ", numeric names excluded" : ", numeric names kept"}; edges ${o.edges ? "on" : "OFF (control)"}; top ${o.limit}`);
  out.push(`${r.coverage.entities} entities in scope; ${r.coverage.edges} edge rows in the whole graph`);
  out.push("");
  if (r.resolution) {
    const res = r.resolution;
    if (res.how === "none") {
      const shown = JSON.stringify(r.subject);
      if (res.excluded) out.push(`No entity resolves from ${shown}: what it matches is an entity named only by digits, dots, colons and spaces (SMD-1935's noise), out of scope by default — pass --keep-numeric to rank it.`);
      else if (UUID_RE.test((r.subject ?? "").trim())) out.push(`No entity has the id ${shown}.`);
      else if (res.normalized === null) out.push(`No entity resolves from ${shown} — the name is only punctuation.`);
      else out.push(`No entity resolves from ${shown} (normalised: ${JSON.stringify(res.normalized)}; nothing exact, no alias or merged name, nothing within trigram similarity ${FUZZY_FLOOR}${res.hidden_guesses ? ` except ${res.hidden_guesses} numeric-named entit${res.hidden_guesses === 1 ? "y" : "ies"} the rule hides — --keep-numeric offers ${res.hidden_guesses === 1 ? "it" : "them"} as guesses` : ""}).`);
    } else {
      const several = res.subjects.length > r.subject_ids.length ? " — several names match; ranked around the first, pass the name shown to be exact" : "";
      const label = { id: "by id", exact: "exact match on the normalised name", alias: `by alias or merged-in name${several}`, fuzzy: `by trigram similarity — GUESSES, ranked around the first; pass the name shown to be exact` }[res.how];
      out.push(`Subject (${label}):`);
      for (const s of res.subjects) out.push(`  ${r.subject_ids.includes(s.id) ? "▸" : " "} ${s.entity_type} ${JSON.stringify(s.name)} — ${s.mentions} mention${s.mentions === 1 ? "" : "s"}${res.how === "fuzzy" ? ` (similarity ${s.score.toFixed(2)})` : ""}  ${s.id}`);
    }
    out.push("");
    if (r.neighbours && r.neighbours.length) {
      out.push(`Neighbourhood — ranked by co_mentions${o.edges ? " + support" : ""}:`);
      out.push(table(r.neighbours as Record<string, unknown>[], [
        { key: "co_mentions", head: "co_mentions", right: true },
        ...(o.edges ? [{ key: "support", head: "support", right: true }] : []),
        { key: "mentions", head: "mentions", right: true },
        { key: "entity_type", head: "type" },
        { key: "name", head: "entity", width: NAME_WIDTH },
        ...(o.edges ? [{ key: "relations", head: "relations (thoughts asserting each; can sum past support)", width: 60 }] : []),
      ]));
      out.push("");
    } else if (res.how !== "none") {
      out.push("No neighbour: nothing in scope shares a thought or an edge with the subject.");
      out.push("");
    }
    if (r.thoughts.length) {
      out.push(`Thoughts mentioning the subject — ranked by neighbours mentioned${o.edges ? " + subject edges evidenced" : ""}:`);
      out.push(table(r.thoughts as Record<string, unknown>[], T_COLS(o.edges, "neighbours")));
      out.push("");
    }
  } else {
    out.push(`Top entities by mentions:`);
    out.push(table((r.by_mentions ?? []) as Record<string, unknown>[], E_COLS(o.edges)));
    out.push("");
    if (o.edges) {
      out.push(`Top entities by degree — the hubs:`);
      out.push(table((r.by_degree ?? []) as Record<string, unknown>[], E_COLS(true)));
      out.push("");
    }
    out.push(`Top thoughts — by in-scope entities mentioned${o.edges ? " + in-scope edges evidenced" : ""}:`);
    out.push(table(r.thoughts as Record<string, unknown>[], T_COLS(o.edges, "entities")));
    out.push("");
  }
  out.push("Caveats:");
  for (const c of r.caveats) out.push(`  • ${c}`);
  return out.join("\n");
}

// ── CLI ──────────────────────────────────────────────────────────────────────

export type Parsed = { url?: string; subject: string | null; opts: Options; json: boolean };

/** argv → options and subject, or a usage error. Exported for the suite. */
export function parseArgs(argv: readonly string[]): Parsed | { error: string } {
  const opts: Options = { ...DEFAULT_OPTIONS };
  let url: string | undefined;
  let json = false;
  const positional: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      if (seen.has(a)) return { error: `${a} given twice` };
      seen.add(a);
    }
    const value = (): string | { error: string } => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) return { error: `${a} needs a value` };
      i++;
      return v;
    };
    if (a === "--url") {
      const v = value();
      if (typeof v !== "string") return v;
      url = v;
    } else if (a === "--limit") {
      const v = value();
      if (typeof v !== "string") return v;
      // Decimal digits only: Number() would read "0x10", "1e2" and " 7" as integers.
      const n = /^\d+$/.test(v) ? Number(v) : NaN;
      if (!Number.isInteger(n) || n < 1 || n > 500) return { error: `--limit must be a decimal integer from 1 to 500, got ${JSON.stringify(v)}` };
      opts.limit = n;
    } else if (a === "--types") {
      const v = value();
      if (typeof v !== "string") return v;
      const types = [...new Set(v.split(",").map((t) => t.trim()).filter(Boolean))];
      const bad = types.filter((t) => !(ENTITY_TYPES as readonly string[]).includes(t));
      if (bad.length || types.length === 0) return { error: `--types takes a comma list of ${ENTITY_TYPES.join(", ")}; ${bad.length ? `not ${bad.map((b) => JSON.stringify(b)).join(", ")}` : "none given"}` };
      opts.types = types as EntityType[];
    } else if (a === "--keep-numeric") opts.excludeNumeric = false;
    else if (a === "--no-edges") opts.edges = false;
    else if (a === "--json") json = true;
    else if (a.startsWith("--")) return { error: `unknown flag ${a}` };
    else if (a.trim() === "") return { error: "the subject is empty; leave it out for the whole graph" };
    else positional.push(a);
  }
  if (positional.length > 1) return { error: `one subject at a time; got ${positional.map((p) => JSON.stringify(p)).join(", ")} — quote a name with spaces` };
  return { url, subject: positional[0] ?? null, opts, json };
}

if (import.meta.main) {
  const parsed = parseArgs(process.argv.slice(2));
  if ("error" in parsed) {
    console.error(parsed.error);
    console.error(`usage: bun graph-centrality.ts --url postgres://… ["subject"] [--limit N (1-500)] [--types a,b] [--keep-numeric] [--no-edges] [--json]   (exit 0 ranked, 1 no entity, 3 excluded by the numeric rule, 2 error)`);
    process.exit(2);
  }
  const url = parsed.url ?? process.env.DATABASE_URL;
  if (!url) {
    console.error("No database URL. Pass --url or set DATABASE_URL.");
    process.exit(2);
  }
  const sql = new SQL({ url, max: 1 });
  const run: Runner = async (text, params) => (await sql.unsafe(text, params as never[])) as unknown as Record<string, unknown>[];
  // The exit code is decided inside and applied after the connection has
  // closed and the output has been written (process.exit inside the try would
  // skip the finally, and could cut a piped --json short).
  // 0 ranked; 1 the subject resolved to nothing; 3 the subject IS an entity
  // and the numeric-name rule excluded it (--keep-numeric would rank it); 2 a
  // usage error, a brain without 016, or a query that failed — never 1 for a
  // failure or an exclusion, so a caller testing for "not in the graph" is not
  // told that by a connection refused or by SMD-1935's rule.
  let code = 0;
  try {
    // The three tables as this connection resolves them — a same-named table in
    // a schema off the search_path is not the graph.
    const [{ n }] = await run(`SELECT (to_regclass('ob1_entities') IS NOT NULL)::int + (to_regclass('thought_entities') IS NOT NULL)::int + (to_regclass('ob1_entity_edges') IS NOT NULL)::int AS n`, []);
    if (Number(n) !== 3) {
      console.error("This brain has no entity graph: migration 016 is not applied. Run db/migrate.ts, then db/extract-entities.ts.");
      code = 2;
    } else {
      const r = await report(run, parsed.subject, parsed.opts);
      if (parsed.json) console.log(JSON.stringify(r, null, 2));
      else console.log(render(r));
      code = r.resolution && r.resolution.how === "none" ? (r.resolution.excluded ? 3 : 1) : 0;
    }
  } catch (e) {
    console.error(`graph-centrality failed: ${(e as Error).message}`);
    code = 2;
  } finally {
    await sql.close();
  }
  process.exit(code);
}
