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
 *   bun scripts/migrate-to-sql-shim.mjs                 # triage report, no writes
 *   bun scripts/migrate-to-sql-shim.mjs --apply <path>… # rewrite specific files
 *   bun scripts/migrate-to-sql-shim.mjs --apply --all   # rewrite every eligible file
 *   bun scripts/migrate-to-sql-shim.mjs --revert <path>… # put it back
 *
 * (node runs it too, where node is installed.)
 *
 * The shim imports `bun`, and the files it migrates were written as Supabase
 * Edge Functions — `Deno.env.get` for the environment, `Deno.serve` at the end
 * — so one import line left them running nowhere: not under Deno, which cannot
 * resolve `bun`, and not under Bun, which has no `Deno` (SMD-1480, FORK.md
 * change 74). A migrated file that uses a Deno global therefore gets a second
 * line: `import "…/compat/deno-on-bun.ts";` as its FIRST import, which gives
 * Bun the two members those files use and nothing else. Where the file's first
 * import is Supabase's type-only `import "jsr:@supabase/functions-js/
 * edge-runtime.d.ts";` — a specifier Bun cannot resolve — that line becomes the
 * polyfill import, the original recorded on the same line for --revert (a
 * types import anywhere else becomes that comment alone). Both are undone by
 * --revert, byte for byte; --apply --all also completes a file migrated
 * before this line existed. `bun <file>` then serves it.
 *
 * A file is INELIGIBLE when it uses something the shim deliberately does not
 * implement, or when it deploys somewhere the shim cannot follow (KEEP below).
 * Those need a human, and the report says which and why.
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

/**
 * Files kept on supabase-js by path: the shim would resolve, but the file
 * deploys somewhere `bun` is not and PostgREST is. A reason per file; the
 * triage report prints it, --apply refuses it, --apply --all skips it.
 */
const KEEP = new Map([
  ["recipes/local-brain-no-mcp/functions/_shared/db.ts",
    "runs inside the recipe's own self-hosted Supabase stack (setup.sh symlinks functions/ into its edge runtime), where PostgREST is present and bun is not"],
]);

/** Supabase's type-only import of the Edge Functions runtime's types; Bun cannot resolve a jsr: specifier. */
const TYPES_IMPORT_RE = /^import "(jsr:@supabase\/functions-js\/edge-runtime\.d\.ts)";$/m;
/** The polyfill's import as this script writes it — alone on a line, or in the types import's place with the original recorded. */
const RUNTIME_IMPORT_RE = /^import "([^"]*compat\/deno-on-bun\.ts)";(?: \/\/ ob1-original-types: (.+))?\n/m;
/** Read over the whole text, comments included: a Node-shaped file that mentions `Deno.env` in a comment gets a harmless extra line. */
const USES_DENO_RE = /\bDeno\./;

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

  const rel = relative(ROOT, file).split("\\").join("/");
  const already = onShim;
  const blockers = BLOCKERS.filter((b) => b.re.test(text)).map((b) => b.why);
  if (KEEP.has(rel)) blockers.push(`kept on supabase-js: ${KEEP.get(rel)}`);
  // On the shim, uses a Deno global, and has no deno-on-bun import yet: migrated before change 74.
  const incomplete = onShim && USES_DENO_RE.test(text) && !RUNTIME_IMPORT_RE.test(text);
  return { file, rel, already, incomplete, blockers, eligible: blockers.length === 0 };
}

/** Relative specifier from the file back to compat/supabase-sql/index.ts. */
function shimPath(file) {
  return relativeTo(file, join(ROOT, "compat", "supabase-sql", "index.ts"));
}

/** …and to compat/deno-on-bun.ts. */
function runtimePath(file) {
  return relativeTo(file, join(ROOT, "compat", "deno-on-bun.ts"));
}

function relativeTo(file, target) {
  let p = relative(dirname(file), target);
  if (!p.startsWith(".")) p = "./" + p;
  return p.split("\\").join("/");
}

