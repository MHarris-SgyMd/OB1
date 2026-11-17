#!/usr/bin/env bun
/**
 * backfill-metadata.ts — two backfills of a thought's type and sensitivity
 * tier, written through update_thought, and into `schemas/enhanced-thoughts`'
 * columns where a brain has them (SMD-3318 PR 3a).
 *
 *   DATABASE_URL=postgres://… bun db/backfill-metadata.ts   # both passes, a dry run: what would be written
 *   bun db/backfill-metadata.ts --apply                     # write it (DATABASE_URL from the env or ./.env)
 *   bun db/backfill-metadata.ts --pass type --apply         # one pass
 *
 * This is the `db/` home for `recipes/thought-enrichment`'s
 * `backfill-type.mjs` and `backfill-sensitivity.mjs`, which wrote the `type`
 * and `sensitivity_tier` columns `schemas/enhanced-thoughts` adds, through
 * compat/supabase-sql (SMD-2139), which retires (SMD-3216). The core has
 * neither column: a thought's type is `metadata.type`, and its tier
 * `metadata.sensitivity_tier`, the key the import recipes set and
 * `db/weekly-digest.ts` reads. So both passes write the metadata key; where
 * the column exists they write it too, as the recipe wrote it (by the rules
 * below, which differ from the recipe's where they say so), for that schema's
 * readers (its search and stats functions, the bio worker, ops views). The
 * recipe's third script, enrich-thoughts, is SMD-2298's re-tag worker
 * (SMD-3318 PR 3b).
 *
 * ── The passes ──────────────────────────────────────────────────────────────
 * type: a `metadata.type` the capture would have written otherwise — another
 * case or spacing of one of its types, or one of its aliases (`todo`,
 * `action item`, `fact`, `contact`…) — is written as the capture's type, by
 * the capture's own rule (server-portable/thoughts.ts's canonicalType), an
 * alias's words kept in `type_raw` as the capture keeps them. A type that
 * names none of them (an importer's `decision`, consolidation's `synthesis`)
 * is counted and left: the capture would have coerced it to `observation`,
 * which loses what it said. A row an importer owns (its trust `ingested`)
 * keeps its key too: its type is the importer's facet, and its next sync would
 * write it back. Where the `type` column exists — an importer's row's
 * included, which no import writes — the recipe's rule writes it, on the type
 * as the capture names it: a row whose column says `reference` takes that type
 * when it is one of the recipe's eight and not `reference`. The recipe read
 * the type as written, so `Task`, `todo` and `contact` now set the column
 * where they were skipped.
 *
 * sensitivity: a thought's text is read against the sensitivity patterns
 * (`db/sensitivity.ts`, the recipe's, widened, and shared with weekly-digest): the first restricted
 * pattern that matches makes it `restricted`, else any personal one
 * `personal`. Each place — the metadata key, and the column where it exists —
 * takes the highest of that tier and the other place's when it is higher than
 * what the place says (absent, empty and `standard`, in any case, are lowest;
 * then `personal`, then `restricted`), so neither reads lower than the other; a
 * tier is never lowered, `standard` never written, and a place holding
 * something else (a number, `secret`) is left. (The recipe read only a column
 * of exactly `standard`, empty or NULL, and never raised `personal`.) A thought
 * whose places both say `restricted` is not read. The run prints a thought's id
 * and where its tier came from (the patterns' labels, or the other place),
 * never its text (an API key, a card number), where the recipe printed the
 * first 80 characters of every restricted thought and of the first 30 it
 * scanned. An unknown type is named in the report unless the patterns rate it
 * (a key stored as a type), when it is withheld and only its label shown.
 *
 * ── What a run guarantees ───────────────────────────────────────────────────
 * Without --apply nothing is written: the run says what would be. With it, a
 * row's writes are one transaction: its metadata keys (both passes' at once)
 * in one update_thought call — one audit event, the row locked — then its
 * columns. A row written since its page read it (update_thought's
 * if_unchanged_since, on COALESCE(updated_at, created_at) as the function
 * compares it) is left for the next run and counted. Metadata that is not a
 * JSON object (SQL NULL, a JSON null, an array, a string from an old
 * double-encoding) merges no patch: its keys are counted, not written (its
 * columns are). The table is read by key, a page (--batch, 500) a statement,
 * each statement bounded by --statement-timeout (60 s; 0 for none), so a run's
 * reads never hold a snapshot or a lock for its length; a page holds its rows'
 * whole text, so a brain of long documents takes a smaller --batch (500 rows
 * of 1 MB is about a gigabyte). --limit stops after
 * that many rows written (or, in a dry run, that would be). The database the
 * URL names is the one written: a connection that reached another (PGDATABASE)
 * is refused, exit 2. Exit 0 a run that ended, 1 one that failed (the reason
 * printed; rows already written stay written), 2 a refusal.
 *
 * A write moves the row's `updated_at`; its actor stamp (who wrote the
 * thought, its trust) stays, as on any edit that keeps the text. A key's write
 * appends an audit event naming `backfill-metadata`; a column's alone appends
 * none (the audit records the core's columns, not a community schema's), as
 * the recipe's raw column writes did not. Run it between re-embed passes, as
 * the recipe's README said of its own. A role needs what `bun db/migrate.ts
 * --grant <role>` gives (update_thought reads `ob1_agents` and `ob1_config`).
 */

