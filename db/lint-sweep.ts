#!/usr/bin/env bun
/**
 * lint-sweep.ts — a read-only quality audit of the brain: counts over
 * `thoughts`, checks of the entity graph, and a model's reading of sampled
 * thoughts, written as a markdown report (SMD-3318).
 *
 *   bun db/lint-sweep.ts --url postgres://…                        # every tier; ./lint-report-YYYY-MM-DD.md (UTC date)
 *   bun db/lint-sweep.ts --url … --tier 1 --report ~/lint/week.md  # one tier, another path
 *   bun db/lint-sweep.ts --url … --max-llm-calls 0                 # tiers 1 and 2 alone: no model call
 *
 * This is the `db/` home for what `recipes/lint-sweep/lint-sweep.js` did
 * through compat/supabase-sql (SMD-2144), which retires (SMD-3216): tiers 1
 * and 2 read on the core's tables (SMD-3318 PR 2), Tier 3 through the core's
 * provider and egress gate (PR 2b).
 *
 * ── What it reads ───────────────────────────────────────────────────────────
 * Tier 1, `thoughts`, in one pass over the table: its row count, its rows with
 * no content_fingerprint, and its undated rows, with no created_at or an
 * infinite one (exact). Then, in the 2,000 newest dated thoughts (ordered by
 * created_at alone): those with no metadata topics, tags or people; those
 * with more than 10 tags; those whose content is empty or longer than 20,000
 * characters (code points) once trimmed of every character a preview drops or
 * collapses (whitespace, control characters, zero-width and bidirectional
 * marks: one set, so a thought whose preview is blank is empty). A list's
 * entries are those a reader sees, as the brain renders them (render.ts's
 * metaList): a JSON null or a blank string is none. An undated thought is in no
 * sample: it has no place in "newest" (`infinity` would sort first and print
 * no date; migration 020 reads it as brand new, `-infinity` as infinitely
 * old).
 * Tier 2, the entity graph (migration 016's tables):
 *   - in the 500 newest dated thoughts: those no `thought_entities` row
 *     mentions (extraction found nothing in them, has not reached them, failed
 *     on them — `bun db/extract-entities.ts --retry-failed` — or is off);
 *   - `ob1_entities` with no `ob1_entity_edges` row either way (exact).
 *
 * What the recipe read and the core lacks is gone, not mapped (the ticket's
 * work item 4): its two checks on `importance`, which the core retired
 * (SMD-3661, decision 8) and `thoughts` does not have; and its groups of rows
 * sharing a fingerprint, which migration 003's partial unique index rules out
 * (a fingerprint is unique where set; twins of the same content are left
 * with none, among the rows the no-fingerprint count counts — migration 023's
 * header says why). Its graph checks read `entities` and `edges`, a companion
 * schema's tables; these read 016's. The core's capture writes `topics` and
 * `people`, never `tags`: the over-tagged check sees imported thoughts alone.
 *
 * ── What a run guarantees ───────────────────────────────────────────────────
 * The database the URL names is the one read: a connection that reached
 * another (PGDATABASE) is refused, exit 2, before the transaction. The tiers'
 * reads are in one REPEATABLE READ, READ ONLY transaction, whose first
 * statement takes the locks below: the counts are of one moment, and the
 * tiers never write to the brain. One write is not theirs: with
 * OB1_WORKER_KEY set and Tier 3 able to send, the key is resolved first, as
 * every worker's is (resolve_agent registers it, or stamps its last use, in
 * the agent registry); a lookup that fails is warned of and the tier runs
 * with no actor. A role with SELECT on `thoughts`,
 * `thought_entities`, `ob1_entities` and `ob1_entity_edges` is enough. The
 * report is written only once every read succeeded, to a new file of the
 * run's own (O_EXCL, 0600) renamed over the path: never through a symlink
 * there, never keeping an older file's mode, and a failed write leaves an
 * earlier report as it was. A run that fails writes no report and exits 1 with
 * the reason (the database's, the file system's, or the connection's). The
 * tables are named unqualified, as `db/backup.ts` names them: the role's
 * search_path finds them.
 *
 * ── Size and time ───────────────────────────────────────────────────────────
 * Each tier reads its sample once, through the created_at index, stopping
 * after its rows. The exact counts read whole tables: `thoughts` once (a
 * scan), and the entity graph's anti-join through 016's edge indexes —
 * measured on a scratch brain at about half a second warm and 5 s cold for a
 * million thoughts, so minutes at 100 million and about an hour at a billion,
 * the snapshot held throughout (vacuum's horizon with it, and any CREATE or
 * REINDEX … CONCURRENTLY waits for it). A statement is bounded by
 * --statement-timeout (60 s; 0 for none), lifted for those counts and put
 * back, and every lock wait by the same bound (lock_timeout), the counts'
 * included. The transaction's first statement locks the tables its tiers read
 * (ACCESS SHARE, as pg_dump does): a lock another session holds fails the run
 * then (an index's, a REINDEX's, at the statement that plans it). A TRUNCATE
 * or ALTER of one of them waits for the run, and every read and write of that
 * table waits behind it: the brain's traffic on it stalls for the rest of the
 * sweep, or, for a migration, until the migrator's 10 s lock timeout fails the
 * upgrade. Keep a sweep apart from an upgrade; the session's application_name
 * is lint-sweep, for pg_stat_activity. client_connection_check_interval (10 s,
 * where the server's platform has it) has the server end a stopped run's
 * statement.
 *
 * ── Tier 3: a model's reading (SMD-3318 PR 2b) ───────────────────────────────
 * The recipe sent its sample to OpenRouter with its own key and no egress
 * handling. Here the thoughts leave as the brain's own passes' do: to the chat
 * endpoint and model the server resolves (resolveEmbedConfig: OB1_CHAT_BASE_URL
 * or OB1_LLM_BASE_URL, OB1_METADATA_MODEL, OB1_LLM_TIMEOUT; --model names
 * another), and only as the egress policy lets each one leave (decided
 * 2026-11-17, as consolidation's judge does): every thought is put to the gate
 * on its own units — OB1_WORKER_KEY's name as the actor, its source, type and
 * topics, and as the marker what the prompt carries of it (its text, type,
 * topics and tags) and, apart, its whole text: it goes only when both pass, so
 * a writer's marker anywhere in the thought is the thought's — and a refused
 * one is left out; the call names every thought it carries, and providerCall
 * gates each again. A policy that would refuse every thought skips the tier
 * before any read, and before the worker key is resolved, which happens only
 * once the connection is known to have reached the URL's database. Before that,
 * the hold-back weekly-digest uses (db/sensitivity.ts, decided the same day):
 * a thought `restricted`, or `personal` unless --include-personal, by its key
 * or the enhanced-thoughts column, or so rated by the patterns over what the
 * prompt carries and its whole text, is never sent.
 *
 * The sample: the newest dated thoughts of the last --days (365) whose text,
 * trimmed, is 20 characters or more, read in the sweep's snapshot a page
 * (twice --sample-size, at most 2,000) at a time, newest first, ties by id,
 * each judged, until --sample-size (100) are to be sent, the window ends, or
 * TIER3_READ_MAX (10,000) rows are read, so an allow term naming a few older
 * thoughts finds them; the counts stop at the row that filled it. Then they go
 * TIER3_BATCH (20) a call, at most --max-llm-calls (5; 0 turns the tier off),
 * after the transaction, so no lock or snapshot is held across a model's
 * answer; each batch is read again and judged again just before its call, so
 * a thought deleted, forgotten, edited or newly held back since the snapshot
 * (minutes, with the retries' pauses) is not sent as it was. Each thought goes
 * as a ref (t1…t20), its date, type, first 400 characters and five topics and
 * tags, each type, topic and tag cut to 100 characters; today's date goes too,
 * for what is stale. A thought counts as sent once its call is dialled: a call
 * that fails may have reached the provider. The model names
 * contradictions, stale facts, superseded decisions, orphans and missing links;
 * the recipe's sixth kind, low_signal, read `importance`, which the core
 * retired. Its `source_type`, selected but never sent, is not read. Each ref
 * is mapped back to its thought's id, and a finding naming none of its batch
 * is dropped and counted. An answer that is no JSON object loses its batch's
 * findings and is counted (the recipe stopped the run), and so does an answer
 * that is no text. A call that fails,
 * after the transient retries, stops the tier: the report is written with
 * tiers 1 and 2 and the findings before it, and the run exits 1. Fewer than
 * TIER3_MIN (10) thoughts left to send skips the tier, as the recipe did. The
 * model's words are made safe as a preview is, and cut to 300 characters; so
 * is a failure's reason (to 500), a provider's error body among them.
 *
 * `recipes/lint-sweep/views.sql` stays the recipe's: views over the columns
 * `schemas/enhanced-thoughts` adds, which this script does not read.
 */

