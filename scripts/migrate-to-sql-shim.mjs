#!/usr/bin/env node
/**
 * migrate-to-sql-shim.mjs — move files off supabase-js onto compat/supabase-sql.
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
 *   node scripts/migrate-to-sql-shim.mjs                 # triage report, no writes
 *   node scripts/migrate-to-sql-shim.mjs --apply <path>… # rewrite specific files
 *   node scripts/migrate-to-sql-shim.mjs --apply --all   # rewrite every eligible file
 *   node scripts/migrate-to-sql-shim.mjs --revert <path>… # put it back
 *
 * A file is INELIGIBLE when it uses something the shim deliberately does not
 * implement. Those need a human, and the report says which and why.
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
  { re: /\.select\(\s*[`'"][^`'"]*[a-z_]+\(/, why: "PostgREST resource embedding (a join) — needs FK introspection" },
  { re: /\.auth\b/, why: "Supabase Auth (GoTrue) — not implemented" },
  { re: /\.storage\b/, why: "Supabase Storage — not implemented" },
  { re: /\.channel\s*\(/, why: "Supabase Realtime — not implemented" },
  { re: /functions\s*\.\s*invoke\s*\(/, why: "functions.invoke — call the endpoint directly instead" },
  { re: /\.or\s*\(\s*[`'"][^`'"]*\b(?:and|or)\s*\(/, why: "nested .or()/and() grouping — needs a real parser" },
  {
    re: /import\s+type\s*\{[^}]*\}\s*from\s*['"][^'"]*@supabase\/supabase-js/,
    why: "type-only import (Session/User/SupabaseClient) — the shim exports different types",
  },
  { re: /\.textSearch\s*\(/, why: "PostgREST .textSearch() — write it as an .rpc() instead" },
];

function walk(dir, out = []) {
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

function classify(file) {
  const text = readFileSync(file, "utf8");
  const usesSupabase = IMPORT_RE.test(text) || NPM_IMPORT_RE.test(text);
  IMPORT_RE.lastIndex = 0;
  NPM_IMPORT_RE.lastIndex = 0;

  // A migrated file no longer imports @supabase/supabase-js, so matching only on
  // that specifier makes every migrated file invisible — and `--revert` with no
  // arguments then silently finds nothing to do.
  const onShim = /(['"])[^'"]*compat\/supabase-sql\/index\.ts\1/.test(text);
  if (!usesSupabase && !onShim) return null;

  const rel = relative(ROOT, file);
  const already = onShim;
  const blockers = BLOCKERS.filter((b) => b.re.test(text)).map((b) => b.why);
  return { file, rel, already, blockers, eligible: blockers.length === 0 };
}

/** Relative specifier from the file back to compat/supabase-sql/index.ts. */
function shimPath(file) {
  const from = dirname(file);
  let p = relative(from, join(ROOT, "compat", "supabase-sql", "index.ts"));
  if (!p.startsWith(".")) p = "./" + p;
  return p.split("\\").join("/");
}

function rewrite(file) {
  const original = readFileSync(file, "utf8");
  const spec = shimPath(file);

  // Record the exact specifier that was replaced. Files use several forms —
  // "@supabase/supabase-js", "npm:@supabase/supabase-js@2",
  // "https://esm.sh/@supabase/supabase-js@2" — and a revert that guesses would
  // quietly rewrite one form into another, leaving a diff after a round trip.
  const found = original.match(NPM_IMPORT_RE) ?? original.match(IMPORT_RE);
  if (!found) return { changed: false };
  const quote = found[0][0];              // keep ' or " as the file had it
  const originalSpec = found[0].slice(1, -1);

  let text = original
    .replace(NPM_IMPORT_RE, `${quote}${spec}${quote}`)
    .replace(IMPORT_RE, `${quote}${spec}${quote}`);
  if (text === original) return { changed: false };

  const banner =
    `// MIGRATED OFF SUPABASE: imports compat/supabase-sql instead of @supabase/supabase-js.\n` +
    `// Same API, but it speaks SQL directly. The environment variable NAMES are\n` +
    `// unchanged — set SUPABASE_URL to a postgres:// connection string, and\n` +
    `// SUPABASE_SERVICE_ROLE_KEY is ignored (credentials live in the URL).\n` +
    `// ob1-original-import: ${originalSpec}\n` +
    `// Revert with: node scripts/migrate-to-sql-shim.mjs --revert <file>\n`;

  if (!text.includes("// MIGRATED OFF SUPABASE")) {
    // A shebang must stay on line 1, so insert after it rather than above it.
    // Prepending blindly broke four executable scripts.
    const shebang = text.startsWith("#!") ? text.slice(0, text.indexOf("\n") + 1) : "";
    text = shebang + banner + text.slice(shebang.length);
  }

  writeFileSync(file, text);
  return { changed: true };
}

function revert(file) {
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

const found = walk(ROOT).map(classify).filter(Boolean).sort((a, b) => a.rel.localeCompare(b.rel));

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
console.log(`Apply with: node scripts/migrate-to-sql-shim.mjs --apply --all`);
