#!/usr/bin/env bun
// ob1-fork (SMD-2144): this script read PostgREST's `/<table>` route with a
// service-role key, and this fork's stack runs no PostgREST. It reads the same
// tables through compat/supabase-sql now — SUPABASE_URL is a postgres:// connection
// string, SUPABASE_SERVICE_ROLE_KEY is accepted and ignored (the credentials live
// in the URL). Two reads changed with the transport: the "most recent" samples
// order by created_at, since ids are uuids here and `id desc` orders nothing, and
// Tier 2 reads `edges` by the columns schemas/entity-extraction gives it
// (from_entity_id, to_entity_id). Run it from a checkout: the import is relative.
/**
 * lint-sweep.js — Bounded weekly brain-quality audit for Open Brain.
 *
 * ESM module; see the sibling package.json for `"type": "module"`. We use a
 * `.js` extension (rather than `.mjs`) to match the OB1 Rule 6 artifact
 * whitelist in `.github/workflows/ob1-gate.yml`, which only admits
 * `.sql|.ts|.js|.py`.
 *
 * Inspired by Karpathy's "lint" concept and the CRATE CLI. Scans the
 * `public.thoughts` table for quality issues across three cost tiers:
 *
 *   Tier 1 (SQL-only, free): orphan thoughts, exact/near duplicates,
 *     low-signal noise, over-tagged soup, content-length outliers.
 *
 *   Tier 2 (graph-based, free): entity-less atomic thoughts, isolated
 *     clusters in the `edges` table, high-importance with no graph links.
 *
 *   Tier 3 (LLM-assisted, budgeted): contradiction sampling via OpenRouter
 *     over a small sample of thoughts. Capped by --max-llm-calls.
 *
 * Produces a markdown report at --report=<path> (default
 *   ./lint-report-YYYY-MM-DD.md). NEVER mutates the database. Human review
 *   gates any destructive action — this script only reports.
 *
 * Usage:
 *   bun lint-sweep.js                              # all three tiers, default caps
 *   bun lint-sweep.js --tier=1                     # SQL-only sweep
 *   bun lint-sweep.js --tier=2                     # graph-based sweep
 *   bun lint-sweep.js --tier=3 --max-llm-calls=10  # LLM contradiction sampling
 *   bun lint-sweep.js --tier=all --sample-size=200
 *   bun lint-sweep.js --report=./out/weekly.md
 *
 * Environment (loaded from .env or .env.local in the script directory or
 * from process.env):
 *   SUPABASE_URL               — the brain's postgres:// connection string
 *   SUPABASE_SERVICE_ROLE_KEY  — accepted and ignored (the credentials live in the URL)
 *   OPENROUTER_API_KEY         — OpenRouter key (Tier 3 only; omit to skip)
 *
 * Legacy alias (deprecated, accepted with a warning):
 *   OPEN_BRAIN_URL         → use SUPABASE_URL
 * (OPEN_BRAIN_SERVICE_KEY is read and ignored, as SUPABASE_SERVICE_ROLE_KEY is.)
 *
 * Exit codes:
 *   0 — report generated successfully
 *   1 — fatal error (missing env, a refused query, unparseable response)
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "../../compat/supabase-sql/index.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── env loading ─────────────────────────────────────────────────────────────

function loadEnvFile(envPath) {
  if (!fs.existsSync(envPath)) return {};
  const env = {};
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    env[key] = val;
  }
  return env;
}

const fileEnv = {
  ...loadEnvFile(path.join(__dirname, ".env")),
  ...loadEnvFile(path.join(__dirname, ".env.local")),
};

function envVar(name) {
  return process.env[name] || fileEnv[name] || "";
}

// Resolve a variable that supports a legacy alias. Prefer `primary`; fall back
// to `legacy`. If the legacy name is what actually resolved the value, log a
// one-line deprecation warning (once per key) so consumers migrate to the
// canonical SUPABASE_* names shared by every other OB1 recipe.
const _deprecationWarned = new Set();
function envVarWithLegacy(primary, legacy) {
  const fromPrimary = envVar(primary);
  if (fromPrimary) return fromPrimary;
  const fromLegacy = envVar(legacy);
  if (fromLegacy && !_deprecationWarned.has(legacy)) {
    console.warn(
      `[lint-sweep] WARNING: ${legacy} is deprecated; prefer ${primary} ` +
        `(matches every other OB1 recipe and shared .env.local setups).`
    );
    _deprecationWarned.add(legacy);
  }
  return fromLegacy;
}

// ── args ────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {
    tier: "all",              // 1 | 2 | 3 | all
    sampleSize: 100,          // Tier 3 sample size
    maxLlmCalls: 5,           // Tier 3 hard cap (each call audits ~20 thoughts)
    report: null,             // output file path (computed below if null)
    days: 365,                // Tier 3 recency window in days
    llmModel: "anthropic/claude-haiku-4-5",
    verbose: false,
  };

  // Parse a numeric flag value WITHOUT rewriting valid zero/negative values.
  // Plain `Number(x) || default` fails for 0 — e.g. `--max-llm-calls=0` (the
  // documented hard-off switch for Tier 3) would be silently rewritten to the
  // default, still making paid LLM calls. This helper only applies the default
  // when the parsed value is genuinely missing or non-numeric.
  function parseNumberFlag(raw, defaultValue) {
    if (raw === undefined || raw === null || raw === "") return defaultValue;
    const n = Number(raw);
    return Number.isFinite(n) ? n : defaultValue;
  }

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--tier=")) args.tier = a.slice(7);
    else if (a === "--tier") args.tier = argv[++i];
    else if (a.startsWith("--sample-size=")) args.sampleSize = parseNumberFlag(a.slice(14), 100);
    else if (a === "--sample-size") args.sampleSize = parseNumberFlag(argv[++i], 100);
    else if (a.startsWith("--max-llm-calls=")) args.maxLlmCalls = parseNumberFlag(a.slice(16), 5);
    else if (a === "--max-llm-calls") args.maxLlmCalls = parseNumberFlag(argv[++i], 5);
    else if (a.startsWith("--report=")) args.report = expandHome(a.slice(9));
    else if (a === "--report") args.report = expandHome(argv[++i]);
    else if (a.startsWith("--days=")) args.days = parseNumberFlag(a.slice(7), 365);
    else if (a === "--days") args.days = parseNumberFlag(argv[++i], 365);
    else if (a.startsWith("--llm-model=")) args.llmModel = a.slice(12);
    else if (a === "--llm-model") args.llmModel = argv[++i];
    else if (a === "--verbose" || a === "-v") args.verbose = true;
    else if (a === "--help" || a === "-h") args.help = true;
  }
  if (args.help) return args;
  if (!["1", "2", "3", "all"].includes(String(args.tier))) {
    throw new Error(`Invalid --tier=${args.tier}. Use 1, 2, 3, or all.`);
  }
  if (args.sampleSize < 1 || args.sampleSize > 1000) {
    throw new Error(`--sample-size must be between 1 and 1000 (got ${args.sampleSize}).`);
  }
  if (args.maxLlmCalls < 0 || args.maxLlmCalls > 100) {
    throw new Error(`--max-llm-calls must be between 0 and 100 (got ${args.maxLlmCalls}).`);
  }
  if (!args.report) {
    const date = new Date().toISOString().slice(0, 10);
    args.report = path.join(process.cwd(), `lint-report-${date}.md`);
  }
  // Expand `~/` and refuse relative paths that climb out of cwd. Absolute
  // paths (including `~/lint-reports/...`, `/tmp/...`, `C:/tmp/...`) are
  // accepted so scheduled jobs can write outside the repo. The default above
  // is already absolute and under cwd, so only user-supplied values are
  // rewritten here.
  args.report = resolveReportPath(args.report);
  return args;
}

const HELP = `
lint-sweep.js — bounded brain-quality audit for Open Brain

Usage: bun lint-sweep.js [options]

Options:
  --tier=<1|2|3|all>      Which tier(s) to run (default: all)
  --sample-size=<N>       Tier 3 sample size in thoughts (default: 100)
  --max-llm-calls=<N>     Tier 3 hard cap on LLM calls (default: 5)
  --report=<path>         Markdown report output path
                          (default: ./lint-report-YYYY-MM-DD.md)
  --days=<N>              Tier 3 recency window in days (default: 365)
  --llm-model=<id>        OpenRouter model id
                          (default: anthropic/claude-haiku-4-5)
  --verbose, -v           Extra progress output
  --help, -h              Show this help

Env (from .env, .env.local, or process.env):
  SUPABASE_URL               The brain's postgres:// connection string
  SUPABASE_SERVICE_ROLE_KEY  Accepted and ignored (the credentials live in the URL)
  OPENROUTER_API_KEY         OpenRouter key (Tier 3 only)

Legacy alias (deprecated, accepted with warning):
  OPEN_BRAIN_URL         → SUPABASE_URL
`.trim();

// ── the brain's client (compat/supabase-sql) ────────────────────────────────

function makeClient(url, serviceKey) {
  // A https://….supabase.co URL is refused here, before any query, with the
  // shim's own explanation.
  const client = createClient(url, serviceKey || undefined);

  /**
   * The error a refused query becomes: the message names the read and Postgres's
   * code, and the code rides along for the two reads that tolerate one (an
   * undefined table or column) and refuse every other.
   */
  const failure = (what, error) => Object.assign(new Error(`${what} → ${error.code ? `${error.code} ` : ""}${error.message}`), { code: error.code });

  /** The rows a query answers. A database error is fatal, as an HTTP error was. */
  async function rows(query, what) {
    const { data, error } = await query;
    if (error) throw failure(what, error);
    return Array.isArray(data) ? data : [];
  }

  /**
   * The exact row count of `table` under `where` (a function over the query,
   * or none): a counted head query — no rows are pulled.
   */
  async function count(table, where = (q) => q) {
    const { count: n, error } = await where(client.from(table).select("*", { count: "exact", head: true }));
    if (error) throw failure(`count ${table}`, error);
    return typeof n === "number" ? n : 0;
  }

  return { from: (table) => client.from(table), rows, count, close: () => client.close() };
}