import { closeSync, existsSync, mkdirSync, openSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { SQL } from "bun";
import { commandLine, consoleWriter, type Writer } from "./cli.ts";
import { closeThenExit, databaseUrl, openSql, reachedDatabaseRefusal } from "./connect.ts";
import { heldByPatterns, heldTiers, sensitivityColumn, tierExcluded } from "./sensitivity.ts";
import { classifyError, egressDescription, egressRefusal, TRANSIENT_PAUSES_MS, workerIdentity } from "./worker-bootstrap.ts";
import { providerCall, resolveEmbedConfig, type EmbedConfig, type EmbedEnv } from "../server-portable/embed.ts";
import { mayLeaveBox, ROW_UNITS, type EgressSubject } from "../server-portable/egress.ts";
import { installBackgroundSlots } from "../server-portable/slots.ts";

/** The newest dated thoughts Tier 1's per-row checks read. */
export const TIER1_SAMPLE = 2000;
/** The newest dated thoughts Tier 2's mention check reads. */
export const TIER2_SAMPLE = 500;
/** More tags than this is over-tagged. */
const OVER_TAGGED = 10;
/** Content longer than this, trimmed, is very long. */
const VERY_LONG = 20_000;
/** How many rows of a list the report shows. */
const LISTED = 15;
/** Characters of a thought a preview shows. */
const PREVIEW = 120;
/** The per-statement bound by default, in seconds. */
const STATEMENT_TIMEOUT_S = 60;
/** The client_connection_check_interval a run sets on its session first, where the server's platform has it. */
const CONNECTION_CHECK = "10s";

/** The recipe's flags this script does not take: refused by name, saying why. */
const REMOVED_FLAGS: Readonly<Record<string, string>> = {
  "llm-model": "--llm-model is --model now (the brain's chat model, OB1_METADATA_MODEL, when absent)",
  verbose: "--verbose is removed: the run's lines are its progress",
};

export interface Tier1 {
  total: number;
  noFingerprint: number;
  undated: number;
  sampled: number;
  orphansByTag: number;
  emptyContent: number;
  veryLong: number;
  overTagged: { id: string; tags: number }[];
  overTaggedCount: number;
}

export interface Tier2 {
  sampled: number;
  unmentioned: { id: string; created: string; preview: string; cut: boolean }[];
  unmentionedCount: number;
  entities: number;
  entitiesWithNoEdges: number;
}

/** Whitespace, as ranges of code points: JavaScript's `\s`, which a preview collapses to one space. */
const BLANK_RANGES: readonly (readonly [number, number])[] = [[9, 13], [32, 32], [160, 160], [5760, 5760], [8192, 8202], [8232, 8233], [8239, 8239], [8287, 8287], [12288, 12288], [65279, 65279]];
/** Characters a preview drops: C0 and C1 controls, the Arabic letter mark, zero-width and bidirectional controls (which reorder or hide text). */
const HIDDEN_RANGES: readonly (readonly [number, number])[] = [[0, 8], [14, 31], [127, 159], [1564, 1564], [8203, 8207], [8234, 8238], [8288, 8297]];
const classOf = (ranges: readonly (readonly [number, number])[]) =>
  ranges.map(([a, b]) => (a === b ? [a] : [a, b]).map((c) => `\\u${c.toString(16).padStart(4, "0")}`).join("-")).join("");
const HIDDEN = new RegExp(`[${classOf(HIDDEN_RANGES)}\`[\\]<>]`, "g");
const BLANK_RUN = new RegExp(`[${classOf(BLANK_RANGES)}]+`, "g");

/**
 * A thought's text made safe for one markdown bullet: the hidden characters
 * above, backticks, brackets and angle brackets (code, links, HTML and
 * comments) dropped, whitespace collapsed to single spaces. A bare URL stays
 * text a renderer may still link.
 */
export function sanitizePreview(s: string): string {
  return s.replace(HIDDEN, "").replace(BLANK_RUN, " ").trim();
}

/** Every code point a preview drops or collapses, as one SQL text (NUL aside: Postgres text holds none), computed once per statement. */
const INVISIBLE = `(SELECT string_agg(chr(c), '') FROM unnest(ARRAY[${[...BLANK_RANGES, ...HIDDEN_RANGES]
  .flatMap(([a, b]) => Array.from({ length: b - a + 1 }, (_, i) => a + i)).filter((c) => c !== 0).join(",")}]) c)`;
/** An SQL text expression trimmed of the invisible characters at both ends: '' when a preview of it would be blank. */
const trimmed = (expr: string) => `btrim(${expr}, ${INVISIBLE})`;

/**
 * A metadata list's entries a reader sees, in SQL, as render.ts's metaList shows them: a JSON null or a string blank
 * once trimmed is none; 0 when the key is absent, not an array, or the metadata NULL.
 */
const arrayLen = (key: string) => `(SELECT count(*) FROM jsonb_array_elements(CASE WHEN jsonb_typeof(metadata->'${key}') = 'array' THEN metadata->'${key}' ELSE '[]'::jsonb END) e
  WHERE jsonb_typeof(e) <> 'null' AND (jsonb_typeof(e) <> 'string' OR ${trimmed("e #>> '{}'")} <> ''))::int`;
/** Content trimmed of the invisible characters, in SQL. */
const TRIMMED = trimmed("content");
/** A dated thought's created_at in SQL: set and finite, as a range the created_at index reads. */
const DATED = `created_at > '-infinity' AND created_at < 'infinity'`;
/**
 * The newest dated thoughts, `n` of them, with the columns `cols`. Ordered by
 * created_at alone, so the created_at index stops after `n` rows: with an id
 * tiebreak a group of thoughts sharing one created_at (an import's transaction,
 * a day-precision date) was read and sorted whole. Which of a group at the
 * sample's edge are in it is the index's order.
 */
const recent = (cols: string, n: number) => `SELECT ${cols} FROM thoughts WHERE ${DATED} ORDER BY created_at DESC LIMIT ${n}`;

/** Run `query` with the statement bound lifted, then put the session's back (the whole-table counts outlast a statement's bound). */
async function unbounded<T>(tx: SQL, bound: string, query: () => Promise<T>): Promise<T> {
  await tx.unsafe("SET LOCAL statement_timeout = 0");
  const out = await query();
  await tx.unsafe("SELECT pg_catalog.set_config('statement_timeout', $1, true)", [bound]);
  return out;
}

async function tier1(tx: SQL, bound: string): Promise<Tier1> {
  const [whole] = await unbounded(tx, bound, async () => (await tx.unsafe(`
    SELECT count(*)::bigint::text AS total,
           count(*) FILTER (WHERE content_fingerprint IS NULL)::bigint::text AS no_fp,
           count(*) FILTER (WHERE NOT (${DATED}) OR created_at IS NULL)::bigint::text AS undated
      FROM thoughts`)) as { total: string; no_fp: string; undated: string }[]);
  // One read of the sample: the counts and the listed rows from the same rows (the CTE, used twice, is read once).
  const [c] = (await tx.unsafe(`
    WITH recent AS MATERIALIZED (${recent("id, content, metadata, created_at", TIER1_SAMPLE)})
    SELECT count(*)::int AS sampled,
           count(*) FILTER (WHERE ${arrayLen("topics")} = 0 AND ${arrayLen("tags")} = 0 AND ${arrayLen("people")} = 0)::int AS orphans,
           count(*) FILTER (WHERE ${TRIMMED} = '')::int AS empty,
           count(*) FILTER (WHERE length(${TRIMMED}) > ${VERY_LONG})::int AS very_long,
           count(*) FILTER (WHERE ${arrayLen("tags")} > ${OVER_TAGGED})::int AS over_tagged,
           (SELECT coalesce(json_agg(json_build_object('id', o.id::text, 'tags', o.tags)), '[]'::json) FROM (
              SELECT id, created_at, ${arrayLen("tags")} AS tags FROM recent WHERE ${arrayLen("tags")} > ${OVER_TAGGED}
               ORDER BY created_at DESC, id DESC LIMIT ${LISTED}) o)::text AS over
      FROM recent`)) as { sampled: number; orphans: number; empty: number; very_long: number; over_tagged: number; over: string }[];
  return {
    total: Number(whole.total), noFingerprint: Number(whole.no_fp), undated: Number(whole.undated), sampled: c.sampled,
    orphansByTag: c.orphans, emptyContent: c.empty, veryLong: c.very_long, overTagged: JSON.parse(c.over) as Tier1["overTagged"], overTaggedCount: c.over_tagged,
  };
}

async function tier2(tx: SQL, bound: string): Promise<Tier2> {
  // One read of the sample, as Tier 1's: the counts and the listed rows from the same rows.
  const [c] = (await tx.unsafe(`
    WITH recent AS MATERIALIZED (${recent("id, content, created_at", TIER2_SAMPLE)}),
         lone AS MATERIALIZED (SELECT * FROM recent WHERE NOT EXISTS (SELECT 1 FROM thought_entities te WHERE te.thought_id = recent.id))
    SELECT (SELECT count(*) FROM recent)::int AS sampled, (SELECT count(*) FROM lone)::int AS unmentioned,
           (SELECT coalesce(json_agg(json_build_object('id', l.id::text, 'created', to_char(l.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD'),
                                                       'preview', left(l.content, ${PREVIEW}), 'cut', length(l.content) > ${PREVIEW})), '[]'::json)
              FROM (SELECT * FROM lone ORDER BY created_at DESC, id DESC LIMIT ${LISTED}) l)::text AS listed`)) as { sampled: number; unmentioned: number; listed: string }[];
  const [g] = await unbounded(tx, bound, async () => (await tx.unsafe(`
    SELECT (SELECT count(*) FROM ob1_entities)::bigint::text AS entities,
           (SELECT count(*) FROM ob1_entities e
             WHERE NOT EXISTS (SELECT 1 FROM ob1_entity_edges g WHERE g.from_entity_id = e.id)
               AND NOT EXISTS (SELECT 1 FROM ob1_entity_edges g WHERE g.to_entity_id = e.id))::bigint::text AS lonely`)) as { entities: string; lonely: string }[]);
  const rows = JSON.parse(c.listed) as Tier2["unmentioned"];
  return {
    sampled: c.sampled, unmentionedCount: c.unmentioned, entities: Number(g.entities), entitiesWithNoEdges: Number(g.lonely),
    unmentioned: rows.map((r) => ({ ...r, preview: sanitizePreview(r.preview ?? "") })),
  };
}

// ── Tier 3: a model's reading of sampled thoughts (SMD-3318 PR 2b) ───────────

/** Thoughts per model call. */
export const TIER3_BATCH = 20;
/** Tier 3's defaults: the sample, the calls, the window in days. */
export const TIER3_DEFAULTS = { sampleSize: 100, maxCalls: 5, days: 365 } as const;
/** Tier 3's bounds, each [min, max]. */
export const TIER3_BOUNDS = { sampleSize: [1, 1000], maxCalls: [0, 100], days: [1, 36500] } as const;
/** Fewer thoughts left to send than this, and Tier 3 is skipped: a contradiction needs company. */
export const TIER3_MIN = 10;
/** Characters of a thought the prompt carries. */
const TIER3_CONTENT = 400;
/** A thought shorter than this once trimmed is not sampled. */
const TIER3_MIN_CHARS = 20;
/** Characters of the model's own words a finding keeps. */
const FINDING_TEXT = 300;
/** Characters of a type, topic or tag the prompt carries. */
const TIER3_FIELD = 100;
/** The most rows Tier 3 reads looking for its sample: past it, the window's older thoughts go unread. */
export const TIER3_READ_MAX = 10_000;
/** The kinds of finding, in the report's order. The recipe's sixth, low_signal, read importance, which the core retired. */
export const CATEGORIES = ["contradictions", "stale_facts", "superseded", "orphans", "missing_links"] as const;
export type Category = (typeof CATEGORIES)[number];
const CATEGORY_TITLE: Readonly<Record<Category, string>> = {
  contradictions: "Contradictions", stale_facts: "Stale facts", superseded: "Superseded", orphans: "Orphans", missing_links: "Missing links",
};

export interface Tier3Options {
  /** The provider and egress config, resolveEmbedConfig's: the chat endpoint, the policy, the temperature. */
  cfg: EmbedConfig;
  model: string;
  sampleSize: number;
  /** At most this many model calls; 0 turns Tier 3 off. */
  maxCalls: number;
  days: number;
  includePersonal: boolean;
  /** The worker key's name: the `actor` unit each thought's gate reads. */
  actor?: string;
  /**
   * The worker key, resolved by run() once the connection is known to have reached the URL's database and before any
   * read, only when a thought could leave (the CLI's: workerIdentity, which registers the key in that brain). Not ok
   * refuses the run, exit 2.
   */
  resolveActor?: () => Promise<{ ok: true; actor?: string } | { ok: false; message: string }>;
  /** The pauses before each retry of a transient failure (worker-bootstrap's by default). */
  pausesMs?: readonly number[];
}

export interface Tier3Row { id: string; created: string; content: string; metadata: Record<string, unknown> | null }
export interface Tier3Finding { category: Category; ids: string[]; issue: string; action: string }
export interface Tier3 {
  status: "ran" | "skipped" | "failed";
  /** Why it was skipped, or how it failed: made safe as a preview is (a provider's error body is no report line). */
  reason: string | null;
  model: string;
  days: number;
  /** Dated thoughts of the window read, the newest first, up to the one that filled the sample. */
  read: number;
  /** Whether the read stopped at TIER3_READ_MAX rows with the sample not full. */
  readCapped: boolean;
  /** Of those, held back by their tier (the key, or the column) or by the patterns. */
  heldSensitive: number;
  /** Of the rest, refused by the egress policy, each on its own units. */
  heldEgress: number;
  /** Sampled thoughts gone, or held back or refused, when their batch was read again just before its call. */
  changed: number;
  /** Sent to the model: every thought of every call dialled, a failed call's included. */
  sent: number;
  /** Calls dialled. */
  calls: number;
  /** Answers that were not a JSON object: their batch's findings are lost. */
  unreadable: number;
  /** Findings dropped: not an object, or no ref naming a thought of their batch. */
  dropped: number;
  findings: Tier3Finding[];
}

/** A metadata object, or null for anything else (an array, a string, NULL). */
const objectOr = (m: unknown): Record<string, unknown> | null => (typeof m === "object" && m !== null && !Array.isArray(m) ? m as Record<string, unknown> : null);
/** A type, topic or tag as the prompt carries it: a string as it is, anything else as its JSON, cut to TIER3_FIELD characters. */
function field(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const cps = [...(typeof v === "string" ? v : JSON.stringify(v) ?? "")];
  return cps.length > TIER3_FIELD ? cps.slice(0, TIER3_FIELD).join("") : cps.join("");
}
const firstFive = (m: Record<string, unknown> | null, k: string): (string | null)[] => (Array.isArray(m?.[k]) ? (m![k] as unknown[]).slice(0, 5).map(field) : []);
/** What the prompt carries of a thought besides its ref, its date and its text. */
const promptFields = (r: Tier3Row) => ({ type: field(r.metadata?.type), topics: firstFive(r.metadata, "topics"), tags: firstFive(r.metadata, "tags") });

/** What the prompt carries of a thought besides its ref and date, as the patterns and the gate's marker read it: the text, the type, five topics, five tags. */
const sentOf = (r: Tier3Row) => {
  const f = promptFields(r);
  return [r.content, JSON.stringify(f.type), JSON.stringify(f.topics), JSON.stringify(f.tags)].join("\n");
};

/** The gate's subject for one thought: the worker key, the row's own metadata, and `text` as the marker reads it (what the prompt carries, by default). */
export function lintSubject(r: Tier3Row, actor: string | undefined, text = sentOf(r)): EgressSubject {
  return { kind: "lint", ...(actor ? { actor } : {}), ...(r.metadata ? { metadata: r.metadata } : {}), content: text };
}

export const TIER3_SYSTEM =
  "You audit a personal second brain for quality issues. " +
  "Given a batch of thoughts, each with a ref (t1, t2, ...), identify GENUINE problems in five categories. " +
  "Be CONSERVATIVE: flag only real issues, never stylistic preferences or minor overlap. " +
  "A category with no issues is an empty array. Output STRICT JSON of this exact shape, naming thoughts by their refs:\n" +
  "{\n" +
  '  "contradictions": [{"refs": ["t1", "t2"], "issue": "...", "suggested_action": "..."}],\n' +
  '  "stale_facts": [{"refs": ["t1"], "issue": "...", "suggested_action": "..."}],\n' +
  '  "superseded": [{"refs": ["t1", "t2"], "issue": "...", "suggested_action": "..."}],\n' +
  '  "orphans": [{"refs": ["t1"], "issue": "...", "suggested_action": "..."}],\n' +
  '  "missing_links": [{"refs": ["t1", "t2"], "issue": "...", "suggested_action": "..."}]\n' +
  "}\n" +
  "No markdown, no commentary, JSON only. Definitions:\n" +
  "  contradictions: two thoughts state incompatible facts.\n" +
  "  stale_facts: a deadline passed, a technology deprecated, a status outdated, as of today.\n" +
  "  superseded: an older decision replaced by a newer one, the older not marked so.\n" +
  "  orphans: content with no natural connection to anything else in the batch.\n" +
  "  missing_links: two thoughts about the same subject that do not refer to each other.";

/** The user turn for one batch: today's date (for what is stale), then each thought by its ref. */
export function tier3Prompt(batch: readonly Tier3Row[], today: string): string {
  const rows = batch.map((r, i) => ({ ref: `t${i + 1}`, date: r.created, ...promptFields(r), content: r.content }));
  return `Today: ${today}\nBatch size: ${batch.length}\n\nTHOUGHTS:\n${JSON.stringify(rows)}\n\nAudit the batch now. JSON output only.`;
}

/** Text made safe as a preview is, and cut to `max` characters. */
function clipTo(v: unknown, max: number): string {
  const t = [...sanitizePreview(typeof v === "string" ? v : "")];
  return t.length > max ? `${t.slice(0, max).join("")}…` : t.join("");
}
/** The model's words for a report line. */
const clip = (v: unknown) => clipTo(v, FINDING_TEXT);
/** A reason for a report line or the terminal: a provider's error body among them, so made safe and cut. */
const safeReason = (s: string) => clipTo(s, 500);

/**
 * A batch's answer read: the JSON object in it (a fence or a sentence around it is passed over), each category's
 * findings, each ref (`t3`, or `3`) mapped to its thought's id. A ref naming no thought of the batch is dropped, and a
 * finding left with none is dropped and counted. Null when there is no JSON object to read, or the answer is no text.
 */
export function readTier3Answer(raw: unknown, batch: readonly Tier3Row[]): { findings: Tier3Finding[]; dropped: number } | null {
  if (typeof raw !== "string") return null;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end < start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  const answer = objectOr(parsed);
  if (!answer) return null;
  const findings: Tier3Finding[] = [];
  let dropped = 0;
  for (const category of CATEGORIES) {
    const items = answer[category];
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      const o = objectOr(item);
      const refs: unknown[] = Array.isArray(o?.refs) ? o!.refs as unknown[] : Array.isArray(o?.thought_ids) ? o!.thought_ids as unknown[] : [];
      const ids: string[] = [];
      for (const ref of refs) {
        const n = typeof ref === "number" ? ref : typeof ref === "string" ? Number(/^t?(\d{1,4})$/i.exec(ref.trim())?.[1] ?? Number.NaN) : Number.NaN;
        const row = Number.isInteger(n) && n >= 1 && n <= batch.length ? batch[n - 1] : undefined;
        if (row && !ids.includes(row.id)) ids.push(row.id);
      }
      if (!o || ids.length === 0) {
        dropped++;
        continue;
      }
      findings.push({ category, ids, issue: clip(o.issue), action: clip(o.suggested_action) });
    }
  }
  return { findings, dropped };
}