import type { SQL } from "bun";
import { canonicalType } from "../server-portable/thoughts.ts";
import { commandLine, consoleWriter, type Writer } from "./cli.ts";
import { closeThenExit, databaseUrl, openSql, reachedDatabaseRefusal } from "./connect.ts";
import { RANK, sensitivityOf, sqlTier, TIER_OF_RANK, tierRank } from "./sensitivity.ts";

/** The rows a page reads, by default. */
const BATCH = 500;
/** How many rows of each pass the run lists. */
const LISTED = 15;
/** The per-statement bound by default, in seconds. */
const STATEMENT_TIMEOUT_S = 60;
/** Who the writes are by, on each audit event. */
const ACTOR = { name: "backfill-metadata", via: "db/backfill-metadata.ts" };
/** The recipe's types for the `type` column (backfill-type.mjs's VALID_TYPES). */
const COLUMN_TYPES: ReadonlySet<string> = new Set(["idea", "task", "person_note", "reference", "decision", "lesson", "meeting", "journal"]);

export type Pass = "type" | "sensitivity";

export interface BackfillOptions {
  sql: SQL;
  passes: readonly Pass[];
  apply: boolean;
  /** Stop after this many rows written (or that would be); 0 for none. */
  limit?: number;
  batch?: number;
  /** The URL the client was opened on: the run refuses when the connection reached another database. */
  url?: string;
  writer?: Writer;
}

interface Counts {
  scanned: number;
  /** Rows written (or, in a dry run, that would be). */
  written: number;
  type: { canonical: number; column: number; unknown: number; importers: number; listed: string[]; unknownValues: Map<string, number> };
  sensitivity: { restricted: number; personal: number; standard: number; keys: number; columns: number; listed: string[] };
  /** The enhanced-thoughts columns the run writes. */
  typeCol: boolean;
  tierCol: boolean;
  /** Keys not written: the row's metadata not a JSON object. */
  notObject: number;
  /** Pages read that held rows. */
  pages: number;
  moved: number;
  gone: number;
  limited: boolean;
}

type PageRow = { id: string; stamp: Date; kind: string | null; type: unknown; trust: string | null; meta_tier: unknown; col_type?: string | null; col_tier?: string | null; content: string | null };

/** The SQLSTATE and message of a database error, else the client's code and message, else the message. */
function reasonOf(e: unknown): string {
  const err = e as { errno?: unknown; code?: unknown; message?: unknown };
  const state = typeof err?.errno === "string" && /^[0-9A-Z]{5}$/.test(err.errno) ? `${err.errno} `
    : typeof err?.code === "string" && /^ERR_[A-Z_]+$/.test(err.code) ? `${err.code} ` : "";
  return `${state}${String(err?.message ?? e).split("\n")[0]}`;
}