// ── absence, not refusal ────────────────────────────────────────────────────
//
// The two conditions a tier tolerates: 42P01, the table is not there (an
// optional schema never applied); 42703, the column is not (content_fingerprint
// on an upstream brain). Anything else — 42501, a role without SELECT, first
// among them — aborts the run: read as absence, it produced a report that
// called a denied table missing and exited 0 (review pass 4, SMD-2144).
const UNDEFINED_TABLE = "42P01";
const UNDEFINED_COLUMN = "42703";
const absent = (err, code) => Boolean(err) && err.code === code;

// ── helpers ─────────────────────────────────────────────────────────────────

/**
 * Make a thought-content snippet safe to embed inside a markdown report
 * bullet. The report is produced for a human but may also be parsed/rendered
 * by static site generators, so we defang the characters most likely to
 * break structure or smuggle markdown:
 *   - newlines / carriage returns (can introduce fake headings, bullets, HR)
 *   - backticks (can open/close code fences)
 *   - square brackets (can form `[text](url)` auto-links)
 * We also collapse runs of whitespace so long blobs do not distort columns.
 */
function sanitizePreview(s) {
  if (!s) return "";
  return String(s)
    .replace(/[\r\n]+/g, " ")
    .replace(/[`\[\]]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Expand a leading `~/` (or bare `~`) to the current user's home directory.
 * Only the prefix form is handled — embedded `~` elsewhere in the string is
 * treated as a literal character, matching shell-style behaviour.
 */
function expandHome(raw) {
  if (typeof raw !== "string" || raw.length === 0) return raw;
  if (raw === "~") return os.homedir();
  if (raw.startsWith("~/") || raw.startsWith("~\\")) {
    return path.join(os.homedir(), raw.slice(2));
  }
  return raw;
}

/**
 * Resolve `--report` and reject only true directory traversal. Absolute paths
 * (home-expanded, temp dirs, Windows drive paths) are accepted so scheduled
 * jobs can write outside `cwd` — this is a self-harm guard, not a security
 * boundary. We still refuse relative paths whose resolved form climbs out of
 * `cwd` (e.g. `--report=../../etc/passwd`) because that almost always means a
 * typo or copy-pasted flag.
 */
function resolveReportPath(raw) {
  const expanded = expandHome(raw);
  const cwd = process.cwd();
  const resolved = path.resolve(cwd, expanded);

  // Absolute inputs (after `~/` expansion) are trusted — the user stated an
  // explicit path. Only relative inputs need traversal validation.
  if (path.isAbsolute(expanded)) {
    return resolved;
  }

  const rel = path.relative(cwd, resolved);
  // A relative input is safe when the resolved path stays inside cwd. That
  // means `path.relative` returns either "" or a non-empty string that does
  // NOT start with ".." and is NOT itself absolute (rare cross-drive case on
  // Windows, where path.relative can return an absolute path).
  if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) {
    return resolved;
  }
  throw new Error(
    `--report path must not traverse above the current working directory. ` +
      `Got "${raw}" which resolves to "${resolved}" (outside "${cwd}"). ` +
      `Use an absolute path (e.g. /tmp/report.md or ~/lint-reports/report.md) instead.`
  );
}

// ── Tier 1: SQL-only lint (free) ────────────────────────────────────────────
//
// Each check pulls from `public.thoughts` through compat/supabase-sql with
// aggregation done server-side where possible. These are cheap — all run in one second
// against a 100K-thought table.

async function tier1SqlLint(db, args) {
  const out = {
    totalThoughts: 0,
    orphansByTag: 0,           // thoughts with no topics and no tags
    exactDuplicates: [],       // content_fingerprint collisions (if column exists)
    noFingerprint: 0,          // rows with NULL content_fingerprint
    lowSignalNoise: 0,         // importance <= 2 and content short
    overTagged: [],            // thoughts with >10 tags (usually import noise)
    emptyContent: 0,           // content IS NULL or trimmed to empty
    veryLongContent: 0,        // content > 20K chars (usually unchunked dumps)
  };

  // Total row count — a counted head query, no rows pulled; a refusal aborts the run.
  out.totalThoughts = await db.count("thoughts");

  // Orphans by tag: metadata.topics and metadata.tags both empty or missing.
  // The safer path is to pull a bounded sample and filter in JS. We look at the
  // most recent 2000 rows — by created_at: ids are uuids on this fork, so
  // `id desc` would order nothing (SMD-2144).
  const recent = await db.rows(
    db.from("thoughts").select("id,content,created_at,metadata,source_type,importance").order("created_at", { ascending: false }).order("id", { ascending: false }).limit(2000),
    "thoughts (recent 2000)"
  );

  for (const t of recent) {
    const topics = Array.isArray(t?.metadata?.topics) ? t.metadata.topics : [];
    const tags = Array.isArray(t?.metadata?.tags) ? t.metadata.tags : [];
    const people = Array.isArray(t?.metadata?.people) ? t.metadata.people : [];

    if (topics.length === 0 && tags.length === 0 && people.length === 0) {
      out.orphansByTag++;
    }
    if (tags.length > 10) {
      out.overTagged.push({ id: t.id, tag_count: tags.length });
    }
    const content = typeof t.content === "string" ? t.content.trim() : "";
    if (!content) out.emptyContent++;
    if (content.length > 20_000) out.veryLongContent++;
    const imp = typeof t.importance === "number" ? t.importance : null;
    if (imp !== null && imp <= 2 && content.length < 40) out.lowSignalNoise++;
  }

  // Exact duplicates — only meaningful if content_fingerprint is populated
  try {
    const fp = await db.rows(
      db.from("thoughts").select("id,content_fingerprint").not("content_fingerprint", "is", null).order("content_fingerprint").limit(5000),
      "thoughts (fingerprinted)"
    );
    const buckets = new Map();
    for (const row of fp) {
      if (!row.content_fingerprint) continue;
      const list = buckets.get(row.content_fingerprint) || [];
      list.push(row.id);
      buckets.set(row.content_fingerprint, list);
    }
    for (const [fingerprint, ids] of buckets) {
      if (ids.length > 1) {
        out.exactDuplicates.push({ fingerprint: fingerprint.slice(0, 12), ids: ids.slice(0, 5), copies: ids.length });
      }
    }
  } catch (e) {
    if (!absent(e, UNDEFINED_COLUMN)) throw e;
    // the column is not on this brain; that's fine — report it
    out.exactDuplicates = [{ note: "content_fingerprint column missing — see recipes/content-fingerprint-dedup" }];
  }

  try {
    out.noFingerprint = await db.count("thoughts", (q) => q.is("content_fingerprint", null));
  } catch (e) {
    if (!absent(e, UNDEFINED_COLUMN)) throw e;
    // column missing — already flagged above
    out.noFingerprint = 0;
  }

  return out;
}

// ── Tier 2: graph-based lint (free) ─────────────────────────────────────────
//
// Looks at the knowledge graph (entities, edges, thought_entities) to find
// structural issues: high-importance thoughts with no entity links, entities
// with zero edges (isolated nodes), edges pointing to non-existent thoughts.
//
// All reads — no LLM, no writes.

async function tier2GraphLint(db, args) {
  const out = {
    highImportanceIsolated: [],   // importance >= 4 thoughts with no entity links
    entitiesWithNoEdges: 0,
    graphTablesMissing: [],       // which of (entities, edges, thought_entities) are absent
  };

  // Probe graph tables — they're optional in Open Brain
  for (const t of ["entities", "edges", "thought_entities"]) {
    try {
      await db.rows(db.from(t).select("*").limit(1), t);
    } catch (e) {
      if (!absent(e, UNDEFINED_TABLE)) throw e;
      out.graphTablesMissing.push(t);
    }
  }
  if (out.graphTablesMissing.length === 3) {
    return out;   // no graph tables at all — skip tier silently
  }

  // High-importance thoughts with no rows in thought_entities
  if (!out.graphTablesMissing.includes("thought_entities")) {
    const hi = await db.rows(
      db.from("thoughts").select("id,content,importance,created_at").gte("importance", 4).order("created_at", { ascending: false }).order("id", { ascending: false }).limit(500),
      "thoughts (high importance)"
    );
    // Fetch up to 500 thought_entities rows keyed on those ids.
    const ids = hi.map((r) => r.id).slice(0, 500);
    if (ids.length > 0) {
      // An IN list of 100 ids per query keeps each statement small.
      const linked = new Set();
      for (let i = 0; i < ids.length; i += 100) {
        const chunk = ids.slice(i, i + 100);
        const rows = await db.rows(
          db.from("thought_entities").select("thought_id").in("thought_id", chunk),
          "thought_entities"
        );
        for (const r of rows) linked.add(r.thought_id);
      }
      for (const t of hi) {
        if (!linked.has(t.id)) {
          out.highImportanceIsolated.push({
            id: t.id,
            importance: t.importance,
            created_at: t.created_at,
            preview: sanitizePreview(String(t.content || "").slice(0, 120)),
          });
        }
      }
    }
  }

  // Entities with zero edges
  if (!out.graphTablesMissing.includes("entities") && !out.graphTablesMissing.includes("edges")) {
    // The columns are schemas/entity-extraction's (from_entity_id, to_entity_id);
    // the script had read src_/dst_, which no schema in the tree has (SMD-2144).
    const ents = await db.rows(db.from("entities").select("id").limit(2000), "entities");
    const edges = await db.rows(db.from("edges").select("from_entity_id,to_entity_id").limit(5000), "edges");
    const touched = new Set();
    for (const e of edges) {
      if (e.from_entity_id != null) touched.add(e.from_entity_id);
      if (e.to_entity_id != null) touched.add(e.to_entity_id);
    }
    out.entitiesWithNoEdges = ents.filter((e) => !touched.has(e.id)).length;
  }

  return out;
}

// ── Tier 3: LLM-assisted contradiction sampling (budgeted) ──────────────────
//
// Samples N thoughts, groups them into batches of ~20, sends each batch to
// OpenRouter once. Each batch produces findings across six categories.
// Total LLM calls ≤ --max-llm-calls (default 5 → audits 100 thoughts).

async function tier3LlmLint(db, args) {
  const out = {
    enabled: true,
    skippedReason: null,
    llmCalls: 0,
    sampleSize: 0,
    findings: {
      contradictions: [],
      stale_facts: [],
      superseded: [],
      orphans: [],
      low_signal: [],
      missing_links: [],
    },
  };

  const openrouterKey = envVar("OPENROUTER_API_KEY");
  if (!openrouterKey) {
    out.enabled = false;
    out.skippedReason = "OPENROUTER_API_KEY not set";
    return out;
  }
  if (args.maxLlmCalls === 0) {
    out.enabled = false;
    out.skippedReason = "--max-llm-calls=0";
    return out;
  }

  // Pull a recent sample of atomic (non-derived) thoughts. Fetch 2x the
  // requested sample so the post-filter `.slice(0, args.sampleSize)` below
  // still has enough eligible rows after derived/short thoughts are dropped.
  // The upper bound mirrors the `--sample-size` validator (max 1000) so we
  // never silently under-sample when the user asks for 500+ thoughts.
  const since = new Date(Date.now() - args.days * 86_400_000).toISOString();
  const fetchLimit = Math.min(args.sampleSize * 2, 1000);
  const rows = await db.rows(
    db.from("thoughts").select("id,content,importance,type,source_type,created_at,metadata").gte("created_at", since).order("created_at", { ascending: false }).order("id", { ascending: false }).limit(fetchLimit),
    "thoughts (recent sample)"
  );
  const atomic = rows.filter(
    (t) => t?.metadata?.derivation_layer !== "derived" && typeof t.content === "string" && t.content.trim().length >= 20
  );
  const sample = atomic.slice(0, args.sampleSize);
  out.sampleSize = sample.length;

  if (sample.length < 10) {
    out.enabled = false;
    out.skippedReason = `only ${sample.length} eligible thoughts in last ${args.days} days (need 10)`;
    return out;
  }

  const BATCH = 20;
  const batches = [];
  for (let i = 0; i < sample.length; i += BATCH) {
    if (batches.length >= args.maxLlmCalls) break;
    batches.push(sample.slice(i, i + BATCH));
  }

  for (const batch of batches) {
    const rowsForPrompt = batch.map((t) => ({
      id: t.id,
      date: String(t.created_at || "").slice(0, 10),
      type: t.type,
      importance: t.importance,
      content: String(t.content || "").slice(0, 400),
      topics: (t?.metadata?.topics ?? []).slice(0, 5),
      tags: (t?.metadata?.tags ?? []).slice(0, 5),
    }));

    const systemPrompt =
      "You audit a personal second brain for quality issues. " +
      "Given a cluster of thoughts, identify GENUINE problems across six categories. " +
      "Be CONSERVATIVE — only flag real issues, never stylistic preferences or minor overlap. " +
      "If a category has no issues, return an empty array. " +
      "Output STRICT valid JSON with this exact shape:\n" +
      "{\n" +
      '  "contradictions": [{"thought_ids": [N,M], "issue": "...", "suggested_action": "..."}],\n' +
      '  "stale_facts": [{"thought_ids": [N], "issue": "...", "suggested_action": "..."}],\n' +
      '  "superseded": [{"thought_ids": [N,M], "issue": "...", "suggested_action": "..."}],\n' +
      '  "orphans": [{"thought_ids": [N], "issue": "...", "suggested_action": "..."}],\n' +
      '  "low_signal": [{"thought_ids": [N], "issue": "...", "suggested_action": "..."}],\n' +
      '  "missing_links": [{"thought_ids": [N,M], "issue": "...", "suggested_action": "..."}]\n' +
      "}\n" +
      "No markdown, no commentary, JSON only. " +
      "Definitions:\n" +
      "  contradictions — two thoughts state incompatible facts.\n" +
      "  stale_facts — deadlines passed, tech deprecated, statuses outdated.\n" +
      "  superseded — older decision replaced by newer one but not marked.\n" +
      "  orphans — content has no natural connection to anything else in sample.\n" +
      "  low_signal — importance >= 4 but content is trivial.\n" +
      "  missing_links — two thoughts about the same subject not cross-referenced.";

    const userPrompt =
      `Sample size: ${rowsForPrompt.length}\n\n` +
      `THOUGHTS:\n${JSON.stringify(rowsForPrompt)}\n\n` +
      `Audit the cluster now. JSON output only.`;

    if (args.verbose) {
      console.error(`  [tier3] LLM call ${out.llmCalls + 1}/${batches.length} (${rowsForPrompt.length} thoughts)`);
    }

    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${openrouterKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://github.com/NateBJones-Projects/OB1",
        "X-Title": "Open Brain Lint Sweep",
      },
      body: JSON.stringify({
        model: args.llmModel,
        max_tokens: 2048,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`OpenRouter HTTP ${res.status}: ${body.slice(0, 300)}`);
    }

    const payload = await res.json();
    const raw = payload?.choices?.[0]?.message?.content?.trim() ?? "";
    out.llmCalls++;

    const cleaned = raw.replace(/^```(?:json)?/m, "").replace(/```$/m, "").trim();
    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      // TODO(WR-04): Currently any single unparseable LLM response aborts the
      // whole run and no partial report is written (writeFileSync happens
      // after every tier completes). This is documented fail-loud behavior
      // (README "Safety" section). Future options if this becomes painful:
      //   1) retry once with a stricter system prompt,
      //   2) write a partial report before re-raising,
      //   3) skip the failing batch and continue.
      // Left as documented trade-off for now.
      throw new Error(`Failed to parse Tier 3 JSON (call ${out.llmCalls}): ${e.message}\nRaw: ${raw.slice(0, 300)}`);
    }

    for (const cat of Object.keys(out.findings)) {
      const arr = Array.isArray(parsed?.[cat]) ? parsed[cat] : [];
      out.findings[cat].push(...arr);
    }
  }

  return out;
}

// ── report rendering ────────────────────────────────────────────────────────

function renderReport({ args, tier1, tier2, tier3, startedAt, finishedAt }) {
  const lines = [];
  const now = new Date().toISOString();
  lines.push("---");
  lines.push(`title: Lint Sweep — ${now.slice(0, 10)}`);
  lines.push(`generated_at: ${now}`);
  lines.push(`tier: ${args.tier}`);
  lines.push(`started_at: ${startedAt}`);
  lines.push(`finished_at: ${finishedAt}`);
  lines.push("---");
  lines.push("");
  lines.push(`# Open Brain Lint Sweep — ${now.slice(0, 10)}`);
  lines.push("");
  lines.push("*Read-only audit. This script never mutates thoughts.*");
  lines.push("");

  // Scan scope — make sampling caps explicit so the counts below are not
  // misread as whole-brain totals on large installs.
  lines.push("## Scan scope");
  lines.push("");
  lines.push("This run inspects bounded samples, not your entire brain. Counts below are relative to these samples.");
  lines.push("");
  if (tier1) {
    lines.push("- **Tier 1** — most recent **2000 thoughts** (ordered by `created_at desc`) for orphan/over-tag/length checks; up to **5000 rows** with a populated `content_fingerprint` for duplicate detection; full-table exact row counts for `thoughts` and `content_fingerprint IS NULL` (no cap).");
  }
  if (tier2) {
    lines.push("- **Tier 2** — most recent **500 high-importance thoughts** (`importance >= 4`, ordered by `created_at desc`), first **2000 entities**, first **5000 edges**.");
  }
  if (tier3) {
    if (tier3.enabled) {
      lines.push(`- **Tier 3** — up to **${args.sampleSize} thoughts** from the last **${args.days} days**, batched ~20 per LLM call, hard-capped at **${args.maxLlmCalls} LLM calls**.`);
    } else {
      lines.push(`- **Tier 3** — skipped (${tier3.skippedReason}).`);
    }
  }
  lines.push("");
  lines.push("On brains larger than these caps, Tier 1/2 counts represent a **slice**, not the global total. Example: \"Entities with zero edges: 12\" under a 2000-entity cap means *12 isolated entities among the first 2000 returned*, not \"12 total isolated entities.\" For whole-brain coverage, run the SQL views in [`views.sql`](./views.sql) directly.");
  lines.push("");

  // Summary header
  const tier3Count = tier3
    ? Object.values(tier3.findings || {}).reduce((n, a) => n + (Array.isArray(a) ? a.length : 0), 0)
    : 0;
  lines.push("## Summary");
  lines.push("");
  lines.push("*Counts below reflect the bounded scan scope described above — not whole-brain totals.*");
  lines.push("");
  if (tier1) {
    lines.push(`- Total thoughts in table (exact count, uncapped): ${tier1.totalThoughts}`);
    lines.push(`- Orphans by tag (in recent 2000 sampled): ${tier1.orphansByTag}`);
    lines.push(`- Exact-duplicate fingerprint groups (in first 5000 fingerprinted rows): ${Array.isArray(tier1.exactDuplicates) ? tier1.exactDuplicates.filter((x) => x.ids).length : 0}`);
    lines.push(`- Rows missing content_fingerprint (exact count, uncapped): ${tier1.noFingerprint}`);
    lines.push(`- Low-signal noise candidates (in recent 2000 sampled): ${tier1.lowSignalNoise}`);
  }
  if (tier2) {
    lines.push(`- High-importance isolated — no entity links (in first 500 high-importance sampled): ${tier2.highImportanceIsolated.length}`);
    lines.push(`- Entities with zero edges (among first 2000 entities ∩ first 5000 edges): ${tier2.entitiesWithNoEdges}`);
  }
  if (tier3) {
    if (tier3.enabled) {
      lines.push(`- LLM contradiction findings: ${tier3Count} (over ${tier3.sampleSize} thoughts, ${tier3.llmCalls} LLM calls)`);
    } else {
      lines.push(`- Tier 3 skipped: ${tier3.skippedReason}`);
    }
  }
  lines.push("");

  // Tier 1 details
  if (tier1) {
    lines.push("## Tier 1 — SQL-only lint (free)");
    lines.push("");
    lines.push(`- Orphans by tag (recent 2000 thoughts): **${tier1.orphansByTag}** — thoughts with no topics, tags, or people.`);
    lines.push(`- Over-tagged (>10 tags): **${tier1.overTagged.length}** — typically import noise.`);
    if (tier1.overTagged.length > 0) {
      for (const row of tier1.overTagged.slice(0, 10)) {
        lines.push(`  - thought #${row.id} → ${row.tag_count} tags`);
      }
      if (tier1.overTagged.length > 10) lines.push(`  - …and ${tier1.overTagged.length - 10} more`);
    }
    lines.push(`- Empty content: **${tier1.emptyContent}**`);
    lines.push(`- Very long content (>20K chars): **${tier1.veryLongContent}** — usually unchunked dumps.`);
    lines.push(`- Low-signal noise (importance ≤2, content <40 chars): **${tier1.lowSignalNoise}**`);
    lines.push(`- Exact-duplicate fingerprint groups: **${Array.isArray(tier1.exactDuplicates) ? tier1.exactDuplicates.filter((x) => x.ids).length : 0}**`);
    if (Array.isArray(tier1.exactDuplicates)) {
      for (const d of tier1.exactDuplicates.slice(0, 10)) {
        if (d.note) lines.push(`  - *${d.note}*`);
        else lines.push(`  - fingerprint ${d.fingerprint}… → ${d.copies} copies (ids: ${d.ids.join(", ")})`);
      }
    }
    lines.push(`- Rows missing content_fingerprint: **${tier1.noFingerprint}** — consider running the fingerprint-dedup-backfill recipe.`);
    lines.push("");
  }

  // Tier 2 details
  if (tier2) {
    lines.push("## Tier 2 — Graph-based lint (free)");
    lines.push("");
    lines.push("*Scope: most recent 500 high-importance thoughts (`created_at desc`), first 2000 entities, first 5000 edges. Counts below are within that slice, not the whole brain.*");
    lines.push("");
    if (tier2.graphTablesMissing.length > 0) {
      lines.push(`*Graph tables absent: ${tier2.graphTablesMissing.join(", ")}. Tier 2 requires the \`entity-extraction\` schema (which ships \`entities\`, \`edges\`, \`thought_entities\`) — see PRs #197 and #199. The \`ob-graph\` recipe uses different table names and does NOT satisfy this dependency.*`);
      lines.push("");
    }
    lines.push(`- High-importance (≥4) thoughts with no entity links (in first 500 high-importance sampled): **${tier2.highImportanceIsolated.length}**`);
    for (const row of tier2.highImportanceIsolated.slice(0, 15)) {
      lines.push(`  - #${row.id} (imp=${row.importance}, ${row.created_at?.slice(0, 10)}) — ${row.preview}${row.preview.length >= 120 ? "…" : ""}`);
    }
    if (tier2.highImportanceIsolated.length > 15) {
      lines.push(`  - …and ${tier2.highImportanceIsolated.length - 15} more`);
    }
    lines.push(`- Entities with zero edges (among first 2000 entities ∩ first 5000 edges): **${tier2.entitiesWithNoEdges}**`);
    lines.push("");
  }

  // Tier 3 details
  if (tier3) {
    lines.push("## Tier 3 — LLM-assisted contradiction sampling (budgeted)");
    lines.push("");
    if (!tier3.enabled) {
      lines.push(`*Skipped: ${tier3.skippedReason}.*`);
      lines.push("");
    } else {
      lines.push(`- Sample size: **${tier3.sampleSize}** thoughts`);
      lines.push(`- LLM calls: **${tier3.llmCalls}** (cap: ${args.maxLlmCalls})`);
      lines.push(`- Model: \`${args.llmModel}\``);
      lines.push("");

      const sections = [
        ["Contradictions", tier3.findings.contradictions, "Two thoughts state incompatible facts."],
        ["Stale Facts", tier3.findings.stale_facts, "Deadlines, statuses, or tech references that appear outdated."],
        ["Superseded Decisions", tier3.findings.superseded, "Older decisions replaced by newer ones but not marked."],
        ["Orphan Content", tier3.findings.orphans, "Thoughts with no natural connection to the rest of the sample."],
        ["Low-Signal (importance ≥4 but trivial)", tier3.findings.low_signal, "Thoughts rated important that don't carry weight."],
        ["Missing-Link Suggestions", tier3.findings.missing_links, "Thoughts about the same subject that should cross-reference."],
      ];
      for (const [heading, items, subtitle] of sections) {
        lines.push(`### ${heading} (${items.length})`);
        lines.push("");
        lines.push(`*${subtitle}*`);
        lines.push("");
        if (items.length === 0) {
          lines.push("- none");
        } else {
          for (const item of items) {
            const ids = (item.thought_ids ?? []).map((i) => `#${i}`).join(", ");
            lines.push(`- **${ids}** — ${item.issue}`);
            if (item.suggested_action) lines.push(`  - *Action:* ${item.suggested_action}`);
          }
        }
        lines.push("");
      }
    }
  }

  lines.push("---");
  lines.push("");
  lines.push("**Safety:** `lint-sweep.js` is read-only. Every finding above is a suggestion for a human to review. ");
  lines.push("Before acting on any item, verify the thought with `get_thought` or the web UI. ");
  lines.push("Never delete or edit a thought based solely on this report.");
  return lines.join("\n");
}

// ── main ────────────────────────────────────────────────────────────────────

// The client main() opens, closed at the bottom on both paths: the pool's connections
// would otherwise keep the process alive after a failure.
let activeClient = null;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    return;
  }

  const baseUrl = envVarWithLegacy("SUPABASE_URL", "OPEN_BRAIN_URL");
  // Read for the callers that still set it, under either name and without a
  // warning; the shim ignores it (SMD-2144).
  const serviceKey = envVar("SUPABASE_SERVICE_ROLE_KEY") || envVar("OPEN_BRAIN_SERVICE_KEY");
  if (!baseUrl) {
    console.error(
      "ERROR: SUPABASE_URL must be set (env or .env.local) — the brain's postgres:// connection string. " +
        "Legacy OPEN_BRAIN_URL is accepted as a fallback with a deprecation warning."
    );
    // No exit call: the code is set and the process ends on its own once the
    // client, if any, is closed (SMD-2144).
    process.exitCode = 1;
    return;
  }
  let db;
  try {
    db = makeClient(baseUrl, serviceKey);
  } catch (err) {
    console.error(`ERROR: ${err?.message || err}`);
    process.exitCode = 1;
    return;
  }
  activeClient = db;

  const startedAt = new Date().toISOString();
  console.log(`[lint-sweep] tier=${args.tier} sample=${args.sampleSize} max_llm_calls=${args.maxLlmCalls} report=${args.report}`);

  let tier1 = null;
  let tier2 = null;
  let tier3 = null;

  if (args.tier === "1" || args.tier === "all") {
    console.log("[tier 1] SQL-only lint…");
    tier1 = await tier1SqlLint(db, args);
    console.log(
      `[tier 1] done — ${tier1.totalThoughts} total thoughts, ` +
        `${tier1.orphansByTag} orphans-by-tag, ` +
        `${Array.isArray(tier1.exactDuplicates) ? tier1.exactDuplicates.filter((x) => x.ids).length : 0} dup groups, ` +
        `${tier1.noFingerprint} missing-fingerprint`
    );
  }

  if (args.tier === "2" || args.tier === "all") {
    console.log("[tier 2] graph lint…");
    tier2 = await tier2GraphLint(db, args);
    console.log(
      `[tier 2] done — ${tier2.highImportanceIsolated.length} high-imp isolated, ` +
        `${tier2.entitiesWithNoEdges} isolated entities` +
        (tier2.graphTablesMissing.length ? `, missing: ${tier2.graphTablesMissing.join(",")}` : "")
    );
  }

  if (args.tier === "3" || args.tier === "all") {
    console.log("[tier 3] LLM contradiction sampling…");
    tier3 = await tier3LlmLint(db, args);
    if (tier3.enabled) {
      const total = Object.values(tier3.findings).reduce((n, a) => n + a.length, 0);
      console.log(`[tier 3] done — ${total} findings over ${tier3.sampleSize} thoughts (${tier3.llmCalls} LLM calls)`);
    } else {
      console.log(`[tier 3] skipped — ${tier3.skippedReason}`);
    }
  }

  const finishedAt = new Date().toISOString();
  const report = renderReport({ args, tier1, tier2, tier3, startedAt, finishedAt });
  fs.mkdirSync(path.dirname(path.resolve(args.report)), { recursive: true });
  fs.writeFileSync(args.report, report, "utf8");
  console.log(`[lint-sweep] report written → ${args.report}`);
}

main().then(
  () => activeClient?.close(),
  async (err) => {
    console.error("[lint-sweep] FAILED:", err?.message || err);
    if (process.env.DEBUG) console.error(err);
    process.exitCode = 1;
    await activeClient?.close();
  }
);