/** Tier 3's rows as read: what the prompt carries of each, and whether its tier holds it back (`$1`, the held tiers). */
const rowsSql = (hasColumn: boolean, rest: string) => `
  SELECT id::text AS id, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS created, left(content, ${TIER3_CONTENT}) AS content, metadata,
         NOT (true${tierExcluded(hasColumn, "$1")}) AS tier_held
    FROM thoughts ${rest}`;
type ReadRow = Tier3Row & { tier_held: boolean };
type Verdict = "send" | "sensitive" | "egress";

/**
 * Each row's verdict, in order: held back by its tier (the key, or the column), or by the patterns over what the prompt
 * carries and its whole text (a row the second read does not return is held too); refused by the gate on what the
 * prompt carries, or on its whole text (a writer's marker anywhere in the thought is the thought's: it goes only when
 * both pass); else sent.
 */
async function judge(sql: SQL, rows: readonly ReadRow[], o: Tier3Options): Promise<{ row: Tier3Row; verdict: Verdict }[]> {
  const shaped = rows.map(({ tier_held, ...r }) => ({ row: { ...r, metadata: objectOr(r.metadata) } as Tier3Row, tierHeld: tier_held }));
  const candidates = shaped.filter((s) => !s.tierHeld).map((s) => s.row);
  const byId = new Map(candidates.map((r) => [r.id, r]));
  const leaves = (r: Tier3Row, text?: string) => mayLeaveBox(lintSubject(r, o.actor, text), o.cfg.chat, o.cfg.egress).allowed;
  const refusedWhole = new Set<string>();
  const held = await heldByPatterns(sql, candidates.map((r) => ({ id: r.id, sent: sentOf(r) })), heldTiers(o.includePersonal), (id, text) => {
    const r = byId.get(id);
    if (r && !leaves(r, `${text}\n${sentOf(r)}`)) refusedWhole.add(id);
  });
  return shaped.map(({ row, tierHeld }) => ({
    row,
    verdict: tierHeld || held.has(row.id) ? "sensitive" : refusedWhole.has(row.id) || !leaves(row) ? "egress" : "send",
  }));
}