/** The backfill. Exit code: 0 ended, 1 failed, 2 another database. */
export async function run(opts: BackfillOptions): Promise<number> {
  const w = opts.writer ?? consoleWriter;
  const sql = opts.sql;
  const doType = opts.passes.includes("type"), doSensitivity = opts.passes.includes("sensitivity");
  const batch = opts.batch ?? BATCH, limit = opts.limit ?? 0;
  const c: Counts = {
    scanned: 0, written: 0, notObject: 0, pages: 0, moved: 0, gone: 0, limited: false,
    type: { canonical: 0, column: 0, unknown: 0, importers: 0, listed: [], unknownValues: new Map() },
    sensitivity: { restricted: 0, personal: 0, standard: 0, keys: 0, columns: 0, listed: [] },
    typeCol: false, tierCol: false,
  };
  try {
    const [{ db }] = (await sql.unsafe("SELECT pg_catalog.current_database() AS db")) as { db: string }[];
    if (opts.url !== undefined) {
      const refusal = await reachedDatabaseRefusal(sql, opts.url);
      if (refusal !== null) {
        w.err(`backfill-metadata refused — ${refusal}.`);
        return 2;
      }
    }
    // schemas/enhanced-thoughts' columns, where the brain has them: the passes write them too. From the catalog, not
    // information_schema, which hides a column the role may not read: such a column fails the run (42501), where it was
    // skipped unsaid.
    const cols = new Set(((await sql`SELECT attname AS c FROM pg_catalog.pg_attribute
      WHERE attrelid = 'public.thoughts'::regclass AND attname IN ('type', 'sensitivity_tier') AND NOT attisdropped`) as { c: string }[]).map((r) => r.c));
    const typeCol = doType && cols.has("type"), tierCol = doSensitivity && cols.has("sensitivity_tier");
    c.typeCol = typeCol;
    c.tierCol = tierCol;
    w.out(`[backfill-metadata] database ${db}, passes ${opts.passes.join(", ")}, ${opts.apply ? "writing" : "a dry run (--apply writes)"}${typeCol || tierCol ? `; the ${[typeCol ? "type" : "", tierCol ? "sensitivity_tier" : ""].filter(Boolean).join(" and ")} column${typeCol && tierCol ? "s" : ""} too` : ""}`);
    // The page's columns, fixed strings named by the probe above; a row's text only when the sensitivity pass may write a
    // place (not when every place it has already says restricted).
    const restrictedEverywhere = `${sqlTier("t.metadata->>'sensitivity_tier'")} = 'restricted'${tierCol ? ` AND ${sqlTier("t.sensitivity_tier")} = 'restricted'` : ""}`;
    const select = [
      "t.id::text AS id", "COALESCE(t.updated_at, t.created_at) AS stamp", "jsonb_typeof(t.metadata) AS kind",
      "t.metadata->'type' AS type", "t.metadata->>'trust' AS trust", "t.metadata->'sensitivity_tier' AS meta_tier",
      ...(typeCol ? ["t.type AS col_type"] : []), ...(tierCol ? ["t.sensitivity_tier AS col_tier"] : []),
      `CASE WHEN ${doSensitivity} AND NOT coalesce(${restrictedEverywhere}, false) THEN t.content END AS content`,
    ].join(", ");
    let after: string | null = null;
    pages: for (;;) {
      // By the key itself (t.id), so the primary key's index serves the order and the page stops at its rows. The first
      // page has no cursor: a thought at the nil uuid is read too.
      const rows = (after === null
        ? await sql.unsafe(`SELECT ${select} FROM thoughts t ORDER BY t.id LIMIT $1`, [batch])
        : await sql.unsafe(`SELECT ${select} FROM thoughts t WHERE t.id > $1::uuid ORDER BY t.id LIMIT $2`, [after, batch])) as PageRow[];
      if (rows.length === 0) break;
      c.pages++;
      for (const row of rows) {
        const patch: Record<string, string> = {};
        const colPatch: { type?: string; sensitivity_tier?: string } = {};
        const isObject = row.kind === "object";
        let typeNamed: string | null = null;
        if (doType && row.type !== null && row.type !== undefined) {
          const named = canonicalType(row.type);
          typeNamed = named?.type ?? null;
          if (named && named.type !== row.type) {
            if (row.trust === "ingested") c.type.importers++;
            else {
              patch.type = named.type;
              if (named.aliased) patch.type_raw = String(row.type).trim();
            }
          } else if (!named) {
            c.type.unknown++;
            // Named in the report, unless the patterns rate it (a key stored as a type): then only what it looks like.
            const named40 = typeof row.type === "string" ? row.type.slice(0, 40) : JSON.stringify(row.type).slice(0, 40);
            const looks = sensitivityOf(typeof row.type === "string" ? row.type : JSON.stringify(row.type));
            const key = looks.tier === "standard" ? named40 : `<withheld: ${looks.labels[0]}>`;
            c.type.unknownValues.set(key, (c.type.unknownValues.get(key) ?? 0) + 1);
          }
          // The column: the recipe's rule, on the type as the capture names it (or as written, when it names none).
          const columnType = typeNamed ?? (typeof row.type === "string" ? row.type : null);
          if (typeCol && row.col_type === "reference" && columnType !== null && columnType !== "reference" && COLUMN_TYPES.has(columnType)) colPatch.type = columnType;
        }
        let tier: ReturnType<typeof sensitivityOf> | null = null;
        let target = 0, source = "";
        if (doSensitivity && row.content !== null) {
          tier = sensitivityOf(row.content);
          // Each place takes the highest of the patterns' tier and the other place's, so neither reads lower than the
          // other; a place holding a tier this does not rank is left.
          const metaRank = tierRank(row.meta_tier);
          const colRank = tierCol ? tierRank(row.col_tier) : null;
          target = Math.max(RANK[tier.tier], metaRank ?? 0, colRank ?? 0);
          source = RANK[tier.tier] === target ? tier.labels.join(", ") : metaRank === target ? "the key's tier" : "the column's tier";
          if (metaRank !== null && target > metaRank) patch.sensitivity_tier = TIER_OF_RANK[target];
          if (colRank !== null && target > colRank) colPatch.sensitivity_tier = TIER_OF_RANK[target];
        }
        // Metadata that is not an object merges no patch (update_thought's `||`): its keys are counted and dropped.
        if (!isObject && Object.keys(patch).length) {
          c.notObject++;
          for (const k of Object.keys(patch)) delete patch[k];
        }
        if (Object.keys(patch).length === 0 && Object.keys(colPatch).length === 0) {
          c.scanned++;
          if (tier?.tier === "standard") c.sensitivity.standard++;
          continue;
        }
        if (limit && c.written >= limit) {
          c.limited = true;
          break pages;
        }
        c.scanned++;
        if (opts.apply) {
          const outcome = await writeRow(sql, row, patch, colPatch);
          if (outcome !== "written") {
            if (outcome === "moved") c.moved++;
            else c.gone++;
            continue;
          }
        }
        c.written++;
        if (patch.type) {
          c.type.canonical++;
          if (c.type.listed.length < LISTED) c.type.listed.push(`  - ${row.id}: ${JSON.stringify(String(row.type).slice(0, 40))} → ${patch.type}`);
        }
        if (colPatch.type) c.type.column++;
        if (patch.sensitivity_tier || colPatch.sensitivity_tier) {
          if (TIER_OF_RANK[target] === "restricted") c.sensitivity.restricted++;
          else c.sensitivity.personal++;
          if (patch.sensitivity_tier) c.sensitivity.keys++;
          if (colPatch.sensitivity_tier) c.sensitivity.columns++;
          if (c.sensitivity.listed.length < LISTED) c.sensitivity.listed.push(`  - ${row.id}: ${TIER_OF_RANK[target]} (${source})`);
        } else if (tier?.tier === "standard") c.sensitivity.standard++;
      }
      after = rows[rows.length - 1].id;
      if (rows.length < batch) break;
    }
  } catch (e) {
    w.err(`backfill-metadata FAILED — ${reasonOf(e)}. ${opts.apply ? `${c.written} rows were written before it; they stay.` : "Nothing was written (a dry run)."}`);
    return 1;
  }
  report(w, opts, c);
  return 0;
}

