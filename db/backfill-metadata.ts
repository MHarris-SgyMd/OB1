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
 * the column exists they write it too, as the recipe did, for that schema's
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
 * which loses what it said. A row an importer owns (its trust `ingested`) is
 * left too: its type is the importer's facet, and its next sync would write
 * it back. Where the `type` column exists, the recipe's rule writes it: a row
 * whose column says `reference` takes its metadata type (as the capture
 * names it) when that is one of the recipe's eight and not `reference`.
 *
 * sensitivity: a thought's text is read against the recipe's patterns (below):
 * the first restricted pattern that matches makes it `restricted`, else any
 * personal one `personal`. Each place — the metadata key, and the column where
 * it exists — takes that tier when it is higher than what the place says
 * (absent, empty and `standard`, in any case, are lowest; then `personal`,
 * then `restricted`); a tier is never lowered, `standard` never written, and a
 * place holding something else (a number, `secret`) is left. A thought whose
 * places both say `restricted` is not read. The run prints a thought's id and
 * the patterns' labels, never its text (an API key, a card number), where the
 * recipe printed 80 characters of each.
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
 * reads never hold a snapshot or a lock for its length. --limit stops after
 * that many rows written (or, in a dry run, that would be). The database the
 * URL names is the one written: a connection that reached another (PGDATABASE)
 * is refused, exit 2. Exit 0 a run that ended, 1 one that failed (the reason
 * printed; rows already written stay written), 2 a refusal.
 *
 * A write moves the row's `updated_at`; its actor stamp (who wrote the
 * thought, its trust) stays, as on any edit that keeps the text, and the
 * audit event names `backfill-metadata`. Run it between re-embed passes, as
 * the recipe's README said of its own. A role needs what `bun db/migrate.ts
 * --grant <role>` gives (update_thought reads `ob1_agents` and `ob1_config`).
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
/** The recipe's types for the `type` column (backfill-type.mjs's VALID_TYPES). */
const COLUMN_TYPES: ReadonlySet<string> = new Set(["idea", "task", "person_note", "reference", "decision", "lesson", "meeting", "journal"]);

/**
 * The recipe's patterns (`recipes/thought-enrichment/sensitivity-patterns.json`,
 * copied whole): [source, flags, label]. None is global, so a test keeps no
 * state between thoughts.
 */
export const PATTERNS: { readonly restricted: readonly (readonly [string, string, string])[]; readonly personal: readonly (readonly [string, string, string])[] } = {
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

/** A tier's rank: 0 absent, empty or standard (any case), 1 personal, 2 restricted; null for anything else, which is left. */
export function tierRank(v: unknown): number | null {
  if (v === null || v === undefined) return 0;
  if (typeof v !== "string") return null;
  const t = v.trim().toLowerCase();
  return t === "" || t === "standard" ? 0 : t === "personal" ? 1 : t === "restricted" ? 2 : null;
}
const RANK = { standard: 0, personal: 1, restricted: 2 } as const;

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
  sensitivity: { restricted: number; personal: number; standard: number; column: number; listed: string[] };
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
    sensitivity: { restricted: 0, personal: 0, standard: 0, column: 0, listed: [] },
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
    // schemas/enhanced-thoughts' columns, where the brain has them: the passes write them too.
    const cols = new Set(((await sql`SELECT column_name AS c FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'thoughts' AND column_name IN ('type', 'sensitivity_tier')`) as { c: string }[]).map((r) => r.c));
    const typeCol = doType && cols.has("type"), tierCol = doSensitivity && cols.has("sensitivity_tier");
    w.out(`[backfill-metadata] database ${db}, passes ${opts.passes.join(", ")}, ${opts.apply ? "writing" : "a dry run (--apply writes)"}${typeCol || tierCol ? `; the ${[typeCol ? "type" : "", tierCol ? "sensitivity_tier" : ""].filter(Boolean).join(" and ")} column${typeCol && tierCol ? "s" : ""} too` : ""}`);
    // The page's columns, fixed strings named by the probe above; a row's text only when the sensitivity pass may write a
    // place (not when every place it has already says restricted).
    const restrictedEverywhere = `lower(btrim(t.metadata->>'sensitivity_tier')) = 'restricted'${tierCol ? " AND lower(btrim(t.sensitivity_tier)) = 'restricted'" : ""}`;
    const select = [
      "t.id::text AS id", "COALESCE(t.updated_at, t.created_at) AS stamp", "jsonb_typeof(t.metadata) AS kind",
      "t.metadata->'type' AS type", "t.metadata->>'trust' AS trust", "t.metadata->'sensitivity_tier' AS meta_tier",
      ...(typeCol ? ["t.type AS col_type"] : []), ...(tierCol ? ["t.sensitivity_tier AS col_tier"] : []),
      `CASE WHEN ${doSensitivity} AND NOT coalesce(${restrictedEverywhere}, false) THEN t.content END AS content`,
    ].join(", ");
    let after = "00000000-0000-0000-0000-000000000000";
    pages: for (;;) {
      // By the key itself (t.id), so the primary key's index serves the order and the page stops at its rows.
      const rows = (await sql.unsafe(`SELECT ${select} FROM thoughts t WHERE t.id > $1::uuid ORDER BY t.id LIMIT $2`, [after, batch])) as PageRow[];
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
            const key = typeof row.type === "string" ? row.type.slice(0, 40) : JSON.stringify(row.type).slice(0, 40);
            c.type.unknownValues.set(key, (c.type.unknownValues.get(key) ?? 0) + 1);
          }
          // The column: the recipe's rule, on the type as the capture names it (or as written, when it names none).
          const columnType = typeNamed ?? (typeof row.type === "string" ? row.type : null);
          if (typeCol && row.col_type === "reference" && columnType !== null && columnType !== "reference" && COLUMN_TYPES.has(columnType)) colPatch.type = columnType;
        }
        let tier: ReturnType<typeof sensitivityOf> | null = null;
        if (doSensitivity && row.content !== null) {
          tier = sensitivityOf(row.content);
          if (tier.tier === "standard") c.sensitivity.standard++;
          else {
            const metaRank = tierRank(row.meta_tier);
            if (metaRank !== null && RANK[tier.tier] > metaRank) patch.sensitivity_tier = tier.tier;
            const colRank = tierCol ? tierRank(row.col_tier) : null;
            if (colRank !== null && RANK[tier.tier] > colRank) colPatch.sensitivity_tier = tier.tier;
          }
        }
        // Metadata that is not an object merges no patch (update_thought's `||`): its keys are counted and dropped.
        if (!isObject && Object.keys(patch).length) {
          c.notObject++;
          for (const k of Object.keys(patch)) delete patch[k];
        }
        if (Object.keys(patch).length === 0 && Object.keys(colPatch).length === 0) {
          c.scanned++;
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
        if (tier && (patch.sensitivity_tier || colPatch.sensitivity_tier)) {
          if (tier.tier === "restricted") c.sensitivity.restricted++;
          else c.sensitivity.personal++;
          if (colPatch.sensitivity_tier) c.sensitivity.column++;
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
    w.out(`[type] ${c.type.canonical} ${would} as the capture's type${c.type.column ? ` (and ${c.type.column} type column${c.type.column === 1 ? "" : "s"} from a type the recipe names)` : ""}; ${c.type.unknown} naming no type, left; ${c.type.importers} an importer's, left`);
    for (const l of c.type.listed) w.out(l);
    if (c.type.canonical > c.type.listed.length) w.out(`  - …and ${c.type.canonical - c.type.listed.length} more`);
    const unknown = [...c.type.unknownValues].sort((a, b) => b[1] - a[1]).slice(0, LISTED);
    if (unknown.length) w.out(`  naming no type: ${unknown.map(([v, n]) => `${JSON.stringify(v)} ×${n}`).join(", ")}`);
  }
  if (opts.passes.includes("sensitivity")) {
    w.out(`[sensitivity] ${c.sensitivity.restricted} restricted and ${c.sensitivity.personal} personal ${would}${c.sensitivity.column ? ` (${c.sensitivity.column} into the sensitivity_tier column)` : ""}; ${c.sensitivity.standard} read as standard, left`);
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