interface Tier3Sample { rows: Tier3Row[]; read: number; readCapped: boolean; heldSensitive: number; heldEgress: number; hasColumn: boolean }

/**
 * Tier 3's sample, read in the sweep's snapshot: the newest dated thoughts of the window whose text, trimmed, is 20
 * characters or more, a page (twice the sample, at most 2,000) at a time, newest first (ties by id), each judged, until
 * --sample-size are to be sent, the window ends, or TIER3_READ_MAX rows are read: so an allow term that names a few
 * older thoughts finds them. A sensitivity_tier column the role may not read refuses the run. The counts stop at the
 * row that filled the sample.
 */
async function tier3Sample(tx: SQL, o: Tier3Options): Promise<Tier3Sample> {
  const hasColumn = await sensitivityColumn(tx, true,
    "public.thoughts has a sensitivity_tier column this role may not read: refusing rather than send the rows it marks to a model (grant SELECT on it)");
  const page = Math.min(o.sampleSize * 2, 2000);
  const out: Tier3Sample = { rows: [], read: 0, readCapped: false, heldSensitive: 0, heldEgress: 0, hasColumn };
  for (let offset = 0; ; offset += page) {
    const rows = (await tx.unsafe(rowsSql(hasColumn, `
     WHERE ${DATED} AND created_at >= now() - make_interval(days => $2::int) AND char_length(${TRIMMED}) >= ${TIER3_MIN_CHARS}
     ORDER BY created_at DESC, id DESC LIMIT ${page} OFFSET ${offset}`), [tx.array([...heldTiers(o.includePersonal)], "TEXT"), o.days])) as ReadRow[];
    for (const { row, verdict } of await judge(tx, rows, o)) {
      out.read++;
      if (verdict === "sensitive") out.heldSensitive++;
      else if (verdict === "egress") out.heldEgress++;
      else out.rows.push(row);
      if (out.rows.length === o.sampleSize) return out;
    }
    if (rows.length < page) return out;
    if (out.read >= TIER3_READ_MAX) return { ...out, readCapped: true };
  }
}