/**
 * One row's writes, in one transaction: the metadata keys through update_thought (its guard on the stamp the page
 * read), then the columns — under that call's row lock, or, with no keys to write, under the same guard of their own.
 */
async function writeRow(sql: SQL, row: PageRow, patch: Record<string, string>, colPatch: { type?: string; sensitivity_tier?: string }): Promise<"written" | "moved" | "gone"> {
  return await sql.begin(async (txn) => {
    const tx = txn as unknown as SQL;
    if (Object.keys(patch).length) {
      const [{ r }] = (await tx`
        SELECT update_thought(${row.id}::uuid, NULL::text, ${patch}::jsonb, NULL::vector, NULL::jsonb, ${row.stamp}::timestamptz, ${ACTOR}::jsonb) AS r`) as { r: { ok: boolean; error?: string } }[];
      if (!r.ok) {
        if (r.error === "STALE_READ") return "moved";
        if (r.error === "NOT_FOUND") return "gone";
        throw new Error(`update_thought ${row.id}: ${r.error}`);
      }
    }
    const names = (["type", "sensitivity_tier"] as const).filter((k) => colPatch[k] !== undefined);
    if (names.length) {
      const set = names.map((k, i) => `${k} = $${i + 2}`).join(", ");
      // With no keys written, the columns take the guard update_thought would have: the stamp the page read.
      const guarded = Object.keys(patch).length === 0;
      const guard = guarded ? ` AND date_trunc('milliseconds', COALESCE(updated_at, created_at)) <= date_trunc('milliseconds', $${names.length + 2}::timestamptz)` : "";
      const params: unknown[] = [row.id, ...names.map((k) => colPatch[k]), ...(guarded ? [row.stamp] : [])];
      const done = (await tx.unsafe(`UPDATE thoughts SET ${set} WHERE id = $1::uuid${guard} RETURNING id`, params)) as unknown[];
      if (done.length === 0) {
        const [{ n }] = (await tx`SELECT count(*)::int AS n FROM thoughts WHERE id = ${row.id}::uuid`) as { n: number }[];
        return n === 0 ? "gone" : "moved";
      }
    }
    return "written";
  });
}

