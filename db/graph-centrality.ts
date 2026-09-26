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
 *   bun db/graph-centrality.ts --url postgres://…                     # the whole graph: top entities and thoughts
 *   bun db/graph-centrality.ts --url … "Open Brain"                   # one subject's neighbourhood
 *   bun db/graph-centrality.ts --url … "Open Brain" --no-edges        # …by co-occurrence alone
 *   bun db/graph-centrality.ts --url … "Open Brain" --status open     # …as the live tickets build it
 *   bun db/graph-centrality.ts --url … --status open --startable      # …as the tickets you could start now build it
 *   bun db/graph-centrality.ts --url … --status open --decay-blocked  # …with the blocked ones sunk, not dropped
 *   --limit N (20, at most 500)   --types project,tool,…   --keep-numeric   --json
 *   --status all|open|active|done (all)   --decay-done   --startable | --decay-blocked
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
 * The status comes from migration 058: `node_lifecycle()` (`LIFECYCLE_CTE`), or
 * `node_state()` under a dependency flag (`STATE_CTE`) — below, "node_state".
 *
 * ── Startability (SMD-2061) ─────────────────────────────────────────────────
 * The lifecycle says whether a ticket is open; it does not say whether it can
 * be started. The board says that too: migration 053 (SMD-1867) stores a
 * ticket's relations as `link` facets on the row holding its identity
 * (`thought_sources`), and the Linear mapping writes `blocks` on the blocker
 * and `blocked_by` on the blocked. `--startable` reads both directions — an
 * edge the sync stated on one side only still counts — and multiplies a second
 * factor into the same weight: an UNSETTLED thought whose ticket has an OPEN
 * blocker weighs 0. Unsettled: startability is a question about open work, and
 * Linear keeps a relation after a ticket completes — a Done ticket whose
 * blocker is still open is settled, not blocked, and weighs what its lifecycle
 * says. A blocker is open unless its own lifecycle, read through the
 * `lifecycle` rows above via `source_thought()` (053's resolver), is completed
 * or canceled: a settled blocker is not a blocker. Within a system that gates
 * (below: the board does), a blocker the brain does not hold, or one with no
 * status_type this file knows, still blocks — the source said "blocked" and
 * nothing here says it is settled — and the output counts such blockers rather
 * than hiding them. A row derived from a ticket (`ticket`) or carrying one
 * (`issue`) takes its ticket's blockers, as it takes its ticket's status. Only
 * an active link counts (`valid_until` unset — 053 closes a relation the source
 * dropped), and only `blocks` / `blocked_by`: a parent is not blocked by its
 * children (`child_of`), nor a ticket by what it relates to. A thought whose
 * ticket no gating dependency names counts as unblocked, and the output states
 * how many one does name. Without the flag (or `--decay-blocked`, below) the
 * dependency read is not in the SQL at all, so every other mode renders
 * SMD-1994's report byte for byte (the JSON's `options` carries two more keys,
 * `startable` and `decayBlocked`, both false) and a role without
 * `thought_sources` runs it (below).
 *
 * ── Blocked decay (SMD-2181) ────────────────────────────────────────────────
 * `--startable` is a filter: a blocked hub vanishes rather than sinks, the
 * trade `--status` makes and `--decay-done` does not. `--decay-blocked` is the
 * decay: the same read, the same rules, and a held thought weighs
 * `BLOCKED_WEIGHT` (0.25, pre-registered here before any number was read, one
 * weight, exact in binary) times its lifecycle weight instead of 0. It stays in
 * the ranking, and where it is listed it names the blockers that hold it — its
 * ticket's open blockers, sorted, an unknown one included, another system's as
 * `system:key` — in a `blocked by` column and the JSON's `blockers`. The two are two answers to
 * one question, so they are refused together, as `--decay-done` is beside
 * `--status`. The decays never meet on one thought: a blocked thought is
 * unsettled and `DONE_WEIGHT` weighs only settled ones, so under both each
 * thought weighs 1 or 0.25, never their product. Degree counts neighbours, not
 * evidence, and is unchanged by it.
 *
 * ── Sources (SMD-2218) ──────────────────────────────────────────────────────
 * The board is not the only writer of dependencies: SMD-2136's `--items`
 * writes `blocks` / `blocked_by` for any system it is given, and both flags
 * read them. A blocker is settled by its row's lifecycle, and a row of another
 * system states one only if its source said so (an `--items` file, in
 * `facets.status_type`, one of the six types above). So a system GATES only
 * when some source row of it states, on its own metadata, a status_type this
 * file knows — a status a row borrows through a Linear ticket claim does not
 * count (first review pass). Under that rule its links are read exactly as the
 * board's, an unknown blocker blocking. A system that states none cannot say a
 * blocker is settled, and rather than block its tickets forever its links gate
 * nothing — they block no thought and name no ticket — and the dependency line
 * counts them by system. The board gates by the same rule, not by name. While
 * the board is the only source and states its lifecycle, the line reads as
 * SMD-2061's; the JSON's `dependencies.systems` lists each system's facets and
 * whether it gates (second review pass: "and states its lifecycle").
 *
 * ── node_state (SMD-2074) ──────────────────────────────────────────────────
 * The rules above are not this file's alone: attention is not actionability
 * in search either, and the server — which cannot import a db/ script, and
 * whose PostgREST store reaches only RPCs — ranks by the same read. So they
 * are SQL, migration 058's five functions: `node_lifecycle()` (a thought's
 * status, its ticket's head's, and its freshness), `node_dependencies()` (the
 * blocks / blocked_by facets, active or closed, and whether each system
 * gates), `node_state()` (per thought, the lifecycle beside `open`,
 * `blocked`, `blockers`, `unknown_blockers`, `in_dependencies` and
 * `superseded_by`), and the two status sets, which must equal
 * `LIFECYCLE_TYPES` and `LIFECYCLE_FILTERS.done` — a brain whose 058 knows
 * others is refused (exit 2), as is one without 058. This file is their first
 * reader: without either dependency flag the rows are `node_lifecycle()`'s,
 * which reads `thoughts` alone, so a role without the `structure` group's
 * `thought_sources` runs every other mode; the flags read `node_state()`,
 * which needs it. `metadata.status_type` is a transitional, lossy scalar — the
 * transitions are `thought_audit`'s (046) — and when SMD-1997 folds them, the
 * two reads of it change (`node_lifecycle()`'s body and `node_dependencies()`'
 * gate, which reads a source row's own status) and no caller does.
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
 *   • Entity typing is noisy (SMD-1935): the extractor minted bare migration and
 *     port numbers as `person`/`tool`/`project` rows, which the writer refuses
 *     since migration 056 — a brain before it, a name a structured source states
 *     or an entity a human curated still holds them. Names that are only digits,
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
 *   • Dependencies (`--startable`, `--decay-blocked`) are the sources' link
 *     facets, as current as each source's last passes over both ends of a
 *     relation: the relation is read from either side, so one removed at the
 *     source keeps its effect — blocking, where its system gates — until a pass
 *     has re-read both, the price of catching one a source has so far stated
 *     on one side only. A system that states no lifecycle gates nothing. The
 *     dependency line gives the numbers.
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
import { RESERVED_SYSTEMS } from "./ingest-items.ts";

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
/** What a held thought's lifecycle weight is multiplied by under `--decay-blocked`: pre-registered before any number was read, one value, exact in binary. */
export const BLOCKED_WEIGHT = 0.25;

export type Options = Scope & {
  limit: number;
  /** With edges off, no edge count is read or ranked on: the control. */
  edges: boolean;
  /** Which lifecycles weigh 1; the rest weigh 0. `all` is every thought at 1 — today's counts. */
  status: LifecycleFilter;
  /** With `all`: a completed or canceled thought weighs DONE_WEIGHT instead of 1. Refused with any other filter. */
  decayDone: boolean;
  /** An unsettled thought whose ticket has an open blocker weighs 0; a completed or canceled one weighs what its lifecycle says. Off, with `decayBlocked` off too: no dependency is read. */
  startable: boolean;
  /** As `startable`, but such a thought weighs BLOCKED_WEIGHT of its lifecycle weight, and names its blockers where it is listed. Refused with `startable`. */
  decayBlocked: boolean;
};
export const DEFAULT_OPTIONS: Options = { types: ENTITY_TYPES, excludeNumeric: true, limit: DEFAULT_LIMIT, edges: true, status: "all", decayDone: false, startable: false, decayBlocked: false };
/** Whether the run reads the dependencies: under the filter or the decay. */
const readsDependencies = (o: Partial<Pick<Options, "startable" | "decayBlocked">>): boolean => Boolean(o.startable || o.decayBlocked);

export type EntityRow = { id: string; entity_type: string; name: string; mentions: number; degree?: number; support?: number };
export type ThoughtRow = { id: string; created_at: string | null; excerpt: string; entities: number; edges?: number; status: string | null; status_type: string | null; weight: number; blockers?: string[] | null };
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
  /** Under `--startable` or `--decay-blocked` alone: what the dependency read found. */
  dependencies?: Dependencies;
};
export type Dependencies = {
  /** Active `blocks` / `blocked_by` link facets — facet rows, not relations: one the sync stated on both sides is two. */
  facets: number;
  /** Thoughts whose ticket an active dependency of a gating system names, on either side — blocked, blocking, or both. Every other thought has no gating dependency and counts as unblocked. */
  in_dependencies: number;
  /** Thoughts the flag took from a weight above 0 to 0 in this run — to BLOCKED_WEIGHT of it under `--decay-blocked`: unsettled, weighed in by the lifecycle, and with an open blocker. */
  held: number;
  /** Distinct blockers of the thoughts held in this run that nothing settles — not in the brain, or with no status_type this tool knows. A held thought may have a known-open blocker beside one. */
  unknown_blockers: number;
  /** The latest dependency facet written or closed. Null when the brain holds none. */
  last_link_change: string | null;
  /** Per system of the facets read, sorted: how many, and whether it GATES — whether any of its own source rows states, in its own metadata, a status_type this file knows (a status borrowed through a Linear ticket claim does not count). A system that does not gates nothing: its links block no thought and name no ticket (SMD-2218). */
  systems: { system: string; facets: number; gates: boolean }[];
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
 * Where a thought's lifecycle comes from — migration 058's `node_lifecycle()`
 * (SMD-2074), the one definition every ranking surface reads: the three keys
 * board-sync stamps on `thoughts.metadata` (SMD-1954), a scalar the sync
 * overwrites each pass. A row's lifecycle is its TICKET's — one head per issue
 * (un-superseded first, then the newest sync, then the id), and every row
 * carrying `issue` or `ticket` reads its head's keys, falling back to its own
 * (first review pass of SMD-1994; the rule's text is 058's now). When SMD-1997
 * folds the transitions `thought_audit` (046) already holds, the function's
 * body changes (and the gate's, in `node_dependencies()`) and this does not. It reads `thoughts` alone, so a role without
 * `thought_sources` runs every mode but the dependency read.
 */
export const LIFECYCLE_CTE = `lifecycle AS (SELECT thought_id, status, status_type, synced_at FROM node_lifecycle())`;

/**
 * The same rows with each thought's dependency state beside them — 058's
 * `node_state()`, read instead of `LIFECYCLE_CTE` under `--startable` or
 * `--decay-blocked`. `blockers` is the ticket's open blockers from its gating
 * systems' active links (a `linear` one bare, another system's `system:key`,
 * an unknown one kept), `blocked` the rule — blockers, and the thought not
 * completed or canceled — `unknown_blockers` those no known status settles,
 * `in_dependencies` whether a gating link names its ticket at all. The
 * lifecycle columns are node_lifecycle()'s, so every count reads one
 * lifecycle whichever of the two a run takes. The rules — which link blocks,
 * which system gates (SMD-2218), what settles a blocker — are the header's,
 * written once in 058.
 */
export const STATE_CTE = `lifecycle AS (SELECT thought_id, status, status_type, synced_at, blocked, blockers, unknown_blockers, in_dependencies FROM node_state())`;

/**
 * The per-thought weight, as the header defines it, with `lifecycle` before it:
 * a kept status 1; another known status 0, or DONE_WEIGHT under decay; no
 * status, or one this file does not know, 1 — and under `--startable`, times 0
 * when the thought is blocked (`held` marks the rows that took from above 0),
 * times BLOCKED_WEIGHT under `--decay-blocked` (`blockers` then names what
 * holds each). Returns the CTE text (lifecycle — `node_state()`'s rows under
 * either flag — and weights, no leading comma) with its one parameter, the
 * kept types, appended to `params`; the known types are 058's
 * `node_lifecycle_types()`, so a query places its own slots after it.
 */
export function weightsSql(opts: Pick<Options, "status" | "decayDone"> & Partial<Pick<Options, "startable" | "decayBlocked">>, params: unknown[]): string {
  // The rules parseArgs applies, applied here too for a caller that builds its
  // own Options: decay and a filter are two answers to one question.
  if (opts.decayDone && opts.status !== "all") throw new Error(`weightsSql: --decay-done with --status ${opts.status}; pass one or the other`);
  if (opts.startable && opts.decayBlocked) throw new Error("weightsSql: --startable with --decay-blocked; pass one or the other");
  params.push(pgArray(opts.decayDone ? LIFECYCLE_FILTERS.open : LIFECYCLE_FILTERS[opts.status]));
  const kept = params.length;
  // The literal is a float8 written as SQL text — DONE_WEIGHT is a constant of
  // this file, not input — so the type of `w` is float8 in every branch. The
  // status name is shown only beside a status_type 058 knows, so the column
  // and the "carry a lifecycle" count agree (first review pass).
  // MATERIALIZED: a query that reads `weights` once, inside a correlated
  // subquery — the rungs' mention count — would otherwise have the planner
  // inline the lifecycle into it and scan `thoughts` once per candidate row;
  // materialised, the weights are computed once per statement whatever the
  // reference count (second review pass).
  // Without either flag the rows are node_lifecycle()'s, and no link facet or
  // source row is read: the dependency read swaps in node_state() and adds
  // the factor and `held`, and nothing else moves. node_state's `blocked` is
  // unsettled by definition — Linear keeps a relation after a ticket
  // completes, and a Done ticket whose blocker is still open is settled, not
  // blocked — so the factor passes a completed or canceled row untouched, and
  // `--status done` or the decay read it as without the flag (first review
  // pass). `held` marks the rows the factor took from weight above 0 to 0, or
  // to BLOCKED_WEIGHT of it under --decay-blocked — what the flag did in this
  // run, which coverage counts.
  // Under --decay-blocked the factor is BLOCKED_WEIGHT, a constant written as
  // SQL text as DONE_WEIGHT is, and `blockers` is carried for the held rows
  // alone — a settled ticket's leftover relation holds nothing, so it names
  // nothing. The decays never meet: `blocked` is unsettled and DONE_WEIGHT is
  // a settled weight, so no row weighs their product. The column is not in
  // --startable's text.
  const base = `CASE WHEN status_type = ANY($${kept}::text[]) THEN 1.0
                                   WHEN status_type = ANY(node_lifecycle_types()) THEN ${opts.decayDone ? DONE_WEIGHT : 0}
                                   ELSE 1.0 END`;
  let factor = "", held = "";
  if (readsDependencies(opts)) {
    factor = ` * CASE WHEN blocked THEN ${opts.decayBlocked ? BLOCKED_WEIGHT : 0} ELSE 1.0 END`;
    held = `,\n                             (blocked AND ${base} > 0) AS held`;
    if (opts.decayBlocked) held += `,\n                             CASE WHEN blocked THEN blockers END AS blockers`;
  }
  return `${readsDependencies(opts) ? STATE_CTE : LIFECYCLE_CTE},
          weights AS MATERIALIZED (SELECT thought_id, CASE WHEN status_type = ANY(node_lifecycle_types()) THEN status END AS status, status_type,
                             (${base}${factor})::float8 AS w${held}
                        FROM lifecycle)`;
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
  // The dependency counts read node_state()'s rows, which weightsSql put in
  // `lifecycle` under either flag, and 058's node_dependencies() for the
  // facets themselves. `facets` counts the active ones — every link the read
  // took in, the ungated systems' among them (the ranking reads the gating
  // ones) — so a relation the sync stated on both sides is two.
  // `in_dependencies` counts the thoughts whose ticket a gating dependency
  // names on either side — a link of another relation (a section's own
  // child_of, a relates_to) says nothing about blocking, and a ticket blocked
  // only through another's `blocks` is named though it holds no facet (first
  // review pass: "any active link on the holder" counted every synced thought
  // and missed that one). `held` is what the flag did in this run, not every
  // thought with a blocker; `unknown_blockers` counts the distinct blockers of
  // held thoughts that no known status settles or opens — one hanging off a
  // Done ticket blocks nothing and is not counted (second and third review
  // passes). The freshness is the latest write or close of any facet of the
  // two relations, a closed one included; `systems` the active facets' by
  // system, with whether it gates (SMD-2218).
  const dependencyCols = readsDependencies(opts)
    ? `,
            (SELECT count(*) FROM links WHERE active)::int AS dep_facets,
            (SELECT count(*) FROM lifecycle WHERE in_dependencies)::int AS dep_named,
            (SELECT count(*) FROM weights WHERE held)::int AS dep_held,
            (SELECT count(DISTINCT u.shown) FROM weights w JOIN lifecycle l USING (thought_id) CROSS JOIN unnest(l.unknown_blockers) AS u(shown) WHERE w.held)::int AS dep_unknown,
            (SELECT max(changed_at) FROM links) AS dep_last_change,
            (SELECT coalesce(jsonb_agg(jsonb_build_array(x.system, x.n, x.gates) ORDER BY x.system), '[]'::jsonb)
               FROM (SELECT system, count(*)::int AS n, bool_or(gates) AS gates FROM links WHERE active GROUP BY 1) x) AS dep_systems`
    : "";
  const links = readsDependencies(opts) ? `,\n          links AS (SELECT system, active, changed_at, gates FROM node_dependencies())` : "";
  const [r] = await run(
    `WITH ${weights}${links}
     SELECT (SELECT count(*) FROM thoughts)::int AS thoughts,
            (SELECT count(DISTINCT thought_id) FROM thought_entities)::int AS extracted,
            (SELECT count(*) FROM ob1_entities e WHERE ${sc.where})::int AS entities,
            (SELECT count(*) FROM ob1_entities WHERE normalized_name ~ $${patternSlot} AND entity_type = ANY($${sc.typesSlot}::text[]))::int AS numeric_names,
            (SELECT count(*) FROM ob1_entity_edges)::int AS edges,
            (SELECT count(*) FROM ob1_entity_edges WHERE confidence = 1)::int AS unit_edges,
            (SELECT value FROM ob1_config WHERE key = 'entity_extraction_key') AS extraction_key,
            (SELECT count(*) FROM lifecycle WHERE status_type = ANY(node_lifecycle_types()))::int AS with_lifecycle,
            (SELECT count(*) FROM lifecycle WHERE status_type IS NOT NULL AND NOT status_type = ANY(node_lifecycle_types()))::int AS unknown_status,
            (SELECT count(*) FROM lifecycle WHERE status_type = ANY(node_settled_types()))::int AS done,
            (SELECT count(*) FROM weights WHERE w > 0)::int AS weighed,
            (SELECT max(synced_at) FROM lifecycle WHERE status_type = ANY(node_lifecycle_types())) AS last_sync${dependencyCols}`,
    params);
  if (!readsDependencies(opts)) return r as Coverage;
  const { dep_facets, dep_named, dep_held, dep_unknown, dep_last_change, dep_systems, ...base } = r;
  // Triples, not objects: jsonb orders an object's keys by length, so the
  // shape is built here, in the order the type declares.
  const systems = (typeof dep_systems === "string" ? JSON.parse(dep_systems) : dep_systems) as [string, number, boolean][];
  return {
    ...(base as Coverage),
    dependencies: { facets: Number(dep_facets), in_dependencies: Number(dep_named), held: Number(dep_held), unknown_blockers: Number(dep_unknown), last_link_change: isoTimestampOrNull(dep_last_change),
      systems: systems.map(([system, facets, gates]) => ({ system, facets: Number(facets), gates: Boolean(gates) })) },
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
 * means no degree either). Under `all` without `--startable` — either decay
 * too — every in-scope entity is listed as before, an orphan at 0 included
 * (first review pass: the default lists exactly what it listed).
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
/** A thought's lifecycle beside it, from the `weights` alias `w` every thought query joins — and under `--decay-blocked` what holds it. */
const LIFECYCLE_COLS = (o: Options) => `w.status, w.status_type, w.w AS weight${o.decayBlocked ? ", w.blockers" : ""}`;
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
            SELECT t.id, t.created_at, ${EXCERPT} AS excerpt, ${LIFECYCLE_COLS(opts)},
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
  // here, and a decayed one evidences its weight's worth of an edge. Support
  // and the per-relation counts sum over DISTINCT thoughts (one thought
  // asserting a relation twice through two subject ids is one thought), and
  // the relation list renders a whole sum plain and a decayed one to two
  // places.
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
       SELECT t.id, t.created_at, ${EXCERPT} AS excerpt, ${LIFECYCLE_COLS(opts)},
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
    ...(c.dependencies ? [dependencyCaveat(c, c.dependencies, opts)] : []),
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
  // Under the dependency read the lifecycle is one factor of two: the line
  // states the lifecycle's rule as the lifecycle's, and the run's weighed
  // count carries both (second review pass: "every thought weighs 1" sat
  // beside a dependency line holding thoughts at 0).
  const rule = opts.status !== "all"
    ? ` --status ${opts.status}: ${c.weighed} of ${c.thoughts} thoughts weigh in this run (${LIFECYCLE_FILTERS[opts.status].join(", ")}, plus every thought without a lifecycle — it passes every filter${opts.startable ? "; less those --startable holds back" : opts.decayBlocked ? `; those with an open blocker at ${BLOCKED_WEIGHT}` : ""}).`
    : (opts.decayDone
      ? ` --decay-done: a completed or canceled thought weighs ${DONE_WEIGHT} in every count (pre-registered, one weight); degree counts neighbours, not evidence, and is unchanged.`
      : ` ${readsDependencies(opts) ? "By its lifecycle every" : "Every"} thought weighs 1: a Done ticket counts as a live one (--status open|active|done filters; --decay-done down-weights).`)
      + (opts.startable ? ` With --startable, ${c.weighed} of ${c.thoughts} thoughts weigh more than 0 in this run.` : "");
  return source + rule;
}

/** "a and b" — the systems of one clause. */
const andList = (names: string[]): string => (names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`);
/** The ungated systems' clause (SMD-2218), with the items hint for those an --items file may claim. */
function ungatedClause(ungated: Dependencies["systems"]): string {
  const systems = ungated.map((s) => s.system);
  const facets = ungated.reduce((sum, s) => sum + s.facets, 0);
  const one = systems.length === 1;
  const itemsable = systems.filter((s) => !(RESERVED_SYSTEMS as readonly string[]).includes(s));
  const hint = itemsable.length ? ` (for ${andList(itemsable)}, an --items file states it in facets.status_type, and the status's name in facets.status)` : "";
  return ` ${andList(systems)} state${one ? "s" : ""} no lifecycle on any row of ${one ? "its" : "their"} own, so ${one ? "its" : "their"} ${facets} facet${facets === 1 ? " gates" : "s gate"} nothing: a source that states no status_type this tool knows cannot say a blocker is settled${hint}.`;
}

/**
 * The dependency line, under `--startable` or `--decay-blocked` alone: where
 * the edges come from and how current they can be, how many thoughts a
 * dependency names (the rest count as unblocked), how many the flag held back
 * or down-weighted in this run, and how many
 * of the held thoughts' blockers are unsettled only for want of a known status
 * (such a blocker may share its thought with a known-open one: it is counted,
 * not blamed — third review pass).
 */
export function dependencyCaveat(c: Coverage, d: Dependencies, opts: Pick<Options, "decayBlocked">): string {
  // A pass that changes no relation writes no facet (053's set semantics), so
  // the latest facet change is when the dependencies last MOVED, not when a
  // pass last looked — the line says which (first review pass).
  const weigh = `thought${d.held === 1 ? "" : "s"} with an open blocker weigh${d.held === 1 ? "s" : ""}`;
  const held = opts.decayBlocked
    ? `--decay-blocked: ${d.held} ${weigh} ${BLOCKED_WEIGHT} of ${d.held === 1 ? "its" : "their"} lifecycle weight in every count (pre-registered, one weight), and a listed one names its blockers; degree counts neighbours, not evidence, and is unchanged`
    : `--startable: ${d.held} ${weigh} 0 in this run`;
  const moved = d.last_link_change ? `; the latest was written or closed ${d.last_link_change}` : "";
  const unknown = d.unknown_blockers
    ? ` ${d.unknown_blockers} blocker${d.unknown_blockers === 1 ? "" : "s"} of the ${opts.decayBlocked ? "down-weighted" : "held"} thoughts ${d.unknown_blockers === 1 ? "is" : "are"} unsettled only for want of a known status: not in the brain, or with no status_type this tool knows.`
    : "";
  // While the board is the only source, and it gates, the line is SMD-2061's
  // word for word; another system, or a board stating no lifecycle, names
  // each source and what the ungated ones do (SMD-2218).
  const boardOnly = d.systems.every((s) => s.system === "linear" && s.gates);
  const source = boardOnly
    ? "the board's blocks / blocked_by link facets (SMD-1867), as current as board-sync's last passes over both tickets of each (a relation is read from either side, so one removed on the board blocks until both are re-read)"
    : `the blocks / blocked_by link facets their sources state (SMD-1867; ${d.systems.map((s) => `${s.system} ${s.facets}`).join(", ")}), each as current as its source's last passes over both ends of each (a relation is read from either side, so one removed at the source keeps its effect — blocking, where its system gates — until both are re-read)`;
  // One clause for every ungated system; the items hint names the ones an
  // items file could be the source of — never a system it may not claim, the
  // board's among them (first and second review passes).
  const ungated = d.systems.filter((s) => !s.gates);
  const gate = ungated.length ? ungatedClause(ungated) : "";
  return `Dependencies are read from ${source}: ${d.facets} active dependency facet${d.facets === 1 ? "" : "s"}${moved}.${gate} ${d.in_dependencies} of ${c.thoughts} thoughts belong to a ticket a ${boardOnly ? "" : "gating "}dependency names; every other thought has ${boardOnly ? "none recorded" : "no gating dependency"} and counts as unblocked. ${held}; a completed or canceled ticket is settled, not blocked, a blocker completed or canceled does not block, and a parent is not blocked by its children.${unknown}`;
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
    : cleanForDisplay(Array.isArray(r[k]) ? (r[k] as unknown[]).join(", ") : String(r[k])).replace(/\s+/g, " ");
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
  ...(o.decayDone || o.decayBlocked ? [{ key: "weight", head: "weight", right: true }] : []),
  { key: "status", head: "status", width: 14 },
  { key: "id", head: "thought" },
  { key: "created_at", head: "captured", width: 24 },
  { key: "excerpt", head: "excerpt", width: 90 },
  // Uncapped, and last so a long cell widens no other column and an empty one
  // is trimmed away: the column is the only place the text names what holds a
  // thought (review passes: 30 cut four ids, 80 cut eight; third: mid-table,
  // one long cell padded every row).
  ...(o.decayBlocked ? [{ key: "blockers", head: "blocked by", width: Infinity }] : []),
];
/** How many of the listed thoughts carry a lifecycle — stated under every thought table (the coverage line has the brain's count). */
const listedLifecycles = (rows: ThoughtRow[]): string => {
  const n = rows.filter((t) => (LIFECYCLE_TYPES as readonly string[]).includes(t.status_type ?? "")).length;
  return `${n} of ${rows.length} listed thought${rows.length === 1 ? "" : "s"} carr${n === 1 ? "ies" : "y"} a lifecycle.`;
};
/** The header's lifecycle clause: the filter, the decay when on, and `startable` or the blocked decay when the dependency read is. */
const lifecycleClause = (o: Options): string => `lifecycle ${o.status}${o.decayDone ? ` (done ×${DONE_WEIGHT})` : ""}${o.startable ? ", startable" : ""}${o.decayBlocked ? `, blocked ×${BLOCKED_WEIGHT}` : ""}`;

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
      out.push(`Thoughts mentioning the subject — ranked by neighbours mentioned${o.edges ? " + subject edges evidenced" : ""}${o.decayDone || o.decayBlocked ? ", times the weight" : ""}:`);
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
    out.push(`Top thoughts — by in-scope entities mentioned${o.edges ? " + in-scope edges evidenced" : ""}${o.decayDone || o.decayBlocked ? ", times the weight" : ""}:`);
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
    else if (a === "--decay-blocked") opts.decayBlocked = true;
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
  // Likewise the blocked thoughts: the filter drops them, the decay sinks them.
  if (opts.startable && opts.decayBlocked) return { error: `--decay-blocked weighs the blocked thoughts at ${BLOCKED_WEIGHT}; --startable already drops them — pass one or the other` };
  return { url, subject: positional[0] ?? null, opts, json };
}

/**
 * Why this brain cannot run a report, or null: the entity graph is 016's, and
 * every mode reads a thought's lifecycle through 058's node_lifecycle() (the
 * dependency flags its node_state()), so both must be applied — and 058's two
 * status sets must be the ones this file filters and renders by, or a count
 * would pair one set's rows with the other's words (a script older or newer
 * than the brain's migrations, SMD-2158's `duplicate` the case in view). The
 * sets are compared as sets: their order is no rule (first review pass).
 */
export async function schemaProblem(run: Runner, opts: Pick<Options, "startable" | "decayBlocked">): Promise<string | null> {
  // The tables as this connection resolves them — a same-named table in a
  // schema off the search_path is not the graph.
  const [{ n }] = await run(`SELECT (to_regclass('ob1_entities') IS NOT NULL)::int + (to_regclass('thought_entities') IS NOT NULL)::int + (to_regclass('ob1_entity_edges') IS NOT NULL)::int AS n`, []);
  if (Number(n) !== 3) return "This brain has no entity graph: migration 016 is not applied. Run db/migrate.ts, then db/extract-entities.ts.";
  const [{ ok }] = await run(`SELECT (to_regprocedure('node_lifecycle_types()') IS NOT NULL AND to_regprocedure('node_settled_types()') IS NOT NULL AND to_regprocedure('node_lifecycle()') IS NOT NULL
                                      AND to_regprocedure('node_dependencies()') IS NOT NULL AND to_regprocedure('node_state(uuid[])') IS NOT NULL) AS ok`, []);
  if (!ok) return `graph-centrality reads a thought's lifecycle${readsDependencies(opts) ? " and its blockers" : ""} through node_state: migration 058 is not applied. Run db/migrate.ts.`;
  const [{ known, settled }] = await run(`SELECT array_to_string(node_lifecycle_types(), ',') AS known, array_to_string(node_settled_types(), ',') AS settled`, []);
  const same = (sql: unknown, ts: readonly string[]) => String(sql).split(",").sort().join() === [...ts].sort().join();
  if (!same(known, LIFECYCLE_TYPES) || !same(settled, LIFECYCLE_FILTERS.done)) {
    return `This script knows the status types ${LIFECYCLE_TYPES.join(",")} (settled: ${LIFECYCLE_FILTERS.done.join(",")}); this brain's migration 058 knows ${known} (settled: ${settled}). Update whichever is behind.`;
  }
  return null;
}

if (import.meta.main) {
  const parsed = parseArgs(process.argv.slice(2));
  if ("error" in parsed) {
    console.error(parsed.error);
    console.error(`usage: bun graph-centrality.ts --url postgres://… ["subject"] [--limit N (1-500)] [--types a,b] [--keep-numeric] [--no-edges] [--status all|open|active|done] [--decay-done] [--startable | --decay-blocked] [--json]   (exit 0 ranked, 1 no entity, 3 excluded by the numeric rule, 2 error)`);
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
  // usage error, a brain without 016 or 058 (or whose 058 knows other status
  // types), or a query that failed — never 1 for a failure or an
  // exclusion, so a caller testing for "not in the graph" is not told that by
  // a connection refused or by SMD-1935's rule.
  let code = 0;
  try {
    const problem = await schemaProblem(run, parsed.opts);
    if (problem) {
      console.error(problem);
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