/**
 * A batch read again just before its call, outside the snapshot: a thought deleted since, or one its tier, the patterns
 * or the gate now hold back (a tier set, a `forget_thought`, an edit), is not sent; an edited one goes as it is now.
 */
async function recheck(sql: SQL, batch: readonly Tier3Row[], o: Tier3Options, hasColumn: boolean): Promise<Tier3Row[]> {
  const fresh = (await sql.unsafe(rowsSql(hasColumn, "WHERE id = ANY($2::uuid[])"),
    [sql.array([...heldTiers(o.includePersonal)], "TEXT"), sql.array(batch.map((r) => r.id), "TEXT")])) as ReadRow[];
  const verdicts = new Map((await judge(sql, fresh, o)).map((v) => [v.row.id, v]));
  return batch.flatMap((r) => {
    const v = verdicts.get(r.id);
    return v?.verdict === "send" ? [v.row] : [];
  });
}

/** A Tier 3 that did not run, and why. */
const skipped3 = (o: Tier3Options, reason: string, counts: Partial<Tier3> = {}): Tier3 => ({
  status: "skipped", reason: safeReason(reason), model: o.model, days: o.days, read: 0, readCapped: false, heldSensitive: 0, heldEgress: 0, changed: 0,
  sent: 0, calls: 0, unreadable: 0, dropped: 0, findings: [], ...counts,
});

/** Retry a call while its failure is transient (429, 5xx, a connection's), after each of `pauses`. */
async function withRetry<T>(pauses: readonly number[], w: Writer, fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (classifyError(e) === "transient" && attempt < pauses.length) {
        w.err(`[tier 3] a transient failure (${safeReason(reasonOf(e))}); retrying in ${pauses[attempt] / 1000} s`);
        await Bun.sleep(pauses[attempt]);
        continue;
      }
      throw e;
    }
  }
}

/**
 * Tier 3's calls, after the sweep's transaction (no lock or snapshot is held across a model's answer): the sample in
 * batches of TIER3_BATCH, at most --max-llm-calls of them, each read again just before its call (recheck), each call
 * naming every thought it carries (providerCall gates each again). An answer that is no JSON object loses its batch's
 * findings and is counted; a call that fails (after the transient retries), or a batch's second read that fails, stops
 * the tier, the findings so far kept.
 */