/**
 * The runtime line, for a file that uses a Deno global and lacks it: in the
 * place of Supabase's jsr: types import when the file has one (Bun cannot
 * resolve the specifier; the original is recorded on the line for --revert),
 * otherwise a line of its own before the file's first import statement.
 * First, because a file the entry imports may read Deno.env in its module
 * body, and ES modules evaluate imports in order.
 */
function withRuntime(text, file) {
  if (!USES_DENO_RE.test(text) || RUNTIME_IMPORT_RE.test(text)) return text;
  const line = `import "${runtimePath(file)}";`;
  const first = text.search(/^import[\s{"']/m);
  if (first < 0) throw new Error(`${relative(ROOT, file)} uses a Deno global but has no import statement to put compat/deno-on-bun.ts before`);
  const types = TYPES_IMPORT_RE.exec(text);
  // In the types import's place when that IS the first import (the tree's four); otherwise first,
  // and any types import elsewhere becomes the comment alone — first is what the file needs.
  text = types && types.index === first
    ? text.replace(TYPES_IMPORT_RE, `${line} // ob1-original-types: ${types[1]}`)
    : text.slice(0, first) + line + "\n" + text.slice(first);
  return text.replace(new RegExp(TYPES_IMPORT_RE.source, "gm"), (_m, spec) => `// ob1-original-types: ${spec}`);
}

function rewrite(file) {
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
      `// Revert with: node scripts/migrate-to-sql-shim.mjs --revert <file>\n`;

    if (!text.includes("// MIGRATED OFF SUPABASE")) {
      // A shebang must stay on line 1, so insert after it rather than above it.
      // Prepending blindly broke four executable scripts.
      const shebang = text.startsWith("#!") ? text.slice(0, text.indexOf("\n") + 1) : "";
      text = shebang + banner + text.slice(shebang.length);
    }
  }

  // Already on the shim, or just put there: Deno's globals come from compat/deno-on-bun.ts.
  text = withRuntime(text, file);
  if (text === original) return { changed: false };

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
  // The runtime line: back to the jsr: types import it replaced, or gone; a types import left as a comment, back.
  text = text.replace(RUNTIME_IMPORT_RE, (_m, _p, types) => (types ? `import "${types}";\n` : ""));
  text = text.replace(/^\/\/ ob1-original-types: (.+)$/gm, (_m, spec) => `import "${spec}";`);
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
    ? found.filter((f) => f.eligible && (!f.already || f.incomplete))
    : targets.map((t) => found.find((f) => f.file === resolve(ROOT, t)) ?? { file: resolve(ROOT, t), rel: t, eligible: false, blockers: ["not found in the scan"], already: false, incomplete: false });

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
const incomplete = migrated.filter((f) => f.incomplete);

console.log(`Scanned ${found.length} file(s) importing @supabase/supabase-js.\n`);

if (migrated.length) {
  console.log(`Already on the shim (${migrated.length}):`);
  for (const f of migrated) console.log(`  ${f.incomplete ? "!" : "·"}  ${f.rel}`);
  if (incomplete.length) console.log(`  ! ${incomplete.length} use a Deno global without compat/deno-on-bun.ts — --apply --all adds it`);
  console.log();
}

console.log(`Eligible for the mechanical swap (${eligible.length}):`);
for (const f of eligible) console.log(`  ✓  ${f.rel}`);

if (blocked.length) {
  console.log(`\nNeeds a human (${blocked.length}) — the shim refuses to fake these:`);
  for (const f of blocked) console.log(`  ✗  ${f.rel}\n     ${f.blockers.join("; ")}`);
}

console.log(`\n${eligible.length} of ${found.length} migrate with one import change (two, for a file that reads Deno.env or calls Deno.serve).`);
console.log(`Apply with: bun scripts/migrate-to-sql-shim.mjs --apply --all`);
