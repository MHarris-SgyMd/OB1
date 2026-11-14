#!/usr/bin/env bun
/**
 * lint-sweep.ts — a read-only quality audit of the brain: counts over
 * `thoughts` and checks of the entity graph, written as a markdown report
 * (SMD-3318).
 *
 *   bun db/lint-sweep.ts --url postgres://…                       # both tiers; ./lint-report-YYYY-MM-DD.md (UTC date)
 *   bun db/lint-sweep.ts --url … --tier 1 --report ~/lint/week.md  # one tier, another path
 *
 * This is the `db/` home for what `recipes/lint-sweep/lint-sweep.js` did
 * through compat/supabase-sql (SMD-2144), which retires (SMD-3216). Its tiers
 * 1 and 2 are here, read on the core's tables; its Tier 3, a model's reading
 * of sampled thoughts, comes in SMD-3318 PR 2b through the core's provider and
 * egress gate, and `--tier 3` is refused until then (exit 2), as are the flags
 * that went with it (each naming why).
 *
 * ── What it reads ───────────────────────────────────────────────────────────
 * Tier 1, `thoughts`, in one pass over the table: its row count, its rows with
 * no content_fingerprint, and its rows with no created_at (exact). Then, in
 * the 2,000 newest dated thoughts (created_at, then id): those with no
 * metadata topics, tags or people; those with more than 10 tags; those whose
 * content is empty or longer than 20,000 characters once trimmed of
 * whitespace (spaces, tabs, line breaks, form feeds, vertical tabs, no-break
 * spaces). A thought with no created_at is in no sample: it has no place in
 * "newest".
 * Tier 2, the entity graph (migration 016's tables):
 *   - in the 500 newest dated thoughts: those no `thought_entities` row
 *     mentions (extraction found nothing in them, has not reached them, or is
 *     off);
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
 * another (PGDATABASE) is refused, exit 2. The tiers' reads are in one
 * REPEATABLE READ, READ ONLY transaction: the counts are of one moment, and a
 * run never writes to the brain. A role with SELECT on `thoughts`,
 * `thought_entities`, `ob1_entities` and `ob1_entity_edges` is enough. The
 * report is written only once every read succeeded, to a new file of the
 * run's own (O_EXCL, 0600) renamed over the path: never through a symlink
 * there, never keeping an older file's mode, and a failed write leaves an
 * earlier report as it was. A run that fails writes no report and exits 1 with
 * the database's reason.
 *
 * ── Size and time ───────────────────────────────────────────────────────────
 * The samples are bounded and read the created_at index. The exact counts
 * read whole tables: `thoughts` once (a scan), and the entity graph's
 * anti-join through 016's edge indexes; seconds at a million thoughts, hours
 * at a billion, the snapshot held throughout (vacuum's horizon with it). A
 * statement is bounded by --statement-timeout (60 s; 0 for none), lifted for
 * those counts and put back. The run's first statement locks the tables its
 * tiers read (ACCESS SHARE, as pg_dump does), under the bound: a lock another
 * session holds fails the run then, and the unbounded counts after can wait on
 * none; a TRUNCATE or ALTER waits for the run, and so does a migration
 * altering one of them (keep a sweep apart from an upgrade).
 * client_connection_check_interval (10 s, where the server's platform has it)
 * has the server end a stopped run's statement.
 *
 * `recipes/lint-sweep/views.sql` stays the recipe's: views over the columns
 * `schemas/enhanced-thoughts` adds, which this script does not read.
 */