async function tier3Calls(sql: SQL, sample: Tier3Sample, o: Tier3Options, w: Writer): Promise<Tier3> {
  const counts = { read: sample.read, readCapped: sample.readCapped, heldSensitive: sample.heldSensitive, heldEgress: sample.heldEgress };
  if (sample.rows.length < TIER3_MIN) {
    return skipped3(o, `${sample.rows.length} thought(s) left to send of ${sample.read} read in the last ${o.days} days${sample.readCapped ? ` (the read stopped at ${TIER3_READ_MAX})` : ""}, fewer than ${TIER3_MIN}`, counts);
  }
  const batches: Tier3Row[][] = [];
  for (let i = 0; i < sample.rows.length && batches.length < o.maxCalls; i += TIER3_BATCH) batches.push(sample.rows.slice(i, i + TIER3_BATCH));
  const out: Tier3 = { status: "ran", reason: null, model: o.model, days: o.days, ...counts, changed: 0, sent: 0, calls: 0, unreadable: 0, dropped: 0, findings: [] };
  const failed = (reason: string): Tier3 => ({ ...out, status: "failed", reason: safeReason(reason) });
  const today = new Date().toISOString().slice(0, 10);
  for (const [k, planned] of batches.entries()) {
    let batch: Tier3Row[];
    try {
      batch = await recheck(sql, planned, o, sample.hasColumn);
    } catch (e) {
      return failed(`batch ${k + 1} of ${batches.length}, read again before its call: ${reasonOf(e)}`);
    }
    out.changed += planned.length - batch.length;
    if (batch.length === 0) continue;
    const body = {
      model: o.model,
      max_tokens: 2048,
      temperature: o.cfg.metadataTemperature,
      ...o.cfg.metadataReasoning,
      messages: [{ role: "system", content: TIER3_SYSTEM }, { role: "user", content: tier3Prompt(batch, today) }],
    };
    // Counted as dialled: a call that fails may have reached the provider, its text with it.
    out.calls++;
    out.sent += batch.length;
    let raw: unknown;
    try {
      const answer = await withRetry(o.pausesMs ?? TRANSIENT_PAUSES_MS, w, () =>
        providerCall<{ choices?: { message?: { content?: unknown } }[] } | null>(o.cfg, "/chat/completions", body, batch.map((r) => lintSubject(r, o.actor))));
      raw = answer?.choices?.[0]?.message?.content;
    } catch (e) {
      return failed(`call ${out.calls} of ${batches.length}: ${reasonOf(e)}`);
    }
    const read = readTier3Answer(raw, batch);
    if (!read) {
      out.unreadable++;
      continue;
    }
    out.findings.push(...read.findings);
    out.dropped += read.dropped;
  }
  return out;
}

/** The report, as markdown. */
export function renderReport(r: { tier: string; database: string; startedAt: string; finishedAt: string; t1: Tier1 | null; t2: Tier2 | null; t3?: Tier3 | null }): string {
  const day = r.startedAt.slice(0, 10);
  const L: string[] = [
    "---", `title: Lint Sweep — ${day}`, `database: ${r.database}`, `tier: ${r.tier}`, `started_at: ${r.startedAt}`, `finished_at: ${r.finishedAt}`, "---", "",
    `# Brain Lint Sweep — ${day}`, "",
    "*Read-only audit: the tiers' reads are one snapshot, and the tiers write nothing to the brain. Tier 3's findings are a model's reading: suggestions, not facts.*", "",
    "## Scan scope", "",
  ];
  if (r.t1) L.push(`- **Tier 1** — the table's row count and its rows with no content_fingerprint or no finite created_at, exact; the per-row checks over the **${r.t1.sampled} newest dated thoughts** (\`created_at desc\`; at most ${TIER1_SAMPLE}).`);
  if (r.t2) L.push(`- **Tier 2** — the mention check over the **${r.t2.sampled} newest dated thoughts** (at most ${TIER2_SAMPLE}); the entities with no edge, exact, over all ${r.t2.entities}.`);
  const t3 = r.t3 ?? null;
  if (t3) {
    L.push(t3.status === "skipped"
      ? `- **Tier 3** — skipped: ${t3.reason}.`
      : `- **Tier 3** — a model (${t3.model}) reading the newest dated thoughts of the last ${t3.days} days, ${TIER3_BATCH} a call: ${t3.sent} sent in ${t3.calls} call(s).`);
  }
  L.push("");
  if (r.t1) {
    L.push("## Tier 1 — thoughts", "");
    L.push(`- Total thoughts (exact): **${r.t1.total}**`);
    L.push(`- No content_fingerprint (exact): **${r.t1.noFingerprint}** — a capture through the brain's functions sets it; a raw insert leaves it NULL, \`SELECT backfill_content_fingerprints();\` sets it (migration 023), and a twin of a fingerprinted thought's content keeps none.`);
    L.push(`- No created_at, or an infinite one (exact): **${r.t1.undated}** — in no sample below.`);
    L.push(`- Orphans by tag (no topics, tags or people; newest ${r.t1.sampled}): **${r.t1.orphansByTag}** — pages (\`upsert_page\` writes none), imports and raw inserts, and a capture whose tagging was cut off (an outage or a refused egress leaves its \`metadata_extraction_failed\` marker alone; other failures tag it \`uncategorized\` beside the marker, which counts as tagged).`);
    L.push(`- Over-tagged (more than ${OVER_TAGGED} tags; newest ${r.t1.sampled}): **${r.t1.overTaggedCount}** — imports' tags: the brain's capture writes topics, not tags.`);
    for (const o of r.t1.overTagged) L.push(`  - ${o.id} → ${o.tags} tags`);
    if (r.t1.overTaggedCount > r.t1.overTagged.length) L.push(`  - …and ${r.t1.overTaggedCount - r.t1.overTagged.length} more`);
    L.push(`- Empty content (newest ${r.t1.sampled}): **${r.t1.emptyContent}**`);
    L.push(`- Very long content (over ${VERY_LONG.toLocaleString("en-US")} characters once trimmed; newest ${r.t1.sampled}): **${r.t1.veryLong}**`, "");
  }
  if (r.t2) {
    L.push("## Tier 2 — the entity graph", "");
    L.push(`- Thoughts no entity mention names (newest ${r.t2.sampled}): **${r.t2.unmentionedCount}** — extraction found nothing in them, has not reached them yet, failed on them (\`bun db/extract-entities.ts --retry-failed\`), or is off.`);
    for (const u of r.t2.unmentioned) L.push(`  - ${u.id} (${u.created}) — ${u.preview}${u.cut ? "…" : ""}`);
    if (r.t2.unmentionedCount > r.t2.unmentioned.length) L.push(`  - …and ${r.t2.unmentionedCount - r.t2.unmentioned.length} more`);
    L.push(`- Entities with no edge either way (exact, of ${r.t2.entities}): **${r.t2.entitiesWithNoEdges}**`, "");
  }
  if (t3 && t3.status !== "skipped") {
    L.push("## Tier 3 — a model's reading of sampled thoughts", "");
    if (t3.status === "failed") L.push(`*Stopped: ${t3.reason}. The findings below are the calls' before it.*`, "");
    L.push(`- Read (dated, the last ${t3.days} days, 20 characters or more, newest first, until the sample filled): **${t3.read}**`);
    L.push(`- Held back by their sensitivity tier or the sensitivity patterns: **${t3.heldSensitive}**`);
    L.push(`- Held back by the egress policy: **${t3.heldEgress}**`);
    L.push(`- Gone, or held back, when read again just before their call: **${t3.changed}**`);
    if (t3.readCapped) L.push(`- The read stopped at ${TIER3_READ_MAX.toLocaleString("en-US")} thoughts with the sample not full: older thoughts of the window were not read.`);
    L.push(`- Sent to ${t3.model}: **${t3.sent}** in **${t3.calls}** call(s), a failed one's included${t3.unreadable ? `; **${t3.unreadable}** answer(s) not JSON, their findings lost` : ""}${t3.dropped ? `; **${t3.dropped}** finding(s) dropped, naming no thought of their batch` : ""}`, "");
    for (const c of CATEGORIES) {
      const of = t3.findings.filter((f) => f.category === c);
      L.push(`### ${CATEGORY_TITLE[c]} (${of.length})`, "");
      for (const f of of) L.push(`- ${f.ids.join(", ")} — ${f.issue || "(no issue given)"}${f.action ? ` → ${f.action}` : ""}`);
      if (of.length) L.push("");
    }
    L.push("");
  }
  L.push("---", "", "**Safety:** every finding is a suggestion for a person to review. Check a thought (the `fetch` tool, the operator GUI) before acting on it; never delete or edit one on this report alone.", "");
  return L.join("\n");
}