function report(w: Writer, opts: BackfillOptions, c: Counts): void {
  const would = opts.apply ? "written" : "would be written";
  if (opts.passes.includes("type")) {
    w.out(`[type] ${c.type.canonical} ${would} as the capture's type${c.typeCol ? ` (and ${c.type.column} type column${c.type.column === 1 ? "" : "s"} from a type the recipe names)` : ""}; ${c.type.unknown} naming no type, left; ${c.type.importers} an importer's key, left`);
    for (const l of c.type.listed) w.out(l);
    if (c.type.canonical > c.type.listed.length) w.out(`  - …and ${c.type.canonical - c.type.listed.length} more`);
    const unknown = [...c.type.unknownValues].sort((a, b) => b[1] - a[1]).slice(0, LISTED);
    if (unknown.length) w.out(`  naming no type: ${unknown.map(([v, n]) => `${JSON.stringify(v)} ×${n}`).join(", ")}`);
  }
  if (opts.passes.includes("sensitivity")) {
    const k = c.sensitivity.keys, col = c.sensitivity.columns;
    w.out(`[sensitivity] ${c.sensitivity.restricted} restricted and ${c.sensitivity.personal} personal ${would} (${k} key${k === 1 ? "" : "s"}${c.tierCol ? `, ${col} column${col === 1 ? "" : "s"}` : ""}); ${c.sensitivity.standard} read as standard, left`);
    for (const l of c.sensitivity.listed) w.out(l);
    const more = c.sensitivity.restricted + c.sensitivity.personal - c.sensitivity.listed.length;
    if (more > 0) w.out(`  - …and ${more} more`);
  }
  const notWritten = [
    c.notObject ? `${c.notObject} whose metadata is not a JSON object (SQL NULL, null, an array or a string), keys dropped` : "",
    c.moved ? `${c.moved} written since the page read them (the next run takes them)` : "",
    c.gone ? `${c.gone} deleted since` : "",
  ].filter(Boolean);
  if (notWritten.length) w.out(`[backfill-metadata] not written: ${notWritten.join("; ")}`);
  w.out(`[backfill-metadata] ${c.scanned} thoughts read, ${c.written} ${would}${c.limited ? ` — stopped at --limit ${opts.limit}` : ""}; ${c.pages} page${c.pages === 1 ? "" : "s"} of ${opts.batch ?? BATCH}`);
}

// ── CLI ───────────────────────────────────────────────────────────────────

if (import.meta.main) {
  const cli = commandLine(
    "backfill-metadata.ts",
    { url: "one", pass: "one", apply: "none", limit: "one", batch: "one", "statement-timeout": "one" },
    {
      hints: { url: "<postgres://…> (DATABASE_URL, from the env or ./.env; --url shows the password to ps)", pass: "<type|sensitivity> (both)", limit: "<rows written> (0: none)", batch: `<rows a page reads> (${BATCH})`, "statement-timeout": `<seconds> (${STATEMENT_TIMEOUT_S}; 0: none)` },
      removed: {
        "dry-run": "--dry-run is removed: a run without --apply is the dry run",
        "batch-size": "--batch-size is removed: --batch names a page's rows",
      },
    },
  );
  const pass = cli.value("pass");
  if (pass !== undefined && pass !== "type" && pass !== "sensitivity") {
    console.error(`--pass must be type or sensitivity, got ${JSON.stringify(pass.slice(0, 20))}`);
    process.exit(2);
  }
  const limit = cli.int("limit", { absent: 0, min: 0 });
  const batch = cli.int("batch", { absent: BATCH, min: 1, max: 10_000 });
  const timeout = cli.int("statement-timeout", { absent: STATEMENT_TIMEOUT_S, min: 0, max: 2147483 });
  const url = databaseUrl(cli.value("url"));
  const sql = openSql(url, { max: 1, session: { statement_timeout: `${timeout}s`, application_name: "backfill-metadata" } });
  await closeThenExit(sql, async () => {
    return run({ sql, passes: pass ? [pass] : ["type", "sensitivity"], apply: cli.has("apply"), limit, batch, url });
  });
}
