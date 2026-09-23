#!/usr/bin/env bun
/**
 * migrate-to-sql-shim.ts — move files off supabase-js onto compat/supabase-sql.
 *
 * 54 files outside the core server talk to PostgREST through supabase-js, across
 * 33,000 lines. Hand-porting them is weeks of work on code that is mostly
 * community recipes, and it would fork each one away from upstream forever.
 *
 * Because compat/supabase-sql presents the same API, most of them migrate by
 * changing one import and passing DATABASE_URL where they passed SUPABASE_URL.
 * This does that mechanically, and — more importantly — refuses to touch the
 * files where it would be wrong.
 *
 *   bun scripts/migrate-to-sql-shim.ts                 # triage report, no writes
 *   bun scripts/migrate-to-sql-shim.ts --apply <path>… # rewrite specific files
 *   bun scripts/migrate-to-sql-shim.ts --apply --all   # rewrite every eligible file
 *   bun scripts/migrate-to-sql-shim.ts --revert <path>… # put it back
 *
 * The shim imports `bun`, and the files it migrated were written as Supabase
 * Edge Functions — `Deno.env.get` for the environment, `Deno.serve` at the end
 * — so until SMD-1799 a migrated file also took a polyfill for those two
 * members as its first import (compat/deno-on-bun.ts; SMD-1480, FORK.md change
 * 74). The files are Bun-native now — `process.env`, `export default { port,
 * fetch }` — and the polyfill is gone: a file that still reaches a Deno global
 * is refused here (BLOCKERS) and ported by hand, not patched. `bun <file>`
 * serves a migrated file.
 *
 * A file is INELIGIBLE when it uses something the shim deliberately does not
 * implement, or when it deploys somewhere the shim cannot follow (KEEP below).
 * Those need a human, and the report says which and why. The blockers are the
 * shim's own refusals, spelled as regexes over the file: Supabase's Auth,
 * Storage, Realtime and Functions clients, a type-only import, `.textSearch()`,
 * and an order, limit or range on an embedded resource (foreignTable) — and,
 * since SMD-1799, a `Deno.*` reach, Bun's refusal rather than the shim's: the
 * file is ported to Bun's shape by hand first.
 * Resource embedding (nested, hinted) and `.or()` grouping are served since
 * SMD-1798 and block nothing (the history of the embed regexes is at BLOCKERS).
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const SKIP_DIRS = new Set(["node_modules", ".git", "server", "server-portable", "db", "deploy", "compat", "scripts"]);
const CODE = /\.(ts|tsx|js|mjs)$/;

const IMPORT_RE = /(['"])@supabase\/supabase-js\1/g;
const NPM_IMPORT_RE = /(['"])(?:npm:|https:\/\/esm\.sh\/|jsr:)@supabase\/supabase-js(?:@[^'"]*)?\1/g;

/** Reasons the shim cannot stand in. Each is something it refuses to fake. */
const BLOCKERS = [
  // Resource embedding is served whole since SMD-1798 — one hop since change 77 (SMD-1588), nested to any depth
  // and hinted (`!inner`, `!fk_name`, `!fk_column`) since then — through the shim's own foreign-key read, so no
  // select-list shape blocks a file here; a relation the catalog cannot join is the shim's refusal at the first
  // call, named. (Change 77's regexes refused a nested embed and a hint at triage; the one before them wanted the
  // relation flush against its parenthesis, let `maintenance_tasks (` through, and three servers were migrated
  // onto a shim that threw at their first embedded select.) Likewise `.or()` grouping — `and(…)`, `or(…)`,
  // `not.and(…)`, `col.in.(…)` — is parsed since SMD-1798, where it needed "a real parser".
  { re: /\.auth\b/, why: "Supabase Auth (GoTrue) — not implemented" },
  { re: /\.storage\b/, why: "Supabase Storage — not implemented" },
  { re: /\.channel\s*\(/, why: "Supabase Realtime — not implemented" },
  { re: /functions\s*\.\s*invoke\s*\(/, why: "functions.invoke — call the endpoint directly instead" },
  {
    re: /import\s+type\s*\{[^}]*\}\s*from\s*['"][^'"]*@supabase\/supabase-js/,
    why: "type-only import (Session/User/SupabaseClient) — the shim exports different types",
  },
  { re: /\.textSearch\s*\(/, why: "PostgREST .textSearch() — write it as an .rpc() instead" },
  // Bun has no `Deno`, and the polyfill that stood in for two of its members is gone (SMD-1799): the file is
  // ported first — `process.env` for the environment, `export default { port, fetch }` at the tail — by hand.
  { re: /\bDeno\.[A-Za-z_$]/, why: "reaches a Deno global — port it to Bun's shape first (process.env; export default { port, fetch }), SMD-1799" },
  // An order, limit or range on an embedded resource: the shim's embed returns every row, and the option applied
  // to the base table would be a silent wrong answer (SMD-1798's first review pass); the shim refuses it at the call.
  { re: /\.(?:order|limit|range)\s*\([^)]*\b(?:foreignTable|referencedTable)\b/, why: "an order, limit or range on an embedded resource (foreignTable/referencedTable) — the shim returns every embedded row; order or cut them in the file, or ask in a second query" },
];

/**
 * Files kept on supabase-js by path: the shim would resolve, but the file
 * deploys somewhere `bun` is not and PostgREST is. A reason per file; the
 * triage report prints it, --apply refuses it, --apply --all skips it.
 * (`integrations/agent-memory-api/index.ts` sat here from change 77, servable
 * but deployed as an Edge Function, until SMD-1798 moved it with the other
 * five servers that were still on supabase-js.)
 */
const KEEP = new Map([
  ["recipes/local-brain-no-mcp/functions/_shared/db.ts",
    "runs inside the recipe's own self-hosted Supabase stack (setup.sh symlinks functions/ into its edge runtime), where PostgREST is present and bun is not"],
]);

/** One file the scan found — on supabase-js, or already on the shim — with the reasons it cannot move. */
type Finding = { file: string; rel: string; already: boolean; blockers: string[]; eligible: boolean };

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    // SKIP_DIRS names top-level directories. Matching at every depth silently
    // skipped recipes/repo-learning-coach/server/, which does need migrating.
    const isTopLevel = resolve(dir) === ROOT;
    if (name === "node_modules" || name === ".git") continue;
    if (isTopLevel && SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, out);
    else if (CODE.test(name)) out.push(p);
  }
  return out;
}

function classify(file: string): Finding | null {
  const text = readFileSync(file, "utf8");
  const usesSupabase = IMPORT_RE.test(text) || NPM_IMPORT_RE.test(text);
  IMPORT_RE.lastIndex = 0;
  NPM_IMPORT_RE.lastIndex = 0;

  // A migrated file no longer imports @supabase/supabase-js, so matching only on
  // that specifier makes every migrated file invisible — and `--revert` with no
  // arguments then silently finds nothing to do.
  const onShim = /(['"])[^'"]*compat\/supabase-sql\/index\.ts\1/.test(text);
  if (!usesSupabase && !onShim) return null;

  const rel = relative(ROOT, file).split("\\").join("/");
  const already = onShim;
  const blockers = BLOCKERS.filter((b) => b.re.test(text)).map((b) => b.why);
  if (KEEP.has(rel)) blockers.push(`kept on supabase-js: ${KEEP.get(rel)}`);
  return { file, rel, already, blockers, eligible: blockers.length === 0 };
}

/** Relative specifier from the file back to compat/supabase-sql/index.ts. */
function shimPath(file: string): string {
  return relativeTo(file, join(ROOT, "compat", "supabase-sql", "index.ts"));
}

function relativeTo(file: string, target: string): string {
  let p = relative(dirname(file), target);
  if (!p.startsWith(".")) p = "./" + p;
  return p.split("\\").join("/");
}

function rewrite(file: string): { changed: boolean } {
  const original = readFileSync(file, "utf8");
  const spec = shimPath(file);

  // Record the exact specifier that was replaced. Files use several forms —
  // "@supabase/supabase-js", "npm:@supabase/supabase-js@2",
  // "https://esm.sh/@supabase/supabase-js@2" — and a revert that guesses would
  // quietly rewrite one form into another, leaving a diff after a round trip.
  const found = original.match(NPM_IMPORT_RE) ?? original.match(IMPORT_RE);
  let text = original;
  if (found) {
    const quote = found[0][0];              // keep ' or " as the file had it
    const originalSpec = found[0].slice(1, -1);
    text = text
      .replace(NPM_IMPORT_RE, `${quote}${spec}${quote}`)
      .replace(IMPORT_RE, `${quote}${spec}${quote}`);

    const banner =
      `// MIGRATED OFF SUPABASE: imports compat/supabase-sql instead of @supabase/supabase-js.\n` +
      `// Same API, but it speaks SQL directly. The environment variable NAMES are\n` +
      `// unchanged — set SUPABASE_URL to a postgres:// connection string, and\n` +
      `// SUPABASE_SERVICE_ROLE_KEY is ignored (credentials live in the URL).\n` +
      `// ob1-original-import: ${originalSpec}\n` +
      `// Revert with: bun scripts/migrate-to-sql-shim.ts --revert <file>\n`;

    if (!text.includes("// MIGRATED OFF SUPABASE")) {
      // A shebang must stay on line 1, so insert after it rather than above it.
      // Prepending blindly broke four executable scripts.
      const shebang = text.startsWith("#!") ? text.slice(0, text.indexOf("\n") + 1) : "";
      text = shebang + banner + text.slice(shebang.length);
    }
  }

  if (text === original) return { changed: false };

  writeFileSync(file, text);
  return { changed: true };
}

function revert(file: string): { changed: boolean } {
  const original = readFileSync(file, "utf8");
  const recorded = original.match(/^\/\/ ob1-original-import: (.+)$/m);
  const spec = recorded ? recorded[1].trim() : "@supabase/supabase-js";
  // The banner sits after a shebang when there is one, so anchor per line rather
  // than at the start of the file.
  let text = original.replace(/^\/\/ MIGRATED OFF SUPABASE:[\s\S]*?--revert <file>\n/m, "");
  text = text.replace(/(['"])[^'"]*compat\/supabase-sql\/index\.ts\1/g, (_m, q) => `${q}${spec}${q}`);
  if (text === original) return { changed: false };
  writeFileSync(file, text);
  return { changed: true };
}

// ── main ─────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const apply = argv.includes("--apply");
const doRevert = argv.includes("--revert");
const all = argv.includes("--all");
const targets = argv.filter((a) => !a.startsWith("--"));

const found = walk(ROOT).map(classify).filter((f) => f !== null).sort((a, b) => a.rel.localeCompare(b.rel));

if (doRevert) {
  const list = targets.length ? targets.map((t) => resolve(ROOT, t)) : found.filter((f) => f.already).map((f) => f.file);
  let n = 0;
  for (const f of list) if (revert(f).changed) { n++; console.log(`  reverted ${relative(ROOT, f)}`); }
  console.log(`\nreverted ${n} file(s)`);
  process.exit(0);
}

if (apply) {
  const chosen = all
    ? found.filter((f) => f.eligible && !f.already)
    : targets.map((t) => found.find((f) => f.file === resolve(ROOT, t)) ?? { file: resolve(ROOT, t), rel: t, eligible: false, blockers: ["not found in the scan"], already: false });

  if (chosen.length === 0) {
    console.log("Nothing to do. Run without --apply for the triage report.");
    process.exit(0);
  }

  let done = 0, refused = 0;
  for (const f of chosen) {
    if (!f.eligible) {
      console.error(`  ✗  ${f.rel}\n     ${f.blockers.join("; ")}`);
      refused++;
      continue;
    }
    if (rewrite(f.file).changed) { console.log(`  ✓  ${f.rel}`); done++; }
  }
  console.log(`\nmigrated ${done}, refused ${refused}`);
  process.exit(refused > 0 && done === 0 ? 1 : 0);
}

// Triage report.
const eligible = found.filter((f) => f.eligible && !f.already);
const blocked = found.filter((f) => !f.eligible);
const migrated = found.filter((f) => f.already);

console.log(`Scanned ${found.length} file(s) importing @supabase/supabase-js.\n`);

if (migrated.length) {
  console.log(`Already on the shim (${migrated.length}):`);
  for (const f of migrated) console.log(`  ·  ${f.rel}`);
  console.log();
}

console.log(`Eligible for the mechanical swap (${eligible.length}):`);
for (const f of eligible) console.log(`  ✓  ${f.rel}`);

if (blocked.length) {
  console.log(`\nNeeds a human (${blocked.length}) — the shim refuses to fake these:`);
  for (const f of blocked) console.log(`  ✗  ${f.rel}\n     ${f.blockers.join("; ")}`);
}

console.log(`\n${eligible.length} of ${found.length} migrate with one import change.`);
console.log(`Apply with: bun scripts/migrate-to-sql-shim.ts --apply --all`);