/** `~` and `~/…` to the home directory. */
function expandHome(raw: string): string {
  if (raw === "~") return homedir();
  if (raw.startsWith("~/")) return join(homedir(), raw.slice(2));
  return raw;
}

/**
 * The report's path: an absolute one (after `~`) as given; a relative one only
 * inside the working directory — one that climbs out (`../../x`) is almost
 * always a mistyped flag, and is refused (the recipe's rule; a name that only
 * starts with two dots is inside). A directory there is refused too, before
 * any read. Returns the path or the refusal.
 */
export function reportPath(raw: string, cwd = process.cwd()): { path: string } | { error: string } {
  const expanded = expandHome(raw);
  const path = resolve(cwd, expanded);
  if (existsSync(path) && statSync(path).isDirectory()) return { error: `--report ${raw} is a directory; give a file's path` };
  // The temporary file adds `.<pid>.<8 hex>.tmp` (up to 30 bytes) to the name, which must stay under 255.
  if (Buffer.byteLength(basename(path)) > 220) return { error: `--report's file name is longer than 220 bytes; shorten it` };
  if (isAbsolute(expanded)) return { path };
  const rel = relative(cwd, path);
  if (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) return { path };
  return { error: `--report ${raw} climbs out of the working directory; give an absolute path (e.g. ~/lint/report.md) instead` };
}

/** Write `text` to `path` through a new file of this run's own (O_EXCL, 0600) renamed over it; the temporary file removed on failure. */
export function writeReport(path: string, text: string): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  const fd = openSync(tmp, "wx", 0o600);
  try {
    try {
      writeSync(fd, text);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* renamed, or gone */ }
    throw e;
  }
}

export interface SweepOptions {
  /** A client on the brain, of one connection (the CLI's): the run's session setting and its check go on it before the transaction. */
  sql: SQL;
  tier: "1" | "2" | "3" | "all";
  /** Tier 3's model, sample and egress (needed when `tier` is 3 or all). */
  tier3?: Tier3Options;
  /** The report's resolved path. */
  report: string;
  /** The URL the client was opened on: the run refuses when the connection reached another database. */
  url?: string;
  writer?: Writer;
}

/** The SQLSTATE and message of a database error, else the client's code (a refused connection's) and message, else the message. */
function reasonOf(e: unknown): string {
  const err = e as { errno?: unknown; code?: unknown; message?: unknown };
  const state = typeof err?.errno === "string" && /^[0-9A-Z]{5}$/.test(err.errno) ? `${err.errno} `
    : typeof err?.code === "string" && /^ERR_[A-Z_]+$/.test(err.code) ? `${err.code} ` : "";
  return `${state}${String(err?.message ?? e).split("\n")[0]}`;
}

/**
 * The sweep: the tiers asked for, from one snapshot, then Tier 3's calls, then the report. Exit code: 0 written; 1 not
 * written, or written with Tier 3 stopped by a failed call; 2 another database.
 */
