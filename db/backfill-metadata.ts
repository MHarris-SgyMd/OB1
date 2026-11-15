#!/usr/bin/env bun
/**
 * backfill-metadata.ts — two backfills of a thought's metadata, written
 * through update_thought (SMD-3318 PR 3a).
 *
 *   bun db/backfill-metadata.ts --url postgres://…           # both passes, a dry run: what would be written
 *   bun db/backfill-metadata.ts --url … --apply              # write it
 *   bun db/backfill-metadata.ts --url … --pass type --apply  # one pass
 *
 * This is the `db/` home for `recipes/thought-enrichment`'s
 * `backfill-type.mjs` and `backfill-sensitivity.mjs`, which wrote the
 * `type` and `sensitivity_tier` columns `schemas/enhanced-thoughts` adds,
 * through compat/supabase-sql (SMD-2139), which retires (SMD-3216). The core
 * has neither column: a thought's type is `metadata.type`, and the one reader
 * of a sensitivity tier, `db/weekly-digest.ts`'s egress filter, reads
 * `metadata.sensitivity_tier` beside the column. So both passes write
 * metadata keys. The recipe's third script, enrich-thoughts, is SMD-2298's
 * re-tag worker (SMD-3318 PR 3b).
 *
 * ── The passes ──────────────────────────────────────────────────────────────
 * type: a `metadata.type` the capture would have written otherwise — another
 * case or spacing of one of its types, or one of its aliases (`todo`,
 * `action item`, `fact`, `contact`…) — is written as the capture's type, by
 * the capture's own rule (server-portable/thoughts.ts's canonicalType), an
 * alias's words kept in `type_raw` as the capture keeps them. A type that
 * names none of them (an importer's `decision`, consolidation's `synthesis`)
 * is counted and left: the capture would have coerced it to `observation`,
 * which loses what it said. A row an importer owns (its trust `ingested`) is
 * left too: its type is the importer's facet, and its next sync would write
 * it back. The recipe's pass copied `metadata.type` into the column for rows
 * stamped `reference`; with no column, this is what is left of it.
 *
 * sensitivity: a thought whose `metadata.sensitivity_tier` is absent, empty
 * or `standard` is read against the recipe's patterns (below): the first
 * restricted pattern that matches makes it `restricted`, else any personal
 * one `personal`, and that tier is written. A tier is never lowered, and
 * `standard` is never written: no tier and `standard` read alike. The run
 * prints a thought's id and the patterns' labels, never its text (an API key,
 * a card number), where the recipe printed 80 characters of each.
 *
 * ── What a run guarantees ───────────────────────────────────────────────────
 * Without --apply nothing is written: the run says what would be. With it,
 * each row's keys go in one update_thought call (both passes' at once), so
 * the write is the core's: one audit event, the row locked, and a row
 * written since the page read it (update_thought's if_unchanged_since) is
 * left for the next run and counted. A row whose metadata is SQL NULL merges
 * no patch (update_thought's rule since 009): counted, not written. The
 * table is read by key, a page (--batch, 500) a statement, each statement
 * bounded by --statement-timeout (60 s; 0 for none), so a run's reads never
 * hold a snapshot or a lock for its length. --limit stops after that many
 * rows written (or, in a dry run, that would be). The database the URL names
 * is the one written: a connection that reached another (PGDATABASE) is
 * refused, exit 2. Exit 0 a run that ended, 1 one that failed (the reason
 * printed; rows already written stay written), 2 a refusal.
 *
 * Every write moves the row's `updated_at` and its actor stamp: run it
 * between re-embed passes, as the recipe's README said of its own.
 */

import type { SQL } from "bun";
import { canonicalType } from "../server-portable/thoughts.ts";
import { commandLine, consoleWriter, type Writer } from "./cli.ts";
import { closeThenExit, databaseUrl, openSql, reachedDatabaseRefusal } from "./connect.ts";

/** The rows a page reads, by default. */
const BATCH = 500;
/** How many rows of each pass the run lists. */
const LISTED = 15;
/** The per-statement bound by default, in seconds. */
const STATEMENT_TIMEOUT_S = 60;
/** Who the writes are by, on each audit event. */
const ACTOR = { name: "backfill-metadata", via: "db/backfill-metadata.ts" };

/**
 * The recipe's patterns (`recipes/thought-enrichment/sensitivity-patterns.json`,
 * copied whole): [source, flags, label]. None is global, so a test keeps no
 * state between thoughts.
 */
