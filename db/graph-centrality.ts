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
 *   bun db/graph-centrality.ts --url … "Open Brain" --status open  # …as the live tickets build it
 *   bun db/graph-centrality.ts --url … --status open --startable   # …as the tickets you could start now build it
 *   --limit N (20, at most 500)   --types project,tool,…   --keep-numeric   --json
 *   --status all|open|active|done (all)   --decay-done   --startable
 *
 * ── Lifecycle (SMD-1994) ────────────────────────────────────────────────────
 * board-sync (SMD-1954) stamps every synced ticket's metadata with Linear's
 * state — `status` ("Done"), `status_type` (triage / backlog / unstarted /
 * started / completed / canceled) and `linear_updated_at` — so a thought's
 * lifecycle is on the row, and this reads it. One rule carries both the filter
 * and the decay: every thought has a WEIGHT, and every count of thoughts is a
 * sum of weights. A thought whose status the filter keeps weighs 1; one it
 * drops weighs 0; under `--decay-done` a completed or canceled thought weighs
 * `DONE_WEIGHT` (0.25, pre-registered here, one weight, exact in binary so the
 * sums are too). A row's lifecycle is its TICKET's: a row carrying a ticket
 * (`issue`) or derived from one (`ticket` — SMD-2059's dated sections) takes
 * the status of the ticket's head — of the rows carrying that `issue`, one
 * nothing supersedes before one superseded, the newest sync before an older,
 * then the id — so a Done ticket's observations and its superseded earlier
 * rows are settled with it; a row with no ticket claim takes the status keys
 * on its own row, if any. A twin the sync chained under a head without an
 * `issue` of its own (a hand paste adopted after the fact) is such a row: it
 * keeps its own lifecycle, which is none. A thought with no status — a hand
 * capture, a status_type this file does not know — weighs 1 whatever the flags
 * say: it passes every filter, and the output counts how many did rather than
 * calling it open. So mentions, support, co_mentions and the per-relation
 * counts are weighted sums (whole numbers unless decay is on); degree counts
 * NEIGHBOURS, not evidence, so a filter removes an edge with no live evidence
 * and decay leaves it. A thought is listed when it weighs more than 0 and
 * ranks by its weight times its score. Default `--status all` without decay is
 * every weight 1 — today's counts, by construction.
 *
 *   open    = triage, backlog, unstarted, started   (not completed or canceled)
 *   active  = unstarted, started                    (on the board and moving)
 *   done    = completed, canceled
 *
 * `LIFECYCLE_CTE` is the one place the status comes from. Today it is
 * `thoughts.metadata`, a scalar the sync overwrites each pass; the status
 * transitions themselves are on `thought_audit` (046), and when SMD-2074 folds
 * them into a node-state projection, that CTE reads the projection and nothing
 * downstream changes — `weightsSql`, the counts and the callers see the same
 * three columns.
 *
 * ── Startability (SMD-2061) ─────────────────────────────────────────────────
 * The lifecycle says whether a ticket is open; it does not say whether it can
 * be started. The board says that too: migration 053 (SMD-1867) stores a
 * ticket's relations as `link` facets on the row holding its identity
 * (`thought_sources`), and the Linear mapping writes `blocks` on the blocker
 * and `blocked_by` on the blocked. `--startable` reads both directions — an
 * edge the sync stated on one side only still counts — and multiplies a second
 * factor into the same weight: a thought whose ticket has an OPEN blocker
 * weighs 0. A blocker is open unless its own lifecycle, read through the
 * `lifecycle` rows above via `source_thought()` (053's resolver), is completed
 * or canceled: a settled blocker is not a blocker. A blocker the brain does not
 * hold, or one with no lifecycle, still blocks — the source said "blocked" and
 * nothing here says it is settled — and the output counts such blockers rather
 * than hiding them. A row derived from a ticket (`ticket`) or carrying one
 * (`issue`) takes its ticket's blockers, as it takes its ticket's status.
 * Only an active link counts (`valid_until` unset — 053 closes a relation the
 * source dropped), and only `blocks` / `blocked_by`: a parent is not blocked
 * by its children (`child_of`), nor a ticket by what it relates to.
 * A thought with no link facet counts as unblocked, and the output states how
 * many carry one. Without the flag the dependency read is not in the SQL at
 * all, so the default is SMD-1994's output byte for byte and a brain without
 * 053 runs every other mode. `DEPENDENCY_CTE` is the seam, as `LIFECYCLE_CTE`
 * is for the status: SMD-2074's node-state projection replaces it, not its
 * callers.
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
 *   • Ticket status is read from synced metadata (board-sync, SMD-1954): as
 *     fresh as the last pass, on the synced rows alone, and by default every
 *     thought weighs 1 — a Done ticket counts as a live one until `--status`
 *     or `--decay-done` says otherwise. The lifecycle line gives the numbers.
 *   • Dependencies (`--startable`) are the board's link facets, as fresh as
 *     the same last pass: a ticket unblocked since then still weighs 0 until
 *     the sync closes the link. The dependency line gives the numbers.
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
/** Linear's state types, as board-sync writes `metadata.status_type`; any other value is no lifecycle. */
export const LIFECYCLE_TYPES = ["triage", "backlog", "unstarted", "started", "completed", "canceled"] as const;
export type LifecycleType = (typeof LIFECYCLE_TYPES)[number];
export type LifecycleFilter = "all" | "open" | "active" | "done";
/** The status types each `--status` keeps at weight 1; the other known types weigh 0 (or DONE_WEIGHT under decay). */
export const LIFECYCLE_FILTERS: Record<LifecycleFilter, readonly LifecycleType[]> = {
  all: LIFECYCLE_TYPES,
  open: ["triage", "backlog", "unstarted", "started"],
  active: ["unstarted", "started"],
  done: ["completed", "canceled"],
};
/** What a completed or canceled thought weighs under `--decay-done`: pre-registered, one value, exact in binary. */
export const DONE_WEIGHT = 0.25;

export type Options = Scope & {
  limit: number;
  /** With edges off, no edge count is read or ranked on: the control. */
  edges: boolean;
  /** Which lifecycles weigh 1; the rest weigh 0. `all` is every thought at 1 — today's counts. */
  status: LifecycleFilter;
  /** With `all`: a completed or canceled thought weighs DONE_WEIGHT instead of 1. Refused with any other filter. */
  decayDone: boolean;
  /** A thought whose ticket has an open blocker weighs 0, whatever its lifecycle weighs. Off: no dependency is read. */
  startable: boolean;
};
export const DEFAULT_OPTIONS: Options = { types: ENTITY_TYPES, excludeNumeric: true, limit: DEFAULT_LIMIT, edges: true, status: "all", decayDone: false, startable: false };

export type EntityRow = { id: string; entity_type: string; name: string; mentions: number; degree?: number; support?: number };
export type ThoughtRow = { id: string; created_at: string | null; excerpt: string; entities: number; edges?: number; status: string | null; status_type: string | null; weight: number };
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
export type Coverage = {
  thoughts: number; extracted: number; entities: number; numeric_names: number; edges: number; unit_edges: number; extraction_key: string | null;
  /** Thoughts whose lifecycle — their own keys, or their ticket head's — names a status_type LIFECYCLE_TYPES has. */
  with_lifecycle: number;
  /** Thoughts carrying a status_type this file does not know — weighed 1, counted here rather than passed off as open. */
  unknown_status: number;
  /** Thoughts completed or canceled. */
  done: number;
  /** Thoughts weighing more than 0 under the run's flags — with `--status all`, every thought. */
  weighed: number;
  /** The latest linear_updated_at among the thoughts with a lifecycle: the statuses are no older than this. Null when none is stamped. */
  last_sync: string | null;
  /** Under `--startable` alone: what the dependency read found. */
  dependencies?: Dependencies;
};
export type Dependencies = {
  /** Active `blocks` / `blocked_by` link facets — each side of a relation the sync stated on both is one. */
  edges: number;
  /** Thoughts whose ticket holds an active link facet of any relation: the board's relations were read for them. The rest count as unblocked. */
  with_links: number;
  /** Thoughts whose ticket has an open blocker: they weigh 0 this run. */
  blocked: number;
  /** Blockers still in force because nothing says they are settled — not in the brain, or with no lifecycle. */
  unknown_blockers: number;
  /** The latest link facet written or closed. Null when the brain holds none. */
  last_link_change: string | null;
};

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

/**
 * Where a thought's lifecycle comes from — the one seam. Today: the three keys
 * board-sync stamps on `thoughts.metadata` (SMD-1954), a scalar the sync
 * overwrites each pass. When SMD-2074's node-state projection folds the
 * transitions `thought_audit` (046) already holds, this reads that instead;
 * `weightsSql` and every count below see the same three columns either way.
 */
// A row's lifecycle is its TICKET's. board-sync stamps the status on the
// ticket's head row alone (the `issue` row nothing supersedes); a superseded
// earlier row keeps the status it froze at, and a row derived from the ticket
// — SMD-2059's dated sections, carrying `ticket` and no status — has none of
// its own. So `heads` picks one row per issue (un-superseded first, then the
// newest sync, then the id) and every row carrying `issue` or `ticket` reads
// that head's three keys, falling back to its own; a row with no ticket reads
// its own (first review pass).
export const LIFECYCLE_CTE = `heads AS (
            SELECT p.metadata->>'issue' AS issue, p.metadata->>'status' AS status, p.metadata->>'status_type' AS status_type, p.metadata->>'linear_updated_at' AS synced_at,
                   row_number() OVER (PARTITION BY p.metadata->>'issue'
                                      ORDER BY (NOT EXISTS (SELECT 1 FROM thoughts s WHERE s.supersedes = p.id)) DESC, p.metadata->>'linear_updated_at' DESC NULLS LAST, p.id) AS rn
              FROM thoughts p WHERE p.metadata ? 'issue'),
          lifecycle AS (
            SELECT t.id AS thought_id,
                   coalesce(h.status, t.metadata->>'status') AS status,
                   coalesce(h.status_type, t.metadata->>'status_type') AS status_type,
                   coalesce(h.synced_at, t.metadata->>'linear_updated_at') AS synced_at
              FROM thoughts t
              LEFT JOIN heads h ON h.rn = 1 AND h.issue = coalesce(t.metadata->>'ticket', t.metadata->>'issue'))`;

/**
 * Where a thought's open blockers come from — the second seam, read after
 * `lifecycle` and only under `--startable`. Today: 053's active `blocks` /
 * `blocked_by` link facets, each resolved to the (system, blocked, blocker)
 * identities it states; a blocker whose lifecycle is completed or canceled
 * (the types in `$doneSlot`) is dropped. `dependency` is one row per thought
 * with an open blocker, its blockers' identities sorted. When SMD-2074's
 * node-state projection holds startability, this reads that instead.
 */
// The identities are the join key, never a thought id: a link names its
// target by identity (053), and a ticket's rows — its head, its superseded
// twins, SMD-2059's derived sections — share one. `ticket_of` gives each
// thought its ticket the way LIFECYCLE_CTE does (the row's own source
// identity, else its `ticket`, else its `issue` — the board sync's linear
// claim), and `blockers` resolves a blocker once per edge through
// source_thought(), the resolver 053 ships for readers, then reads that
// thought's row of `lifecycle`, so a blocker's status is its ticket head's.
export const dependencySql = (doneSlot: number) => `ticket_of AS (
            SELECT thought_id, system, identity FROM thought_sources
            UNION
            SELECT t.id, 'linear', coalesce(t.metadata->>'ticket', t.metadata->>'issue') FROM thoughts t WHERE t.metadata ? 'ticket' OR t.metadata ? 'issue'),
          deps AS MATERIALIZED (
            SELECT DISTINCT s.system,
                   CASE WHEN f.payload->>'relation' = 'blocked_by' THEN s.identity ELSE f.payload->>'target' END AS blocked,
                   CASE WHEN f.payload->>'relation' = 'blocked_by' THEN f.payload->>'target' ELSE s.identity END AS blocker
              FROM thought_facets f JOIN thought_sources s ON s.thought_id = f.thought_id AND s.system = f.payload->>'system'
             WHERE f.kind = 'link' AND f.valid_until IS NULL AND f.payload->>'relation' IN ('blocks', 'blocked_by')),
          blockers AS MATERIALIZED (
            SELECT d.system, d.blocked, d.blocker, bl.status_type AS blocker_status
              FROM (SELECT d.system, d.blocked, d.blocker, source_thought(d.system, d.blocker) AS blocker_id FROM deps d) d
              LEFT JOIN lifecycle bl ON bl.thought_id = d.blocker_id
             WHERE bl.status_type IS NULL OR NOT bl.status_type = ANY($${doneSlot}::text[])),
          dependency AS (
            SELECT k.thought_id, array_agg(DISTINCT b.blocker ORDER BY b.blocker) AS blockers
              FROM ticket_of k JOIN blockers b ON b.system = k.system AND b.blocked = k.identity
             GROUP BY 1)`;

/**
 * The per-thought weight, as the header defines it, with `lifecycle` before
 * it: a kept status 1; another known status 0, or DONE_WEIGHT under decay; no
 * status, or one this file does not know, 1 — and under `--startable`, times 0
 * when the thought's ticket has an open blocker. Returns the CTE text
 * (lifecycle, the dependency CTEs under `--startable`, and weights, no leading
 * comma) with its array parameters appended to `params` — under `--startable`
 * the done types first, then always the kept types and the known types, so the
 * known types are the last slot and a query places its own after them.
 */
export function weightsSql(opts: Pick<Options, "status" | "decayDone"> & Partial<Pick<Options, "startable">>, params: unknown[]): string {
  // The rule parseArgs applies, applied here too for a caller that builds its
  // own Options: decay and a filter are two answers to one question.
  if (opts.decayDone && opts.status !== "all") throw new Error(`weightsSql: --decay-done with --status ${opts.status}; pass one or the other`);
  let dependency = "";
  if (opts.startable) {
    params.push(pgArray(LIFECYCLE_FILTERS.done));
    dependency = `,\n          ${dependencySql(params.length)}`;
  }
  params.push(pgArray(opts.decayDone ? LIFECYCLE_FILTERS.open : LIFECYCLE_FILTERS[opts.status]));
  const kept = params.length;
  params.push(pgArray(LIFECYCLE_TYPES));
  const known = params.length;
  // The literal is a float8 written as SQL text — DONE_WEIGHT is a constant of
  // this file, not input — so the type of `w` is float8 in every branch. The
  // status name is shown only beside a status_type this file knows, so the
  // column and the "carry a lifecycle" count agree (first review pass).
  // MATERIALIZED: a query that reads `weights` once, inside a correlated
  // subquery — the rungs' mention count — would otherwise have the planner
  // inline heads and lifecycle into it and scan `thoughts` once per candidate
  // row; materialised, the weights are computed once per statement whatever
  // the reference count (second review pass).
  // Without --startable the text is SMD-1994's exactly: the flag adds the
  // dependency CTEs, the factor and the join, and nothing else moves.
  return `${LIFECYCLE_CTE}${dependency},
          weights AS MATERIALIZED (SELECT thought_id, CASE WHEN status_type = ANY($${known}::text[]) THEN status END AS status, status_type,
                             (CASE WHEN status_type = ANY($${kept}::text[]) THEN 1.0
                                   WHEN status_type = ANY($${known}::text[]) THEN ${opts.decayDone ? DONE_WEIGHT : 0}
                                   ELSE 1.0 END${opts.startable ? " * CASE WHEN blockers IS NULL THEN 1.0 ELSE 0 END" : ""})::float8 AS w
                        FROM lifecycle${opts.startable ? " LEFT JOIN dependency USING (thought_id)" : ""})`;
}

/**
 * Mentions per in-scope entity as a weighted sum over the thoughts mentioning
 * it — thought_entities holds one row per (thought, entity), so no DISTINCT
 * is needed. Every query using it has `scope` and `weights` CTEs before it.
 */
const MENTIONS_CTE = `mentions AS (SELECT te.entity_id, sum(w.w)::float8 AS mentions FROM thought_entities te JOIN weights w ON w.thought_id = te.thought_id
                        WHERE te.entity_id IN (SELECT id FROM scope) GROUP BY 1)`;
/** A weighted count rendered as SQL text: whole numbers plain, else to two places (the per-relation counts in `relations`). */
const FMT = (expr: string) => `CASE WHEN ${expr} = trunc(${expr}) THEN (${expr})::bigint::text ELSE round((${expr})::numeric, 2)::text END`;
/** Every edge from both ends: (entity, the other entity, the evidencing thought, relation). */
const ENDS_CTE = `ends AS (
    SELECT from_entity_id AS entity_id, to_entity_id AS other_id, thought_id, relation FROM ob1_entity_edges
    UNION ALL
    SELECT to_entity_id, from_entity_id, thought_id, relation FROM ob1_entity_edges)`;
/** The entity tiebreak every ranking ends on, unqualified: each query has one relation carrying the two columns. */
const ENTITY_TIEBREAK = `normalized_name, entity_type`;

/** How much of the brain the graph covers, and the two measured caveats' numbers. */
export async function coverage(run: Runner, opts: Options): Promise<Coverage> {
  // numeric_names is the rule's own effect: numeric names AMONG the ranked
  // types, since a numeric name of another type is out by type whatever the
  // rule says (third review pass).
  // The numeric count reads the slots scopeSql bound, binding the pattern
  // itself only when the rule is off and scopeSql did not (one binding per value).
  const params: unknown[] = [];
  const sc = scopeSql("e", opts, params);
  const patternSlot = sc.patternSlot ?? params.push(NUMERIC_NAME_RE);
  const weights = weightsSql(opts, params);
  const knownSlot = params.length;
  params.push(pgArray(LIFECYCLE_FILTERS.done));
  const doneSlot = params.length;
  // The dependency counts read the CTEs weightsSql emitted under --startable.
  // An edge is a facet row, so a relation the sync stated on both sides is
  // two; `with_links` asks whether the ticket's holder has any active link at
  // all — its relations were read — and `unknown_blockers` counts distinct
  // blockers in force that no lifecycle settles or opens.
  const dependencyCols = opts.startable
    ? `,
            (SELECT count(*) FROM thought_facets WHERE kind = 'link' AND valid_until IS NULL AND payload->>'relation' IN ('blocks', 'blocked_by'))::int AS dep_edges,
            (SELECT count(DISTINCT k.thought_id) FROM ticket_of k
              WHERE EXISTS (SELECT 1 FROM thought_facets f JOIN thought_sources s ON s.thought_id = f.thought_id AND s.system = f.payload->>'system'
                             WHERE f.kind = 'link' AND f.valid_until IS NULL AND s.system = k.system AND s.identity = k.identity))::int AS dep_with_links,
            (SELECT count(*) FROM dependency)::int AS dep_blocked,
            (SELECT count(*) FROM (SELECT DISTINCT system, blocker FROM blockers WHERE blocker_status IS NULL OR NOT blocker_status = ANY($${knownSlot}::text[])) u)::int AS dep_unknown,
            (SELECT max(greatest(created_at, valid_until)) FROM thought_facets WHERE kind = 'link') AS dep_last_change`
    : "";
  const [r] = await run(
    `WITH ${weights}
     SELECT (SELECT count(*) FROM thoughts)::int AS thoughts,
            (SELECT count(DISTINCT thought_id) FROM thought_entities)::int AS extracted,
            (SELECT count(*) FROM ob1_entities e WHERE ${sc.where})::int AS entities,
            (SELECT count(*) FROM ob1_entities WHERE normalized_name ~ $${patternSlot} AND entity_type = ANY($${sc.typesSlot}::text[]))::int AS numeric_names,
            (SELECT count(*) FROM ob1_entity_edges)::int AS edges,
            (SELECT count(*) FROM ob1_entity_edges WHERE confidence = 1)::int AS unit_edges,
            (SELECT value FROM ob1_config WHERE key = 'entity_extraction_key') AS extraction_key,
            (SELECT count(*) FROM lifecycle WHERE status_type = ANY($${knownSlot}::text[]))::int AS with_lifecycle,
            (SELECT count(*) FROM lifecycle WHERE status_type IS NOT NULL AND NOT status_type = ANY($${knownSlot}::text[]))::int AS unknown_status,
            (SELECT count(*) FROM lifecycle WHERE status_type = ANY($${doneSlot}::text[]))::int AS done,
            (SELECT count(*) FROM weights WHERE w > 0)::int AS weighed,
            (SELECT max(synced_at) FROM lifecycle WHERE status_type = ANY($${knownSlot}::text[])) AS last_sync${dependencyCols}`,
    params);
  if (!opts.startable) return r as Coverage;
  const { dep_edges, dep_with_links, dep_blocked, dep_unknown, dep_last_change, ...base } = r;
  return {
    ...(base as Coverage),
    dependencies: { edges: Number(dep_edges), with_links: Number(dep_with_links), blocked: Number(dep_blocked), unknown_blockers: Number(dep_unknown), last_link_change: isoTimestampOrNull(dep_last_change) },
  };
}

/**
 * The subject, one rung at a time. `normalized` is what the rule made of the
 * input; null when it is only punctuation, and nothing can match it. The type
 * scope does not apply here — it says what to rank around the subject — and
 * the numeric rule does, so "021" is not a subject unless numerics are kept.
 */
export async function resolveSubject(run: Runner, subject: string, opts: Options): Promise<Resolution> {
  // Every rung runs ONCE, without the numeric rule, and marks each row in or
  // out of it; rows in the rule sort first, so a LIMIT keeps them. The ladder
  // reads the partition: rows in → the subject; only rows out → "the match
  // exists, the rule hid it", which is the stop that names --keep-numeric;
  // nothing → the next rung. One query and one rule for every rung — the
  // first, third and fifth passes had each patched one rung with a second,
  // unscoped probe, and the fuzzy rung still had none (sixth review pass).
  // The type scope does not apply here: it says what to rank around the
  // subject. The mention count is MENTIONS_CTE's, correlated — an index probe
  // into thought_entities per CANDIDATE row against the weights materialised
  // once, since the ORDER BY reads it: one for an exact or alias match, one
  // per entity above the similarity floor on the fuzzy rung.
  /** A rung's rows: those in the rule (the subject, if any) and how many the rule kept out. */
  type RungResult = { hit: SubjectRow[]; out: number };
  const rung = async (how: string, score: string, params: unknown[], limit = ""): Promise<RungResult> => {
    params.push(NUMERIC_NAME_RE);
    const pattern = params.length;
    const weights = weightsSql(opts, params);
    const rows = await run(
      `WITH ${weights}
       SELECT s.id, s.entity_type, s.name, s.normalized_name,
              (SELECT coalesce(sum(w.w), 0) FROM thought_entities te JOIN weights w ON w.thought_id = te.thought_id WHERE te.entity_id = s.id)::float8 AS mentions,
              ${score} AS score,
              (${opts.excludeNumeric ? "true" : "false"} AND s.normalized_name ~ $${pattern}) AS excluded
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
 * Under a filter — a `--status` other than `all`, or `--startable` — an entity
 * no kept thought mentions is not in the run: the graph is the graph the kept
 * thoughts build (an edge's thoughts mention both its ends, so no mentions
 * means no degree either). Under `all` without `--startable` — decay too —
 * every in-scope entity is listed as before, an orphan at 0 included (first
 * review pass: the default lists exactly what it listed).
 */
export async function topEntities(run: Runner, opts: Options): Promise<{ byMentions: EntityRow[]; byDegree: EntityRow[] }> {
  const params: unknown[] = [];
  const inScope = scopeSql("e", opts, params).where;
  params.push(opts.limit);
  const L = `$${params.length}`;
  const weights = weightsSql(opts, params);
  const edgeCols = opts.edges ? `, coalesce(d.degree, 0) AS degree, coalesce(d.support, 0) AS support` : "";
  // Degree counts the distinct neighbours an edge with a weighed thought
  // reaches; support sums the weights of the DISTINCT thoughts evidencing any
  // such edge — an edge table row is one (thought, from, to, relation), so a
  // thought asserting two relations is one row of `ev_thoughts`.
  const edgeJoin = opts.edges
    ? `LEFT JOIN (SELECT dg.entity_id, dg.degree, sp.support
                   FROM (SELECT entity_id, count(DISTINCT other_id)::int AS degree FROM ev GROUP BY 1) dg
                   JOIN (SELECT entity_id, sum(w)::float8 AS support FROM (SELECT DISTINCT entity_id, thought_id, w FROM ev) ev_thoughts GROUP BY 1) sp ON sp.entity_id = dg.entity_id) d ON d.entity_id = s.id`
    : "";
  const rows = await run(
    `WITH scope AS (SELECT e.id, e.entity_type, e.name, e.normalized_name FROM ob1_entities e WHERE ${inScope}),
          ${weights},
          ${MENTIONS_CTE}${opts.edges ? `,\n          ${ENDS_CTE},
          ev AS (SELECT x.entity_id, x.other_id, x.thought_id, w.w FROM ends x JOIN weights w ON w.thought_id = x.thought_id AND w.w > 0
                   JOIN scope o ON o.id = x.other_id JOIN scope me ON me.id = x.entity_id)` : ""},
          stats AS (
            SELECT s.id, s.entity_type, s.name, s.normalized_name, coalesce(m.mentions, 0)::float8 AS mentions${edgeCols}
              FROM scope s LEFT JOIN mentions m ON m.entity_id = s.id ${edgeJoin}${opts.status === "all" && !opts.startable ? "" : `
             WHERE coalesce(m.mentions, 0) > 0`}),
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
/** A thought's lifecycle beside it, from the `weights` alias `w` every thought query joins. */
const LIFECYCLE_COLS = `w.status, w.status_type, w.w AS weight`;
/** A thought ranks by its weight times its score; the tiebreaks are the score's parts, then the id. With every weight 1 this is the score. */
const THOUGHT_ORDER = (edges: boolean) => `weight * (entities${edges ? " + edges" : ""}) DESC, entities DESC, id`;
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
  const L = `$${params.length}`;
  const weights = weightsSql(opts, params);
  const edgeCol = opts.edges
    ? `, (SELECT count(*) FROM ob1_entity_edges x JOIN scope a ON a.id = x.from_entity_id JOIN scope b ON b.id = x.to_entity_id WHERE x.thought_id = t.id)::int AS edges`
    : "";
  const rows = await run(
    `WITH scope AS (SELECT e.id FROM ob1_entities e WHERE ${inScope}),
          ${weights},
          counted AS (
            SELECT t.id, t.created_at, ${EXCERPT} AS excerpt, ${LIFECYCLE_COLS},
                   (SELECT count(DISTINCT te.entity_id) FROM thought_entities te JOIN scope s ON s.id = te.entity_id WHERE te.thought_id = t.id)::int AS entities${edgeCol}
              FROM thoughts t JOIN weights w ON w.thought_id = t.id AND w.w > 0
             WHERE EXISTS (SELECT 1 FROM thought_entities te JOIN scope s ON s.id = te.entity_id WHERE te.thought_id = t.id))
     SELECT * FROM counted
      ORDER BY ${THOUGHT_ORDER(opts.edges)}
      LIMIT ${L}`,
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
  const L = `$${params.length}`;
  const weights = weightsSql(opts, params);
  // Only weighed thoughts touch: a filtered-out thought evidences nothing
  // here, and a decayed one evidences DONE_WEIGHT of an edge. Support and the
  // per-relation counts sum over DISTINCT thoughts (one thought asserting a
  // relation twice through two subject ids is one thought), and the relation
  // list renders a whole sum plain and a decayed one to two places.
  const edgeCtes = opts.edges
    ? `,
       ${ENDS_CTE},
       touching AS (SELECT DISTINCT x.other_id AS entity_id, x.thought_id, x.relation, w.w FROM ends x JOIN weights w ON w.thought_id = x.thought_id AND w.w > 0
                     WHERE x.entity_id = ANY($1::uuid[]) AND NOT (x.other_id = ANY($1::uuid[]))),
       per_relation AS (SELECT entity_id, relation, sum(w)::float8 AS n FROM touching GROUP BY 1, 2),
       ed AS (SELECT sup.entity_id, sup.support, rel.relations
                FROM (SELECT entity_id, sum(w)::float8 AS support FROM (SELECT DISTINCT entity_id, thought_id, w FROM touching) tw GROUP BY 1) sup
                JOIN (SELECT entity_id, string_agg(relation || '×' || ${FMT("n")}, ', ' ORDER BY n DESC, relation) AS relations FROM per_relation GROUP BY 1) rel
                  ON rel.entity_id = sup.entity_id)`
    : "";
  // Candidates first — the entities with a co-mention or an edge among the
  // weighed thoughts, which is what `co` and `ed` hold, so no further filter
  // is needed — then `mentions`, a display and tiebreak column, counted for
  // those alone (fourth review pass; the whole-table aggregate was the shape
  // the first pass removed from the rungs).
  const rows = await run(
    `WITH scope AS (SELECT e.id, e.entity_type, e.name, e.normalized_name FROM ob1_entities e WHERE ${inScope}),
       ${weights},
       subject_thoughts AS (SELECT DISTINCT te.thought_id, w.w FROM thought_entities te JOIN weights w ON w.thought_id = te.thought_id AND w.w > 0
                             WHERE te.entity_id = ANY($1::uuid[])),
       co AS (SELECT te.entity_id, sum(st.w)::float8 AS co_mentions
                FROM thought_entities te JOIN subject_thoughts st ON st.thought_id = te.thought_id
               WHERE NOT (te.entity_id = ANY($1::uuid[])) GROUP BY 1)${edgeCtes},
       cand AS (${opts.edges
         ? `SELECT coalesce(co.entity_id, ed.entity_id) AS entity_id, coalesce(co.co_mentions, 0)::float8 AS co_mentions, coalesce(ed.support, 0)::float8 AS support, ed.relations
              FROM co FULL JOIN ed ON ed.entity_id = co.entity_id`
         : `SELECT entity_id, co_mentions FROM co`}),
       ranked AS (
         SELECT s.id, s.entity_type, s.name, s.normalized_name,
                (SELECT coalesce(sum(w.w), 0) FROM thought_entities te JOIN weights w ON w.thought_id = te.thought_id WHERE te.entity_id = s.id)::float8 AS mentions,
                c.co_mentions${opts.edges ? ", c.support, c.relations" : ""}
           FROM cand c JOIN scope s ON s.id = c.entity_id)
     SELECT id, entity_type, name, mentions, co_mentions${opts.edges ? ", support, relations" : ""}
       FROM ranked
      ORDER BY co_mentions${opts.edges ? " + support" : ""} DESC, mentions DESC, ${ENTITY_TIEBREAK}
      LIMIT ${L}`,
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
  const weights = weightsSql(opts, params);
  const rows = await run(
    `WITH ${weights},
     counted AS (
       SELECT t.id, t.created_at, ${EXCERPT} AS excerpt, ${LIFECYCLE_COLS},
              (SELECT count(DISTINCT te.entity_id) FROM thought_entities te WHERE te.thought_id = t.id AND te.entity_id = ANY($2::uuid[]))::int AS entities${edgeCol}
         FROM thoughts t JOIN weights w ON w.thought_id = t.id AND w.w > 0
        WHERE EXISTS (SELECT 1 FROM thought_entities te WHERE te.thought_id = t.id AND te.entity_id = ANY($1::uuid[])))
     SELECT * FROM counted
      ORDER BY ${THOUGHT_ORDER(opts.edges)}
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
    lifecycleCaveat(c, opts),
    ...(c.dependencies ? [dependencyCaveat(c, c.dependencies)] : []),
    `Coverage: ${c.extracted} of ${c.thoughts} thoughts have extracted entities${c.extraction_key ? ` (extraction key ${c.extraction_key})` : " (no extraction key: db/extract-entities.ts has not run)"}; a thought the worker has not reached, or found no entity in, is not in the graph (extract-entities.ts --status tells the two apart).`,
  ];
  if (!opts.edges) out.push(`--no-edges: ranked by co-occurrence alone; the difference from the default run is what the edges add.`);
  return out;
}

/**
 * The lifecycle line: where the status comes from and how fresh it can be,
 * how many thoughts carry one, and what the run's flags made of it — every
 * thought at 1 (the default, so a Done ticket counts as a live one), the
 * filter's weighed count, or the decay's weight.
 */
export function lifecycleCaveat(c: Coverage, opts: Options): string {
  const source = `Ticket status is read from synced metadata (board-sync, SMD-1954), as fresh as its last pass${c.last_sync ? ` — latest linear_updated_at ${c.last_sync}` : c.with_lifecycle ? " — no linear_updated_at is stamped beside them" : " — none is stamped here"}: ${c.with_lifecycle} of ${c.thoughts} thoughts carry a lifecycle, ${c.done} of them completed or canceled${c.unknown_status ? `, and ${c.unknown_status} carr${c.unknown_status === 1 ? "ies" : "y"} a status_type this tool does not know (weighed 1)` : ""}.`;
  const rule = opts.status !== "all"
    ? ` --status ${opts.status}: ${c.weighed} of ${c.thoughts} thoughts weigh in this run (${LIFECYCLE_FILTERS[opts.status].join(", ")}, plus every thought without a lifecycle — it passes every filter).`
    : opts.decayDone
      ? ` --decay-done: a completed or canceled thought weighs ${DONE_WEIGHT} in every count (pre-registered, one weight); degree counts neighbours, not evidence, and is unchanged.`
      : ` Every thought weighs 1: a Done ticket counts as a live one (--status open|active|done filters; --decay-done down-weights).`;
  return source + rule;
}

/**
 * The dependency line, under `--startable` alone: where the edges come from
 * and how fresh they are, how many thoughts the board's relations reach (the
 * rest count as unblocked), how many weigh 0 for an open blocker, and how many
 * blockers are in force only because nothing says they are settled.
 */
export function dependencyCaveat(c: Coverage, d: Dependencies): string {
  const fresh = d.last_link_change ? ` — latest link written or closed ${d.last_link_change}` : " — none is recorded here";
  const unknown = d.unknown_blockers
    ? ` ${d.unknown_blockers} blocker${d.unknown_blockers === 1 ? " is" : "s are"} in force only because nothing settles ${d.unknown_blockers === 1 ? "it" : "them"}: not in the brain, or carrying no lifecycle.`
    : "";
  return `Dependencies are read from the board's blocks / blocked_by link facets (SMD-1867), as fresh as board-sync's last pass${fresh}: ${d.edges} active dependency facet${d.edges === 1 ? "" : "s"}; ${d.with_links} of ${c.thoughts} thoughts belong to a ticket whose relations were read, and every other thought counts as unblocked. --startable: ${d.blocked} thought${d.blocked === 1 ? "" : "s"} with an open blocker weigh${d.blocked === 1 ? "s" : ""} 0 in this run; a blocker completed or canceled does not block, and a parent is not blocked by its children.${unknown}`;
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
/** A weighted count as text — whole numbers plain, else two places — the rule FMT applies in SQL, so "3.50" reads the same in a cell, a subject line and a relation list. */
const count = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(2));
/** One cap for the entity-name column in every table, so the same name renders the same in the whole-graph and neighbourhood reports (the edges-on/off control diffs them). */
const NAME_WIDTH = 60;

function table(rows: Record<string, unknown>[], cols: Col[]): string {
  // Names and excerpts are model output: control characters out, whitespace
  // to one space, as db/consolidate.ts renders the same columns (sixth review pass).
  const cell = (r: Record<string, unknown>, k: string) =>
    r[k] === null || r[k] === undefined ? ""
    : typeof r[k] === "number" ? count(r[k])
    : cleanForDisplay(String(r[k])).replace(/\s+/g, " ");
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
const T_COLS = (o: Options, entitiesHead: string): Col[] => [
  { key: "entities", head: entitiesHead, right: true },
  ...(o.edges ? [{ key: "edges", head: "edges", right: true }] : []),
  ...(o.decayDone ? [{ key: "weight", head: "weight", right: true }] : []),
  { key: "status", head: "status", width: 14 },
  { key: "id", head: "thought" },
  { key: "created_at", head: "captured", width: 24 },
  { key: "excerpt", head: "excerpt", width: 90 },
];
/** How many of the listed thoughts carry a lifecycle — stated under every thought table (the coverage line has the brain's count). */
const listedLifecycles = (rows: ThoughtRow[]): string => {
  const n = rows.filter((t) => (LIFECYCLE_TYPES as readonly string[]).includes(t.status_type ?? "")).length;
  return `${n} of ${rows.length} listed thought${rows.length === 1 ? "" : "s"} carr${n === 1 ? "ies" : "y"} a lifecycle.`;
};
/** The header's lifecycle clause: the filter, the decay when on, and `startable` when the dependency read is. */
const lifecycleClause = (o: Options): string => `lifecycle ${o.status}${o.decayDone ? ` (done ×${DONE_WEIGHT})` : ""}${o.startable ? ", startable" : ""}`;

export function render(r: Report): string {
  const out: string[] = [];
  const o = r.options;
  const everyType = ENTITY_TYPES.every((t) => o.types.includes(t));
  out.push(`graph-centrality — ${r.subject === null ? "the whole graph" : `around ${JSON.stringify(r.subject)}`}; scope ${everyType ? "every type" : o.types.join(",")}${o.excludeNumeric ? ", numeric names excluded" : ", numeric names kept"}; edges ${o.edges ? "on" : "OFF (control)"}; ${lifecycleClause(o)}; top ${o.limit}`);
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
      for (const s of res.subjects) out.push(`  ${r.subject_ids.includes(s.id) ? "▸" : " "} ${s.entity_type} ${JSON.stringify(s.name)} — ${count(s.mentions)} mention${s.mentions === 1 ? "" : "s"}${res.how === "fuzzy" ? ` (similarity ${s.score.toFixed(2)})` : ""}  ${s.id}`);
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
      out.push(`No neighbour: nothing in scope shares a ${o.status === "all" ? "" : `--status ${o.status} `}${o.startable ? "startable " : ""}thought or an edge with the subject.`);
      out.push("");
    }
    if (r.thoughts.length) {
      out.push(`Thoughts mentioning the subject — ranked by neighbours mentioned${o.edges ? " + subject edges evidenced" : ""}${o.decayDone ? ", times the weight" : ""}:`);
      out.push(table(r.thoughts as Record<string, unknown>[], T_COLS(o, "neighbours")));
      out.push(listedLifecycles(r.thoughts));
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
    out.push(`Top thoughts — by in-scope entities mentioned${o.edges ? " + in-scope edges evidenced" : ""}${o.decayDone ? ", times the weight" : ""}:`);
    out.push(table(r.thoughts as Record<string, unknown>[], T_COLS(o, "entities")));
    out.push(listedLifecycles(r.thoughts));
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
    } else if (a === "--status") {
      const v = value();
      if (typeof v !== "string") return v;
      if (!Object.hasOwn(LIFECYCLE_FILTERS, v)) return { error: `--status takes one of ${Object.keys(LIFECYCLE_FILTERS).join(", ")}; not ${JSON.stringify(v)}` };
      opts.status = v as LifecycleFilter;
    } else if (a === "--decay-done") opts.decayDone = true;
    else if (a === "--startable") opts.startable = true;
    else if (a === "--keep-numeric") opts.excludeNumeric = false;
    else if (a === "--no-edges") opts.edges = false;
    else if (a === "--json") json = true;
    else if (a.startsWith("--")) return { error: `unknown flag ${a}` };
    else if (a.trim() === "") return { error: "the subject is empty; leave it out for the whole graph" };
    else positional.push(a);
  }
  if (positional.length > 1) return { error: `one subject at a time; got ${positional.map((p) => JSON.stringify(p)).join(", ")} — quote a name with spaces` };
  // Decay weighs the completed and canceled thoughts; a filter other than
  // `all` drops them or keeps only them, so the two are two answers to one
  // question — and under `done` a uniform weight would change nothing.
  if (opts.decayDone && opts.status !== "all") return { error: `--decay-done weighs the completed and canceled thoughts at ${DONE_WEIGHT}; --status ${opts.status} already decides them — pass one or the other` };
  return { url, subject: positional[0] ?? null, opts, json };
}

if (import.meta.main) {
  const parsed = parseArgs(process.argv.slice(2));
  if ("error" in parsed) {
    console.error(parsed.error);
    console.error(`usage: bun graph-centrality.ts --url postgres://… ["subject"] [--limit N (1-500)] [--types a,b] [--keep-numeric] [--no-edges] [--status all|open|active|done] [--decay-done] [--startable] [--json]   (exit 0 ranked, 1 no entity, 3 excluded by the numeric rule, 2 error)`);
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
  // usage error, a brain without 016 (053 under --startable), or a query that failed — never 1 for a
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
    } else if (parsed.opts.startable && !(await run(`SELECT (to_regclass('thought_sources') IS NOT NULL AND to_regprocedure('source_thought(text, text)') IS NOT NULL) AS ok`, []))[0].ok) {
      // --startable reads 053's link facets and resolver; every other mode runs without them.
      console.error("--startable reads the board's link facets: migration 053 is not applied. Run db/migrate.ts, or leave the flag out.");
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