export async function run(opts: SweepOptions): Promise<number> {
  const w = opts.writer ?? consoleWriter;
  const startedAt = new Date().toISOString();
  let t1: Tier1 | null = null, t2: Tier2 | null = null, t3: Tier3 | null = null, database = "";
  const wants = (n: "1" | "2" | "3") => opts.tier === n || opts.tier === "all";
  let o3 = wants("3") ? opts.tier3 : undefined;
  if (wants("3") && !o3) throw new Error("lint-sweep: tier 3 needs its options (tier3)");
  // Set inside the transaction's callback, which control flow does not follow: declared so, not narrowed to null.
  let sample = null as Tier3Sample | null;
  try {
    // Best effort: a server whose platform cannot watch the socket refuses the setting.
    await opts.sql.unsafe(`SET client_connection_check_interval = '${CONNECTION_CHECK}'`).catch(() => {});
    const [{ db }] = (await opts.sql.unsafe("SELECT pg_catalog.current_database() AS db")) as { db: string }[];
    database = db;
    if (opts.url !== undefined) {
      const refusal = await reachedDatabaseRefusal(opts.sql, opts.url);
      if (refusal !== null) {
        w.err(`lint-sweep refused — ${refusal}.`);
        return 2;
      }
    }
    if (o3) {
      // Before any read, once the database is the URL's: a tier turned off, or a policy that refuses every thought
      // even with an actor, sends nothing and resolves no key; then the key (its registry write lands in this brain),
      // and the policy again for an unkeyed run, whose thoughts carry no actor.
      const keyed = o3.maxCalls === 0 ? "--max-llm-calls 0" : egressRefusal(o3.cfg.chat, o3.cfg.egress);
      if (keyed) t3 = skipped3(o3, keyed);
      else {
        if (o3.resolveActor) {
          const id = await o3.resolveActor();
          if (!id.ok) {
            w.err(id.message);
            return 2;
          }
          o3 = { ...o3, ...(id.actor ? { actor: id.actor } : {}) };
        }
        const unkeyed = o3.actor ? null : egressRefusal(o3.cfg.chat, o3.cfg.egress, ROW_UNITS);
        if (unkeyed) t3 = skipped3(o3, unkeyed);
      }
    }
    w.out(`[lint-sweep] database ${db}, tier ${opts.tier}, report ${opts.report}`);
    await opts.sql.begin("ISOLATION LEVEL REPEATABLE READ READ ONLY", async (txn) => {
      const tx = txn as unknown as SQL;
      // The tables the tiers read, ACCESS SHARE, first and under the statement bound (a REPEATABLE READ transaction's
      // snapshot is its first query's; LOCK is none): a TRUNCATE or a change of shape waits for the run.
      const toLock = ["thoughts", ...(wants("2") ? ["thought_entities", "ob1_entities", "ob1_entity_edges"] : [])];
      try {
        await tx.unsafe(`LOCK TABLE ${toLock.join(", ")} IN ACCESS SHARE MODE`);
      } catch (e) {
        throw new Error(`locking ${toLock.join(", ")}: ${reasonOf(e)}`);
      }
      const [{ bound }] = (await tx.unsafe("SELECT pg_catalog.current_setting('statement_timeout') AS bound")) as { bound: string }[];
      // Every lock wait bounded too, the unbounded counts' included: the table lock above does not cover an index
      // (a REINDEX takes SHARE on its table, compatible with the run's, and ACCESS EXCLUSIVE on the index, which the
      // planner of a count waits for).
      await tx.unsafe("SELECT pg_catalog.set_config('lock_timeout', $1, true)", [bound]);
      if (wants("1")) {
        try {
          t1 = await tier1(tx, bound);
        } catch (e) {
          throw new Error(`tier 1: ${reasonOf(e)}`);
        }
        w.out(`[tier 1] ${t1.total} thoughts, ${t1.noFingerprint} without a fingerprint, ${t1.undated} undated; of the newest ${t1.sampled}: ${t1.orphansByTag} orphans by tag, ${t1.overTaggedCount} over-tagged, ${t1.emptyContent} empty, ${t1.veryLong} very long`);
      }
      if (wants("2")) {
        try {
          t2 = await tier2(tx, bound);
        } catch (e) {
          throw new Error(`tier 2: ${reasonOf(e)}`);
        }
        w.out(`[tier 2] of the newest ${t2.sampled}: ${t2.unmentionedCount} with no entity mention; ${t2.entitiesWithNoEdges} of ${t2.entities} entities with no edge`);
      }
      if (o3 && !t3) {
        try {
          sample = await tier3Sample(tx, o3);
        } catch (e) {
          throw new Error(`tier 3: ${reasonOf(e)}`);
        }
      }
    });
    if (o3 && sample) t3 = await tier3Calls(opts.sql, sample, o3, w);
    if (t3) {
      w.out(t3.status === "skipped" ? `[tier 3] skipped: ${t3.reason}`
        : `[tier 3] ${t3.read} read, ${t3.heldSensitive} held back by sensitivity, ${t3.heldEgress} by the egress policy; ${t3.changed ? `${t3.changed} gone or held back before their call, ` : ""}${t3.sent} sent in ${t3.calls} call(s): ${t3.findings.length} finding(s)${t3.unreadable ? `, ${t3.unreadable} answer(s) not JSON` : ""}${t3.dropped ? `, ${t3.dropped} dropped` : ""}`);
    }
  } catch (e) {
    w.err(`lint-sweep FAILED — ${reasonOf(e)}. No report was written.`);
    return 1;
  }
  try {
    writeReport(opts.report, renderReport({ tier: opts.tier, database, startedAt, finishedAt: new Date().toISOString(), t1, t2, t3 }));
  } catch (e) {
    w.err(`lint-sweep FAILED writing ${opts.report}: ${reasonOf(e)}. An earlier report there is as it was.`);
    return 1;
  }
  w.out(`[lint-sweep] report written: ${opts.report}`);
  if (t3?.status === "failed") {
    w.err(`lint-sweep: Tier 3 stopped — ${t3.reason}. The report was written with ${opts.tier === "all" ? "tiers 1 and 2 and " : ""}the findings before it.`);
    return 1;
  }
  return 0;
}

// ── CLI ───────────────────────────────────────────────────────────────────

if (import.meta.main) {
  const cli = commandLine(
    "lint-sweep.ts",
    {
      url: "one", tier: "one", report: "one", "statement-timeout": "one",
      "sample-size": "one", "max-llm-calls": "one", days: "one", model: "one", "include-personal": "none",
    },
    {
      hints: {
        url: "<postgres://…>", tier: "<1|2|3|all> (all)", report: "<path> (./lint-report-YYYY-MM-DD.md, the UTC date)", "statement-timeout": `<seconds> (${STATEMENT_TIMEOUT_S}; 0: none)`,
        "sample-size": `<thoughts> (Tier 3: ${TIER3_DEFAULTS.sampleSize})`, "max-llm-calls": `<calls> (Tier 3: ${TIER3_DEFAULTS.maxCalls}; 0: off)`,
        days: `<days> (Tier 3's window: ${TIER3_DEFAULTS.days})`, model: "<id> (Tier 3: OB1_METADATA_MODEL's)", "include-personal": "(Tier 3 sends personal thoughts too)",
      },
      removed: REMOVED_FLAGS,
    },
  );
  const tier = cli.value("tier") ?? "all";
  if (tier !== "1" && tier !== "2" && tier !== "3" && tier !== "all") {
    console.error(`--tier must be 1, 2, 3 or all, got ${JSON.stringify(tier.slice(0, 20))}`);
    process.exit(2);
  }
  const where = reportPath(cli.value("report") ?? `lint-report-${new Date().toISOString().slice(0, 10)}.md`);
  if ("error" in where) {
    console.error(where.error);
    process.exit(2);
  }
  const timeout = cli.int("statement-timeout", { absent: STATEMENT_TIMEOUT_S, min: 0, max: 2147483 });
  const sampleSize = cli.int("sample-size", { absent: TIER3_DEFAULTS.sampleSize, min: TIER3_BOUNDS.sampleSize[0], max: TIER3_BOUNDS.sampleSize[1] });
  const maxCalls = cli.int("max-llm-calls", { absent: TIER3_DEFAULTS.maxCalls, min: TIER3_BOUNDS.maxCalls[0], max: TIER3_BOUNDS.maxCalls[1] });
  const days = cli.int("days", { absent: TIER3_DEFAULTS.days, min: TIER3_BOUNDS.days[0], max: TIER3_BOUNDS.days[1] });
  const url = databaseUrl(cli.value("url"));
  let tier3: Tier3Options | undefined;
  if (tier === "3" || tier === "all") {
    // The server's own resolution of the chat endpoint, the model and the egress policy (weekly-digest's), and the
    // worker key's name as each thought's actor.
    const cfg = resolveEmbedConfig(process.env as unknown as EmbedEnv);
    const model = (cli.value("model") ?? "").trim() || cfg.metadataModel;
    console.log(`[tier 3] model ${model}; egress: ${egressDescription(cfg.chat, cfg.egress, cfg.chat.declaredBy ?? "OB1_LLM_LOCAL")}`);
    tier3 = {
      cfg, model, sampleSize, maxCalls, days, includePersonal: cli.has("include-personal"),
      resolveActor: async () => {
        const id = await workerIdentity(url, process.env, {
          noKeyWarning: "  note: OB1_WORKER_KEY is not set — Tier 3 runs without an actor; release its thoughts by their source, type, topic or a marker, not actor:<key>.",
        });
        if (!id.ok) return { ok: false, message: id.message };
        installBackgroundSlots({ url, raw: process.env.OB1_BACKGROUND_SLOTS, modelSlots: process.env.OB1_MODEL_SLOTS });
        return { ok: true, ...(id.identity.keyName ? { actor: id.identity.keyName } : {}) };
      },
    };
  }
  const sql = openSql(url, { max: 1, session: { statement_timeout: `${timeout}s`, application_name: "lint-sweep" } });
  await closeThenExit(sql, async () => {
    return run({ sql, tier, report: where.path, url, ...(tier3 ? { tier3 } : {}) });
  });
}