const PATTERNS: { readonly restricted: readonly (readonly [string, string, string])[]; readonly personal: readonly (readonly [string, string, string])[] } = {
  restricted: [
    ["\\b\\d{3}-?\\d{2}-?\\d{4}\\b", "", "ssn_pattern"],
    ["\\b[A-Z]{1,2}\\d{6,9}\\b", "", "passport_pattern"],
    ["\\b\\d{8,17}\\b[^\\n]{0,80}\\b(account|routing|iban)\\b", "i", "bank_account"],
    ["\\b(account|routing)\\b[^\\n]{0,80}\\b\\d{8,17}\\b", "i", "bank_account"],
    ["\\b(sk-|pk_live_|sk_live_|ghp_|gho_|AKIA)[A-Za-z0-9]{10,}", "i", "api_key"],
    ["\\bpassword\\s*[:=]\\s*\\S+", "i", "password_value"],
    ["\\b\\d{4}[\\s-]?\\d{4}[\\s-]?\\d{4}[\\s-]?\\d{4}\\b", "", "credit_card"],
  ],
  personal: [
    ["\\b\\d+\\s*mg\\b(?!\\s*\\/\\s*(dL|kg|L|ml))", "i", "medication_dosage"],
    ["\\b(pregabalin|metoprolol|losartan|lisinopril|aspirin|atorvastatin|sertraline|metformin|gabapentin|prednisone|insulin|warfarin)\\b", "i", "drug_name"],
    ["\\b(glucose|a1c|cholesterol|blood pressure|bp|hrv|bmi)\\b[^\\n]{0,80}\\b\\d+", "i", "health_measurement"],
    ["\\b(diagnosed|diagnosis|prediabetic|diabetic|arrhythmia|ablation)\\b", "i", "medical_condition"],
    ["\\b(salary|income|net worth|401k|ira|portfolio)\\b[^\\n]{0,80}\\b\\$?\\d", "i", "financial_detail"],
    ["\\b\\$\\d{3,}[,\\d]*\\b", "i", "financial_amount"],
  ],
};
const RESTRICTED = PATTERNS.restricted.map(([source, flags, label]) => [new RegExp(source, flags), label] as const);
const PERSONAL = PATTERNS.personal.map(([source, flags, label]) => [new RegExp(source, flags), label] as const);

/** A thought's tier by the patterns, with the labels that set it: the first restricted match alone, else every personal one. */
export function sensitivityOf(text: string): { tier: "restricted" | "personal" | "standard"; labels: string[] } {
  for (const [re, label] of RESTRICTED) if (re.test(text)) return { tier: "restricted", labels: [label] };
  const labels = PERSONAL.filter(([re]) => re.test(text)).map(([, label]) => label);
  return labels.length ? { tier: "personal", labels: [...new Set(labels)] } : { tier: "standard", labels: [] };
}

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

export interface BackfillCounts {
  scanned: number;
  /** Rows written (or, in a dry run, that would be). */
  written: number;
  type: { canonical: number; unknown: number; importers: number; listed: string[]; unknownValues: Record<string, number> };
  sensitivity: { restricted: number; personal: number; standard: number; listed: string[] };
  /** Rows not written: their metadata SQL NULL, or written since the page read them, or gone. */
  nullMetadata: number;
  moved: number;
  gone: number;
  limited: boolean;
}