import { closeSync, existsSync, mkdirSync, openSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { SQL } from "bun";
import { commandLine, consoleWriter, type Writer } from "./cli.ts";
import { closeThenExit, databaseUrl, openSql, reachedDatabaseRefusal } from "./connect.ts";

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

/** The recipe's flags that went with its Tier 3, and the old connection's names: refused by name, saying why. */
const REMOVED_FLAGS: Readonly<Record<string, string>> = {
  "sample-size": "Tier 3's sample; Tier 3 comes in SMD-3318 PR 2b",
  "max-llm-calls": "Tier 3's model calls; Tier 3 comes in SMD-3318 PR 2b",
  days: "Tier 3's window; Tier 3 comes in SMD-3318 PR 2b",
  "llm-model": "Tier 3's model; Tier 3 comes in SMD-3318 PR 2b",
  verbose: "the run's lines are its progress",
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

/**
 * A thought's text made safe for one markdown bullet: control characters
 * (escape sequences, bells), backticks, brackets and angle brackets (code, links,
 * HTML and comments) dropped, whitespace collapsed to single spaces.
 */
export function sanitizePreview(s: string): string {
  return s.replace(/[\u0000-\u0008\u000e-\u001f\u007f`[\]<>]/g, "").replace(/\s+/g, " ").trim();
}

/** A metadata key's array length in SQL, 0 when the key is absent, not an array, or the metadata NULL. */
const arrayLen = (key: string) => `jsonb_array_length(CASE WHEN jsonb_typeof(metadata->'${key}') = 'array' THEN metadata->'${key}' ELSE '[]'::jsonb END)`;
/** Content trimmed of whitespace, in SQL: spaces, tabs, line breaks, form feeds, vertical tabs (chr 11), no-break spaces (chr 160). */
const TRIMMED = `btrim(content, E' \\t\\n\\r\\f' || chr(11) || chr(160))`;
/** The newest dated thoughts, `n` of them, with the columns `cols`. */
const recent = (cols: string, n: number) => `SELECT ${cols} FROM thoughts WHERE created_at IS NOT NULL ORDER BY created_at DESC, id DESC LIMIT ${n}`;

/** Run `query` with the statement bound lifted, then put the session's back (the whole-table counts outlast a page's bound). */
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
           count(*) FILTER (WHERE created_at IS NULL)::bigint::text AS undated
      FROM thoughts`)) as { total: string; no_fp: string; undated: string }[]);
  const [c] = (await tx.unsafe(`
    WITH recent AS (${recent("id, content, metadata", TIER1_SAMPLE)})
    SELECT count(*)::int AS sampled,
           count(*) FILTER (WHERE ${arrayLen("topics")} = 0 AND ${arrayLen("tags")} = 0 AND ${arrayLen("people")} = 0)::int AS orphans,
           count(*) FILTER (WHERE ${TRIMMED} = '')::int AS empty,
           count(*) FILTER (WHERE length(${TRIMMED}) > ${VERY_LONG})::int AS very_long,
           count(*) FILTER (WHERE ${arrayLen("tags")} > ${OVER_TAGGED})::int AS over_tagged
      FROM recent`)) as { sampled: number; orphans: number; empty: number; very_long: number; over_tagged: number }[];
  const over = (await tx.unsafe(`
    WITH recent AS (${recent("id, metadata, created_at", TIER1_SAMPLE)})
    SELECT id::text AS id, ${arrayLen("tags")} AS tags FROM recent WHERE ${arrayLen("tags")} > ${OVER_TAGGED}
     ORDER BY created_at DESC, id DESC LIMIT ${LISTED}`)) as { id: string; tags: number }[];
  return {
    total: Number(whole.total), noFingerprint: Number(whole.no_fp), undated: Number(whole.undated), sampled: c.sampled,
    orphansByTag: c.orphans, emptyContent: c.empty, veryLong: c.very_long, overTagged: over, overTaggedCount: c.over_tagged,
  };
}

async function tier2(tx: SQL, bound: string): Promise<Tier2> {
  const [c] = (await tx.unsafe(`
    WITH recent AS (${recent("id", TIER2_SAMPLE)})
    SELECT count(*)::int AS sampled,
           count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM thought_entities te WHERE te.thought_id = recent.id))::int AS unmentioned
      FROM recent`)) as { sampled: number; unmentioned: number }[];
  const [g] = await unbounded(tx, bound, async () => (await tx.unsafe(`
    SELECT (SELECT count(*) FROM ob1_entities)::bigint::text AS entities,
           (SELECT count(*) FROM ob1_entities e
             WHERE NOT EXISTS (SELECT 1 FROM ob1_entity_edges g WHERE g.from_entity_id = e.id)
               AND NOT EXISTS (SELECT 1 FROM ob1_entity_edges g WHERE g.to_entity_id = e.id))::bigint::text AS lonely`)) as { entities: string; lonely: string }[]);
  const rows = (await tx.unsafe(`
    WITH recent AS (${recent("id, content, created_at", TIER2_SAMPLE)})
    SELECT id::text AS id, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS created,
           left(content, ${PREVIEW}) AS preview, length(content) > ${PREVIEW} AS cut
      FROM recent WHERE NOT EXISTS (SELECT 1 FROM thought_entities te WHERE te.thought_id = recent.id)
     ORDER BY created_at DESC, id DESC LIMIT ${LISTED}`)) as { id: string; created: string; preview: string; cut: boolean }[];
  return {
    sampled: c.sampled, unmentionedCount: c.unmentioned, entities: Number(g.entities), entitiesWithNoEdges: Number(g.lonely),
    unmentioned: rows.map((r) => ({ ...r, preview: sanitizePreview(r.preview ?? "") })),
  };
}

/** The report, as markdown. */
export function renderReport(r: { tier: string; database: string; startedAt: string; finishedAt: string; t1: Tier1 | null; t2: Tier2 | null }): string {
  const day = r.finishedAt.slice(0, 10);
  const L: string[] = [
    "---", `title: Lint Sweep — ${day}`, `database: ${r.database}`, `tier: ${r.tier}`, `started_at: ${r.startedAt}`, `finished_at: ${r.finishedAt}`, "---", "",
    `# Brain Lint Sweep — ${day}`, "",
    "*Read-only audit: the tiers' reads are one snapshot, and nothing is written to the brain.*", "",
    "## Scan scope", "",
  ];
  if (r.t1) L.push(`- **Tier 1** — the table's row count and its rows with no content_fingerprint or no created_at, exact; the per-row checks over the **${r.t1.sampled} newest dated thoughts** (\`created_at desc\`, then id; at most ${TIER1_SAMPLE}).`);
  if (r.t2) L.push(`- **Tier 2** — the mention check over the **${r.t2.sampled} newest dated thoughts** (at most ${TIER2_SAMPLE}); the entities with no edge, exact, over all ${r.t2.entities}.`);
  L.push("- **Tier 3** — not ported yet (SMD-3318 PR 2b: a model's reading of sampled thoughts, through the brain's provider and egress gate).", "");
  if (r.t1) {
    L.push("## Tier 1 — thoughts", "");
    L.push(`- Total thoughts (exact): **${r.t1.total}**`);
    L.push(`- No content_fingerprint (exact): **${r.t1.noFingerprint}** — a capture through the brain's functions sets it; a raw insert leaves it NULL, \`SELECT backfill_content_fingerprints();\` sets it (migration 023), and a twin of a fingerprinted thought's content keeps none.`);
    L.push(`- No created_at (exact): **${r.t1.undated}** — in no sample below.`);
    L.push(`- Orphans by tag (no topics, tags or people; newest ${r.t1.sampled}): **${r.t1.orphansByTag}** — a capture whose tagging failed, or a raw insert.`);
    L.push(`- Over-tagged (more than ${OVER_TAGGED} tags; newest ${r.t1.sampled}): **${r.t1.overTaggedCount}** — imports' tags: the brain's capture writes topics, not tags.`);
    for (const o of r.t1.overTagged) L.push(`  - ${o.id} → ${o.tags} tags`);
    if (r.t1.overTaggedCount > r.t1.overTagged.length) L.push(`  - …and ${r.t1.overTaggedCount - r.t1.overTagged.length} more`);
    L.push(`- Empty content (newest ${r.t1.sampled}): **${r.t1.emptyContent}**`);
    L.push(`- Very long content (over ${VERY_LONG.toLocaleString("en-US")} characters; newest ${r.t1.sampled}): **${r.t1.veryLong}**`, "");
  }
  if (r.t2) {
    L.push("## Tier 2 — the entity graph", "");
    L.push(`- Thoughts no entity mention names (newest ${r.t2.sampled}): **${r.t2.unmentionedCount}** — extraction found nothing in them, has not reached them yet, or is off.`);
    for (const u of r.t2.unmentioned) L.push(`  - ${u.id} (${u.created}) — ${u.preview}${u.cut ? "…" : ""}`);
    if (r.t2.unmentionedCount > r.t2.unmentioned.length) L.push(`  - …and ${r.t2.unmentionedCount - r.t2.unmentioned.length} more`);
    L.push(`- Entities with no edge either way (exact, of ${r.t2.entities}): **${r.t2.entitiesWithNoEdges}**`, "");
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
  /** "1", "2" or "all". */
  tier: "1" | "2" | "all";
  /** The report's resolved path. */
  report: string;
  /** The URL the client was opened on: the run refuses when the connection reached another database. */
  url?: string;
  writer?: Writer;
}

/** The SQLSTATE and message of a database error, else the message. */
function reasonOf(e: unknown): string {
  const err = e as { errno?: unknown; message?: unknown };
  const state = typeof err?.errno === "string" && /^[0-9A-Z]{5}$/.test(err.errno) ? `${err.errno} ` : "";
  return `${state}${String(err?.message ?? e).split("\n")[0]}`;
}

/** The sweep: the tiers asked for, from one snapshot, then the report. Exit code: 0 written, 1 not, 2 another database. */
export async function run(opts: SweepOptions): Promise<number> {
  const w = opts.writer ?? consoleWriter;
  const startedAt = new Date().toISOString();
  let t1: Tier1 | null = null, t2: Tier2 | null = null, database = "";
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
    w.out(`[lint-sweep] database ${db}, tier ${opts.tier}, report ${opts.report}`);
    await opts.sql.begin("ISOLATION LEVEL REPEATABLE READ READ ONLY", async (txn) => {
      const tx = txn as unknown as SQL;
      // The tables the tiers read, ACCESS SHARE, first and under the statement bound (a REPEATABLE READ transaction's
      // snapshot is its first query's; LOCK is none): a lock wait is bounded here, and the counts run unbounded after
      // can wait on none; a TRUNCATE or a change of shape waits for the run.
      const tables = [...(opts.tier !== "2" ? ["thoughts"] : []), ...(opts.tier !== "1" ? ["thoughts", "thought_entities", "ob1_entities", "ob1_entity_edges"] : [])];
      const toLock = [...new Set(tables)];
      try {
        await tx.unsafe(`LOCK TABLE ${toLock.join(", ")} IN ACCESS SHARE MODE`);
      } catch (e) {
        throw new Error(`locking ${toLock.join(", ")}: ${reasonOf(e)}`);
      }
      const [{ bound }] = (await tx.unsafe("SELECT pg_catalog.current_setting('statement_timeout') AS bound")) as { bound: string }[];
      if (opts.tier !== "2") {
        try {
          t1 = await tier1(tx, bound);
        } catch (e) {
          throw new Error(`tier 1: ${reasonOf(e)}`);
        }
        w.out(`[tier 1] ${t1.total} thoughts, ${t1.noFingerprint} without a fingerprint, ${t1.undated} undated; of the newest ${t1.sampled}: ${t1.orphansByTag} orphans by tag, ${t1.overTaggedCount} over-tagged, ${t1.emptyContent} empty, ${t1.veryLong} very long`);
      }
      if (opts.tier !== "1") {
        try {
          t2 = await tier2(tx, bound);
        } catch (e) {
          throw new Error(`tier 2: ${reasonOf(e)}`);
        }
        w.out(`[tier 2] of the newest ${t2.sampled}: ${t2.unmentionedCount} with no entity mention; ${t2.entitiesWithNoEdges} of ${t2.entities} entities with no edge`);
      }
    });
  } catch (e) {
    w.err(`lint-sweep FAILED — ${reasonOf(e)}. No report was written.`);
    return 1;
  }
  try {
    writeReport(opts.report, renderReport({ tier: opts.tier, database, startedAt, finishedAt: new Date().toISOString(), t1, t2 }));
  } catch (e) {
    w.err(`lint-sweep FAILED writing ${opts.report}: ${reasonOf(e)}. An earlier report there is as it was.`);
    return 1;
  }
  w.out(`[lint-sweep] report written: ${opts.report}`);
  return 0;
}

// ── CLI ───────────────────────────────────────────────────────────────────

if (import.meta.main) {
  const cli = commandLine(
    "lint-sweep.ts",
    { url: "one", tier: "one", report: "one", "statement-timeout": "one" },
    {
      hints: { url: "<postgres://…>", tier: "<1|2|all> (all)", report: "<path> (./lint-report-YYYY-MM-DD.md, the UTC date)", "statement-timeout": `<seconds> (${STATEMENT_TIMEOUT_S}; 0: none)` },
      removed: REMOVED_FLAGS,
    },
  );
  const tier = cli.value("tier") ?? "all";
  if (tier === "3") {
    console.error("--tier 3 is not ported yet: a model's reading of sampled thoughts comes in SMD-3318 PR 2b, through the brain's provider and egress gate. Tiers 1 and 2 run now.");
    process.exit(2);
  }
  if (tier !== "1" && tier !== "2" && tier !== "all") {
    console.error(`--tier must be 1, 2 or all, got ${JSON.stringify(tier.slice(0, 20))}`);
    process.exit(2);
  }
  const where = reportPath(cli.value("report") ?? `lint-report-${new Date().toISOString().slice(0, 10)}.md`);
  if ("error" in where) {
    console.error(where.error);
    process.exit(2);
  }
  const timeout = cli.int("statement-timeout", { absent: STATEMENT_TIMEOUT_S, min: 0, max: 2147483 });
  const url = databaseUrl(cli.value("url"));
  const sql = openSql(url, { max: 1, session: { statement_timeout: `${timeout}s` } });
  await closeThenExit(sql, async () => {
    return run({ sql, tier, report: where.path, url });
  });
}