type PageRow = { id: string; updated_at: Date; type: unknown; trust: string | null; content: string | null; null_meta: boolean };

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
  const c: BackfillCounts = {
    scanned: 0, written: 0, nullMetadata: 0, moved: 0, gone: 0, limited: false,
    type: { canonical: 0, unknown: 0, importers: 0, listed: [], unknownValues: {} },
    sensitivity: { restricted: 0, personal: 0, standard: 0, listed: [] },
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
    w.out(`[backfill-metadata] database ${db}, passes ${opts.passes.join(", ")}, ${opts.apply ? "writing" : "a dry run (--apply writes)"}`);
    let after = "00000000-0000-0000-0000-000000000000";
    pages: for (;;) {
      // One page by key; a row's text only when the sensitivity pass will read it.
      const rows = (await sql`
        SELECT id::text AS id, updated_at, metadata->'type' AS type, metadata->>'trust' AS trust, metadata IS NULL AS null_meta,
               CASE WHEN ${doSensitivity} AND coalesce(metadata->>'sensitivity_tier', '') IN ('', 'standard') THEN content END AS content
          FROM thoughts WHERE id > ${after}::uuid ORDER BY id LIMIT ${batch}`) as PageRow[];
      if (rows.length === 0) break;
      for (const row of rows) {
        c.scanned++;
        const patch: Record<string, string> = {};
        if (doType && row.type !== null && row.type !== undefined) {
          const named = canonicalType(row.type);
          if (named && named.type !== row.type) {
            if (row.trust === "ingested") c.type.importers++;
            else {
              patch.type = named.type;
              if (named.aliased) patch.type_raw = String(row.type).trim();
            }
          } else if (!named) {
            c.type.unknown++;
            const key = typeof row.type === "string" ? row.type.slice(0, 40) : JSON.stringify(row.type).slice(0, 40);
            c.type.unknownValues[key] = (c.type.unknownValues[key] ?? 0) + 1;
          }
        }
        let tier: ReturnType<typeof sensitivityOf> | null = null;
        if (doSensitivity && row.content !== null) {
          tier = sensitivityOf(row.content);
          if (tier.tier === "standard") c.sensitivity.standard++;
          else patch.sensitivity_tier = tier.tier;
        }
        if (Object.keys(patch).length === 0) continue;
        if (limit && c.written >= limit) {
          c.limited = true;
          break pages;
        }
        if (row.null_meta) {
          c.nullMetadata++;
          continue;
        }
        if (opts.apply) {
          const [{ r }] = (await sql`
            SELECT update_thought(${row.id}::uuid, NULL::text, ${patch}::jsonb, NULL::vector, NULL::jsonb, ${row.updated_at}::timestamptz, ${ACTOR}::jsonb) AS r`) as { r: { ok: boolean; error?: string } }[];
          if (!r.ok) {
            if (r.error === "STALE_READ") c.moved++;
            else if (r.error === "NOT_FOUND") c.gone++;
            else throw new Error(`update_thought ${row.id}: ${r.error}`);
            continue;
          }
        }
        c.written++;
        if (patch.type) {
          c.type.canonical++;
          if (c.type.listed.length < LISTED) c.type.listed.push(`  - ${row.id}: ${JSON.stringify(String(row.type).slice(0, 40))} → ${patch.type}`);
        }
        if (patch.sensitivity_tier && tier) {
          if (tier.tier === "restricted") c.sensitivity.restricted++;
          else c.sensitivity.personal++;
          if (c.sensitivity.listed.length < LISTED) c.sensitivity.listed.push(`  - ${row.id}: ${tier.tier} (${tier.labels.join(", ")})`);
        }
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

function report(w: Writer, opts: BackfillOptions, c: BackfillCounts): void {
  const would = opts.apply ? "written" : "would be written";
  if (opts.passes.includes("type")) {
    w.out(`[type] ${c.type.canonical} ${would} as the capture's type; ${c.type.unknown} naming no type, left; ${c.type.importers} an importer's, left`);
    for (const l of c.type.listed) w.out(l);
    if (c.type.canonical > c.type.listed.length) w.out(`  - …and ${c.type.canonical - c.type.listed.length} more`);
    const unknown = Object.entries(c.type.unknownValues).sort((a, b) => b[1] - a[1]).slice(0, LISTED);
    if (unknown.length) w.out(`  naming no type: ${unknown.map(([v, n]) => `${JSON.stringify(v)} ×${n}`).join(", ")}`);
  }
  if (opts.passes.includes("sensitivity")) {
    w.out(`[sensitivity] ${c.sensitivity.restricted} restricted and ${c.sensitivity.personal} personal ${would}; ${c.sensitivity.standard} read as standard, left`);
    for (const l of c.sensitivity.listed) w.out(l);
    const more = c.sensitivity.restricted + c.sensitivity.personal - c.sensitivity.listed.length;
    if (more > 0) w.out(`  - …and ${more} more`);
  }
  const notWritten = [
    c.nullMetadata ? `${c.nullMetadata} with SQL NULL metadata (update_thought merges no patch into it)` : "",
    c.moved ? `${c.moved} written since the page read them (the next run takes them)` : "",
    c.gone ? `${c.gone} deleted since` : "",
  ].filter(Boolean);
  if (notWritten.length) w.out(`[backfill-metadata] not written: ${notWritten.join("; ")}`);
  w.out(`[backfill-metadata] ${c.scanned} thoughts read, ${c.written} ${would}${c.limited ? ` — stopped at --limit ${opts.limit}` : ""}`);
}

// ── CLI ───────────────────────────────────────────────────────────────────

if (import.meta.main) {
  const cli = commandLine(
    "backfill-metadata.ts",
    { url: "one", pass: "one", apply: "none", limit: "one", batch: "one", "statement-timeout": "one" },
    {
      hints: { url: "<postgres://…>", pass: "<type|sensitivity> (both)", limit: "<rows written> (0: none)", batch: `<rows a page reads> (${BATCH})`, "statement-timeout": `<seconds> (${STATEMENT_TIMEOUT_S}; 0: none)` },
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
