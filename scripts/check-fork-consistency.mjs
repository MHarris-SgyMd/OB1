#!/usr/bin/env node
/**
 * check-fork-consistency.mjs
 *
 * Repo-wide versions of checks the upstream PR gate only applies to the
 * directories a given PR touches. Because the gate never looks at untouched
 * folders, violations that predate a rule — or that landed while the rule was
 * being tightened — persist indefinitely. This runs the same rules across
 * everything so they cannot rot back in.
 *
 * Checks:
 *   1. metadata.json validates against .github/metadata.schema.json
 *   2. metadata `category` matches the directory it lives in
 *   3. relative links in contribution READMEs resolve
 *   4. requires_primitives / requires_skills point at directories that exist
 *   5. ALTER TABLE thoughts ADD COLUMN is guarded with IF NOT EXISTS
 *   6. shipped content never hands untrusted input a shell — no sandbox-bypass
 *      or skip-permissions flag, alias or mode; no allow rule granting all of
 *      Bash or a prefix of a network client or interpreter; no spawn through a
 *      shell in any spelling — in every non-binary file under the contribution
 *      directories, with counted per-(file, hazard) exceptions
 *   7. vendored SQL never redefines, drops or re-comments a function the core
 *      migrations own, nor re-comments a thoughts column whose comment a
 *      migration writes — in every non-binary file under the seven category
 *      directories whole and docs/, the owned sets read from db/migrations/,
 *      with counted per-(file, function) exceptions for the files that create
 *      a brain rather than add to one
 *   8. a credential read from the environment is never compared with an
 *      equality operator — inline or through an identifier bound from the read
 *      — in the same files as 7, with counted per-file exceptions for the
 *      vendored files a ticket holds (none today)
 *   9. a committed eval fixture carries no thought content — ids, vectors and
 *      the searcher's own queries only (SMD-1295)
 *  10. a vendored file never writes a thought's content or vector around the
 *      functions that own them — no PostgREST `.update(`/`.upsert(`/`.insert(`
 *      on `thoughts` whose payload carries `content` or `embedding`, inline or
 *      through an object the file fills, and no SQL `UPDATE thoughts … SET` of
 *      either column or `INSERT INTO thoughts (…)` naming one — in the same
 *      files as 7, with counted per-file exceptions for a file whose README
 *      says it bypasses them (seven: three deployments with a database of
 *      their own, three function bodies shown, one test fixture)
 *  11. a file that imports the SQL shim (Bun's client) and uses a Deno global
 *      imports compat/deno-on-bun.ts first, uses no member of `Deno` beyond
 *      the two it provides (`env.get`, `serve`) and no specifier Bun cannot
 *      resolve (`jsr:`, `npm:`, a URL) — itself or through the files it
 *      imports — so `bun <file>` serves it (SMD-1480); no exceptions
 *  12. a .sql file under schemas/ or db/ runs nothing that needs Supabase — no
 *      `service_role`, `authenticated` or `anon`, no `auth.uid()`, `auth.role()`
 *      or `auth.users`, no `supabase_`-prefixed name, no RLS or policy —
 *      comments excepted by a literal-aware strip, string literals included
 *      (SMD-1796); the rules are db/config.mjs's SUPABASE_SQL_RULES, which
 *      test-schema [10] and [40] apply from inside the suite; no exceptions
 *  13. every port a compose file under deploy/ publishes names its host address
 *      as a knob that defaults to the literal 127.0.0.1 — the short form
 *      `"${X_BIND:-127.0.0.1}:${X_PORT:-n}:n"`, each `X_BIND` documented in
 *      deploy/.env.example — no service reaches outside the file (`extends`,
 *      `include`) or onto the host without a port (`network_mode`), and
 *      PUBLISHES names which service publishes from which file, one mapping
 *      each, so a mapping that is gone or refused fails as missing:
 *      compose.yaml publishes the server alone; the database and Ollama
 *      publish through compose.host-ports.yaml, a second -f. The files are
 *      parsed with Bun.YAML (SMD-1844); no exceptions
 *  14. every knob the server reads reaches the container: each `OB1_*` /
 *      `OPEN_BRAIN_*` name server-portable/index.ts declares in its `type Env`
 *      — and a server source reading one straight from the environment
 *      declares it there — is forwarded by deploy/compose.yaml's
 *      `server.environment` as `${NAME}` or `${NAME:-…}` under its own name
 *      (a bare list item is refused; or excused by name in NOT_FORWARDED,
 *      with the reason) and documented in deploy/.env.example; a forwarded
 *      name the server does not declare is a typo; a documented knob no
 *      service forwards is a dead switch; `env_file` is refused (a file this
 *      rule does not open); every compose*.yaml under deploy/ is held to the
 *      shape and to the server's names, since an overlay lands in the same
 *      container; and OB1_LLM_BASE_URL's fallback, if any, is
 *      `http://<service>:11434/v1` for a service the file defines and
 *      db/config.mjs's LOCAL_PROVIDER_SERVICES names. The environment is read
 *      from the parsed document — a name in a comment or on a command line is
 *      not a forward, which is how three knobs passed the text rule this
 *      replaces — and the decision is one pure function its probes run on
 *      in-memory documents (SMD-1843)
 *
 * Run: bun scripts/check-fork-consistency.mjs   (plain ESM; node runs it too,
 * except checks 13 and 14, which parse YAML with Bun.YAML and fail in words under node)
 * Exits non-zero on any violation.
 */

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { coreColumnCommentStatement, coreFunctionStatement, LOCAL_PROVIDER_SERVICES, ownedColumnCommentsIn, ownedFunctionsIn, supabaseIsmsIn } from "../db/config.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CATEGORIES = [
  "recipes",
  "schemas",
  "dashboards",
  "integrations",
  "skills",
  "primitives",
  "extensions",
];

const violations = [];
const fail = (where, msg) => violations.push({ where, msg });

const schema = JSON.parse(readFileSync(join(ROOT, ".github/metadata.schema.json"), "utf8"));
const props = schema.properties;

function contributionDirs() {
  const out = [];
  for (const cat of CATEGORIES) {
    const base = join(ROOT, cat);
    if (!existsSync(base)) continue;
    for (const name of readdirSync(base).sort()) {
      // _template is the category's placeholder, _shared the auth module the
      // category's servers import (a copy of server-portable/auth.ts), and
      // node_modules extensions/test-auth.ts's install (gitignored) — none is
      // a contribution.
      if (name === "_template" || name === "_shared" || name === "node_modules") continue;
      const dir = join(base, name);
      if (statSync(dir).isDirectory()) out.push({ cat, name, dir, rel: `${cat}/${name}` });
    }
  }
  return out;
}

// ── 1 + 2: metadata validity and category/directory agreement ────────────────

function checkMetadata({ cat, dir, rel }) {
  const file = join(dir, "metadata.json");
  if (!existsSync(file)) return fail(rel, "missing metadata.json");

  let d;
  try {
    d = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    return fail(`${rel}/metadata.json`, `invalid JSON: ${e.message}`);
  }

  const at = `${rel}/metadata.json`;

  for (const k of schema.required) {
    if (!(k in d)) fail(at, `missing required field '${k}'`);
  }
  for (const k of Object.keys(d)) {
    if (!(k in props)) fail(at, `field '${k}' not allowed by schema`);
  }
  if ("version" in d && !/^\d+\.\d+\.\d+$/.test(String(d.version))) {
    fail(at, `version '${d.version}' is not semver`);
  }
  if ("difficulty" in d && !props.difficulty.enum.includes(d.difficulty)) {
    fail(at, `difficulty '${d.difficulty}' is not one of ${props.difficulty.enum.join("/")}`);
  }
  if ("category" in d) {
    if (!props.category.enum.includes(d.category)) fail(at, `category '${d.category}' not in enum`);
    else if (d.category !== cat) fail(at, `category '${d.category}' does not match directory '${cat}'`);
  }
  if (d.author && typeof d.author === "object") {
    for (const k of Object.keys(d.author)) {
      if (!Object.keys(props.author.properties).includes(k)) fail(at, `author.${k} not allowed`);
    }
    if (!d.author.name) fail(at, "author.name is required");
  }
  if (d.requires && typeof d.requires === "object") {
    if (d.requires.open_brain !== true) {
      fail(at, `requires.open_brain must be boolean true (found ${JSON.stringify(d.requires.open_brain)})`);
    }
    // Derive allowed keys from the schema rather than duplicating the list here.
    const allowedRequires = Object.keys(props.requires.properties);
    for (const k of Object.keys(d.requires)) {
      if (!allowedRequires.includes(k)) fail(at, `requires.${k} not allowed`);
    }
  }
  if ("tags" in d && (!Array.isArray(d.tags) || d.tags.length < 1)) {
    fail(at, "tags must be a non-empty array");
  }
  for (const k of ["created", "updated"]) {
    if (k in d && !/^\d{4}-\d{2}-\d{2}$/.test(String(d[k]))) fail(at, `${k} '${d[k]}' is not YYYY-MM-DD`);
  }

  return d;
}

// ── 3: relative links resolve ────────────────────────────────────────────────

function checkLinks({ dir, rel }) {
  const readme = join(dir, "README.md");
  if (!existsSync(readme)) return fail(rel, "missing README.md");

  const text = readFileSync(readme, "utf8");
  for (const m of text.matchAll(/\]\(([^)]+)\)/g)) {
    const link = m[1].trim();
    if (/^(https?:|mailto:|#)/.test(link)) continue;
    const path = link.split("#")[0];
    if (!path) continue;
    if (!existsSync(join(dir, path))) fail(`${rel}/README.md`, `broken link '${link}'`);
  }
}

// ── 4: declared dependencies exist ───────────────────────────────────────────

function checkDeps(meta, { rel }) {
  if (!meta) return;
  for (const [field, folder] of [
    ["requires_primitives", "primitives"],
    ["requires_skills", "skills"],
  ]) {
    for (const slug of meta[field] ?? []) {
      if (!existsSync(join(ROOT, folder, slug))) {
        fail(`${rel}/metadata.json`, `${field} references '${slug}' but ${folder}/${slug}/ does not exist`);
      }
    }
  }
}

// ── Line scanning, shared by checks 5 and 6 ──────────────────────────────────

/** Repo-relative path with `/` separators on every OS, so it can be a key. */
const relOf = (file) => relative(ROOT, file).split(sep).join("/");

function walk(dir, out = [], match = /\.(sql|md)$/) {
  for (const name of readdirSync(dir)) {
    // .claude holds this repo's agent worktrees — whole copies of the tree.
    if (name === ".git" || name === "node_modules" || name === ".claude") continue;
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, out, match);
    else if (match.test(name)) out.push(p);
  }
  return out;
}

/**
 * Run every rule over every file. A rule is { name, msg } plus either `re`
 * (tested per line, without the g flag so test() is stateless) or `fileRe`
 * (tested against the whole text with the g flag, for shapes that span lines —
 * a pretty-printed JSON list; the line reported is the match's first). `only`
 * restricts a rule to files whose path matches. `suppress(rel)` keeps the rule
 * running and its hits COUNTED but not failed. Returns hit counts keyed
 * `${rel} ${name}`, so a caller can hold a suppressed file to an expected
 * count — one read, one definition of "matches", for the scan and the
 * exception audit alike.
 */
function scanLines(files, rules) {
  const counts = new Map();
  const hit = (rel, rule, line, quiet) => {
    const key = `${rel} ${rule.name ?? rule.msg}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if (!quiet) fail(`${rel}:${line}`, rule.msg);
  };
  for (const file of files) {
    const rel = relOf(file);
    const text = readFileSync(file, "utf8");
    const lines = text.split("\n");
    for (const rule of rules) {
      if (rule.only && !rule.only.test(rel)) continue;
      const quiet = rule.suppress?.(rel) ?? false;
      if (rule.fileRe) {
        for (const m of text.matchAll(rule.fileRe)) {
          hit(rel, rule, text.slice(0, m.index).split("\n").length, quiet);
        }
      } else {
        lines.forEach((line, i) => { if (rule.re.test(line)) hit(rel, rule, i + 1, quiet); });
      }
    }
  }
  return counts;
}

// ── 5: ADD COLUMN on thoughts must be re-runnable ────────────────────────────

function checkSqlGuards() {
  scanLines(walk(ROOT), [{
    name: "add-column-guard",
    re: /alter\s+table\s+(?:public\.)?thoughts\s+add\s+column\s+(?!if\s+not\s+exists)/i,
    msg: "ADD COLUMN on thoughts without IF NOT EXISTS",
  }]);
}

// ── 5b: every migration numbered, one per number ────────────────────────────
//
// The number is a migration's identity — its order, and how prose names it —
// and two branches each adding "the next number" is how two files come to
// share one (the fork has renumbered twice; SMD-1421). migrate.ts refuses such
// a set at run time, which is every operator's run and every compose start;
// this is the same rule — config.mjs's duplicateMigrationNumber, one spelling
// — where the collision is created, on every push.

async function checkMigrationNumbers() {
  const { migrationNameProblem } = await import("../db/config.mjs");
  const problem = migrationNameProblem(readdirSync(join(ROOT, "db", "migrations")));
  if (problem) fail("db/migrations", problem);
}

// ── 6: shipped content never hands untrusted input a shell ───────────────────
//
// SMD-1251. Two vendored recipes did. `gmail-smart-pull` kept a `codex exec`
// branch over Gmail message bodies that one environment variable turned into a
// sandbox-bypass run — upstream had already deleted the identical branch from
// `atomizer` and missed this copy — and its CLI spawns used `shell: true` with
// the binary path from an environment variable. `life-engine`'s recommended
// settings.json allowed `Bash(*)` beside a skip-permissions launch, defended by
// a prompt rule addressed to the model being injected. Both were fixed on that
// ticket; this is what keeps the next rebase from bringing them back.
//
// The rule this enforces, written down here because the tree is vendored from
// upstream wholesale (FORK.md, "Vendored content"): we audit once and hold the
// delta, and a standing check carries the audit. Content that ships under this
// repo's name does not run an agent with its sandbox or approvals off, does not
// recommend a wildcard, bare or interpreter-prefix shell allow, and does not
// spawn through a shell. The patterns are MECHANISMS, not the spellings the two
// fixed files happened to use: Codex's bypass flag and its aliases, Claude
// Code's skip-permissions flag and mode, every allow-rule shape that grants all
// of Bash or a prefix of a network client or interpreter, and every spawn shape
// that involves a shell — the `shell:` option with any non-false value,
// exec/execSync (always a shell), os.system/os.popen, and an explicit
// `sh -c` / `cmd /c` argv. A probe list is checked against them on every run so
// a pattern cannot rot silently.
//
// Exceptions are per (file, hazard) and COUNTED: a file that must name one flag
// in order to say it was removed is exempt from that hazard for exactly the
// number of lines it has today, and is scanned for every other hazard in full.
// One more line naming the flag — a rebase re-adding a usage block beside the
// warning — fails; one fewer — the prose rewritten — fails too, so the list is
// kept honest in both directions.
const CODE_FILES = /\.(m?js|cjs|tsx?)$/;
const SHELL_HAZARDS = [
  { name: "codex-bypass",
    // The flag, its aliases, and the config key behind them (config.toml, or a
    // `-c approval_policy=never` override on the command line).
    re: /--dangerously-bypass-approvals-and-sandbox|--yolo\b|danger-full-access|--ask-for-approval[\s=]+never\b|(?<![\w-])-a\s+never\b|approval_policy\s*=\s*["']?never\b/,
    what: "Codex's sandbox-bypass flag, one of its aliases, or approval_policy=never" },
  { name: "skip-permissions",
    re: /--dangerously-skip-permissions|bypassPermissions/,
    what: "Claude Code's skip-permissions flag or mode" },
  { name: "wildcard-bash",
    // Bash(*), Bash(:*), Bash(*:*); a line that is only `Bash`, or a YAML list
    // item `- Bash`; an `allowed-tools:` (YAML) or `--allowedTools` /
    // `--allowed-tools` (CLI) carrying the bare token anywhere after it,
    // `Bash(git status:*)` and the like not counting.
    re: /Bash\(\s*:?\*+\s*(?::\*)?\s*\)|^\s*(?:-\s+)?Bash\s*\\?\s*$|allowed-tools:[^\n]*?(?<![\w(])Bash(?![\w(])|--allowed-?[Tt]ools\b[^\n]*?(?<![\w(-])Bash(?![\w(])/,
    what: "an allow rule that grants all of Bash" },
  { name: "wildcard-bash",
    // A quoted bare "Bash" INSIDE an allow list, however it is printed — the
    // list is read as a whole, so a `deny` list, a hook matcher, a
    // metadata.json `tools` entry or prose naming the tool in quotes is not it,
    // and a `deny` on the same line as an `allow` does not excuse the allow.
    fileRe: /["'](?:allow|allowedTools)["']\s*:\s*\[[^\]]*?["']Bash["']/g,
    what: "an allow rule that grants all of Bash" },
  { name: "bash-prefix-interpreter",
    // A prefix or glob rule on a network client, a shell, an interpreter or a
    // package runner, by bare name or full path — any `*` after the name, in
    // the `:*` form or the `Bash(curl *)` / `Bash(curl -s *host*)` glob form:
    // everything the star covers is approved, so `curl` is `-d @file` to any
    // host.
    re: /Bash\(\s*(?:[\w./-]*\/)?(?:curl|wget|sh|bash|zsh|fish|pwsh|powershell|cmd|node|python\d?|npx|npm\s+exec|pnpm\s+(?:dlx|exec)|yarn\s+dlx|bunx?|deno|eval|ssh|scp|nc|ncat|socat|perl|ruby|php)\b[^)]*\*[^)]*\)/,
    what: "a Bash prefix or glob rule on a network client or interpreter (everything the star covers is approved)" },
  { name: "shell-spawn",
    // In code files: the `shell` option with ANY value but false/0/null/undefined
    // — `true`, a path, an expression, a variable — wherever it sits.
    only: CODE_FILES,
    re: /(?:^|[{,])\s*["']?shell["']?\s*:\s*(?!false\b|0\b|null\b|undefined\b)\S/,
    what: "a spawn through a shell (spawn an argv array with no shell)" },
  { name: "shell-spawn",
    // Everywhere else (a README's code block, YAML, Python): the `shell` option
    // after `{` or `,`, or first on its line with a code value — so YAML's
    // `shell: bash` step key is not it; Python's shell=True/1; exec/execSync
    // called bare or on a child_process receiver, imported from child_process
    // or wrapped in promisify (always a shell); os.system/os.popen; an explicit
    // shell argv — `sh -c`/`-lc`/`-ec`, `cmd /c`/`/k`, `powershell -Command`,
    // by name, by path or via $SHELL — in a spawn, Bun.spawn or Deno.Command. A
    // code-shaped `exec(` in prose is flagged too; the remedy is an exception.
    re: /[{,]\s*["']?shell["']?\s*:\s*(?!false\b|0\b|null\b|undefined\b)\S|^\s*["']?shell["']?\s*:\s*(?:true\b|["'`]|process\.)|\bshell\s*=\s*(?:True|1)\b|(?<![\w.$`])(?:exec|execSync)\(|\b(?:child_process|childProcess|cp)\.exec(?:Sync)?\(|require\(["'](?:node:)?child_process["']\)\.exec(?:Sync)?\(|promisify\(\s*exec\s*\)|import\s*\{[^}]*\bexec(?:Sync)?\b[^}]*\}\s*from\s*["'](?:node:)?child_process["']|\bos\.(?:system|popen)\(|(?:["'](?:[\w./-]*\/)?(?:sh|bash|zsh|dash|fish|cmd(?:\.exe)?|powershell(?:\.exe)?|pwsh)["']|process\.env\.SHELL)\s*,\s*\[[^\]]*["'](?:-c|-lc|-ec|-ic|\/[cCkK]|-Command|-EncodedCommand)["']|(?:Bun\.spawn|Deno\.Command)\(\s*\[?\s*(?:["'](?:[\w./-]*\/)?(?:sh|bash|zsh|cmd|powershell|pwsh)["']|process\.env\.SHELL)/,
    what: "a spawn through a shell (spawn an argv array with no shell)" },
];
/** Strings each hazard must catch — the check's own negative tests. */
const SHELL_HAZARD_PROBES = [
  ["codex-bypass", "codex exec --dangerously-bypass-approvals-and-sandbox -"],
  ["codex-bypass", "codex exec --yolo -"],
  ["codex-bypass", "--sandbox danger-full-access"],
  ["codex-bypass", "codex --ask-for-approval never"],
  ["codex-bypass", "codex --ask-for-approval=never"],
  ["codex-bypass", "codex exec -a never -"],
  ["codex-bypass", 'approval_policy = "never"'],
  ["codex-bypass", "codex -c approval_policy=never exec -"],
  ["skip-permissions", "claude --dangerously-skip-permissions"],
  ["skip-permissions", '"defaultMode": "bypassPermissions"'],
  ["skip-permissions", "--permission-mode bypassPermissions"],
  ["wildcard-bash", '      "Bash(*)",'],
  ["wildcard-bash", "'Bash(*:*)'"],
  ["wildcard-bash", "Bash(:*)"],
  ["wildcard-bash", '"allow": ["Bash"]'],
  ["wildcard-bash", '{"permissions": {"allow": ["Bash"], "deny": []}}'],
  ["wildcard-bash", '"allow": [\n      "Read",\n      "Bash",\n    ],'],
  ["wildcard-bash", "    Bash \\"],
  ["wildcard-bash", "  - Bash"],
  ["wildcard-bash", "allowed-tools: Read, Bash"],
  ["wildcard-bash", "allowed-tools: Bash(git status:*), Bash"],
  ["wildcard-bash", "--allowedTools Bash Edit"],
  ["wildcard-bash", "--allowed-tools Bash"],
  ["bash-prefix-interpreter", '"Bash(curl:*)"'],
  ["bash-prefix-interpreter", "Bash(curl -s https://api.open-meteo.com/v1/forecast:*)"],
  ["bash-prefix-interpreter", "Bash(/usr/bin/curl:*)"],
  ["bash-prefix-interpreter", "Bash(node:*)"],
  ["bash-prefix-interpreter", "Bash(npm exec:*)"],
  ["bash-prefix-interpreter", "Bash(curl *)"],
  ["bash-prefix-interpreter", "Bash(curl -s *api.open-meteo.com*)"],
  ["bash-prefix-interpreter", "Bash(python3 *)"],
  ["shell-spawn", "      shell: true,"],
  ["shell-spawn", '{ "shell": true }'],
  ["shell-spawn", ', shell: "/bin/sh",'],
  ["shell-spawn", '{ stdio: "pipe", shell: process.platform === "win32" }'],
  ["shell-spawn", "subprocess.run(cmd, shell=True)"],
  ["shell-spawn", "subprocess.run(cmd, shell=1)"],
  ["shell-spawn", "cp.execSync(cmd)"],
  ["shell-spawn", 'require("child_process").execSync(cmd)'],
  ["shell-spawn", 'spawn("/bin/sh", ["-c", cmd])'],
  ["shell-spawn", "spawn(process.env.SHELL, ['-c', cmd])"],
  ["shell-spawn", "spawn('sh', ['-ec', cmd])"],
  ["shell-spawn", 'spawn("cmd", ["/k", cmd])'],
  ["shell-spawn", "execSync(`claude -p ${text}`)"],
  ["shell-spawn", "exec(cmd, (err, out) => {"],
  ["shell-spawn", "child_process.exec(cmd)"],
  ["shell-spawn", "const run = promisify(exec);"],
  ["shell-spawn", 'import { exec } from "node:child_process";'],
  ["shell-spawn", "os.system(cmd)"],
  ["shell-spawn", 'spawn("cmd", ["/c", "start", "", url])'],
  ["shell-spawn", "spawn('sh', ['-c', cmd])"],
  ["shell-spawn", "spawn('sh', ['-lc', cmd])"],
  ["shell-spawn", "spawn('powershell', ['-NoProfile', '-Command', cmd])"],
  ["shell-spawn", "Bun.spawn(['sh', '-c', cmd])"],
  ["shell-spawn", "new Deno.Command('cmd', { args: ['/c', url] })"],
];
/** Strings no hazard may catch — ordinary prose and code this repo writes. */
// Code-file-only probes for the `shell` option with a non-literal value.
const SHELL_HAZARD_CODE_PROBES = [
  "        shell: isWin,",
  "  shell: opts.shell,",
];
const SHELL_HAZARD_NON_PROBES = [
  "a wildcard `Bash` allow",
  "two `Bash` rules",
  "no shell (SMD-1251): args is an argv array",
  "const m = /^x$/.exec(content);",
  "this spawn uses no shell, so the value",
  "shell: false,",
  'Bash(date "+%Y-%m-%d %H:%M:%S %Z")',
  "WebFetch(domain:api.open-meteo.com)",
  "Restart your shell: `source ~/.zshrc`",
  "Default shell: zsh",
  "      shell: bash",
  "codex exec (the OpenAI CLI) was removed",
  '"deny": ["Bash"]',
  '"disallowedTools": ["Bash"]',
  '"matcher": "Bash"',
  "allowed-tools: Bash(git status:*), Read",
  "Bash(git status:*)",
  "execFileSync(\"git\", [\"ls-files\"])",
  '"deny": [\n      "Bash",\n    ]',
  'if (input.tool_name === "Bash") {',
  '"tools": ["Bash", "Node.js 18+"]',
  '"ask": ["Bash"]',
  'The "Bash" tool is powerful',
  "      shell: isWin,",
];
const SHELL_HAZARD_EXCEPTIONS = new Map([
  // Prose that names the deleted flag in order to say it was deleted: exactly
  // this many lines, for exactly this hazard.
  ["recipes/atomizer/README.md", { "codex-bypass": { why: "the warning that documents the codex provider's removal", lines: 1 } }],
  ["recipes/atomizer/lib/atomize-text.mjs", { "codex-bypass": { why: "the header note that documents the same removal", lines: 1 } }],
]);
// Text is scanned by construction (checks 6 and 7): only known binary shapes
// and lockfiles are skipped, so an extensionless Dockerfile, Procfile or CNAME
// is read like everything else.
const BINARY_FILES = /\.(png|jpe?g|gif|webp|svg|ico|woff2?|ttf|otf|pdf|zip|gz|tgz|lock|mp3|mp4|mov|m4a|wav|webm)$|(?:^|\/)(?:package-lock\.json|bun\.lockb?)$/i;

/**
 * Files git ignores under ROOT — recipe run output (email packs, OAuth state),
 * node_modules, .env — as repo-relative `/` paths. Untrusted text a recipe
 * pulled onto a maintainer's machine must not decide whether the tree passes,
 * and CI on a clean checkout has none of it. Empty when git is unavailable, in
 * which case everything is scanned.
 */
function gitIgnoredFiles(dirs) {
  try {
    // Scoped to the directories scanned and unbounded, so a node_modules or a
    // build output elsewhere in the tree cannot overflow the default 1 MiB
    // buffer and turn the skip off silently.
    const out = execFileSync("git", ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--", ...dirs.map((d) => d.rel)],
      { cwd: ROOT, encoding: "utf8", maxBuffer: Infinity });
    return new Set(out.split("\0").filter(Boolean));
  } catch (e) {
    console.warn(`  (git ls-files failed — ${e.message.split("\n")[0]} — scanning ignored files too)`);
    return new Set();
  }
}

/** Which hazards a text trips, by the same rules scanLines applies (line rules per line, file rules whole). */
function hazardsIn(text, rel = "probe.md") {
  const names = new Set();
  for (const h of SHELL_HAZARDS) {
    if (h.only && !h.only.test(rel)) continue;
    const found = h.fileRe ? new RegExp(h.fileRe.source, h.fileRe.flags.replace("g", "")).test(text)
      : text.split("\n").some((line) => h.re.test(line));
    if (found) names.add(h.name);
  }
  return names;
}

function checkShellHazards(dirs) {
  const SELF = "scripts/check-fork-consistency.mjs";
  for (const [name, probe] of SHELL_HAZARD_PROBES) {
    if (!hazardsIn(probe).has(name)) fail(SELF, `shell-hazard pattern '${name}' no longer catches its probe: ${probe}`);
  }
  for (const probe of SHELL_HAZARD_CODE_PROBES) {
    if (!hazardsIn(probe, "probe.mjs").has("shell-spawn")) fail(SELF, `shell-hazard pattern 'shell-spawn' no longer catches its code probe: ${probe}`);
  }
  for (const text of SHELL_HAZARD_NON_PROBES) {
    const [name] = hazardsIn(text);
    if (name) fail(SELF, `shell-hazard pattern '${name}' catches ordinary text it must not: ${text}`);
  }
  // Only the contribution directories — not their `_template` placeholders,
  // which contributionDirs() already skips — so this never depends on the
  // display filter below to hide a placeholder's hits.
  const counts = scanLines(textFilesUnder(dirs), SHELL_HAZARDS.map(({ name, re, fileRe, only, what }) => ({
    name,
    re,
    fileRe,
    only,
    msg: `${what} — shipped content must not hand untrusted input a shell (SMD-1251)`,
    suppress: (rel) => Boolean(SHELL_HAZARD_EXCEPTIONS.get(rel)?.[name]),
  })));
  for (const [rel, byHazard] of SHELL_HAZARD_EXCEPTIONS) {
    for (const [name, { why, lines }] of Object.entries(byHazard)) {
      const seen = counts.get(`${rel} ${name}`) ?? 0;
      if (seen !== lines) {
        fail(rel, seen === 0
          ? `listed as a shell-hazard exception for '${name}' (${why}) but matches nothing — remove it from SHELL_HAZARD_EXCEPTIONS`
          : `shell-hazard exception for '${name}' (${why}) covers ${lines} line(s) but ${seen} match — a new usage beside the documented one, or the exception's count is stale`);
      }
    }
  }
}

/**
 * Every non-binary, non-ignored file under these directories — what checks 6
 * and 7 read. The ignored set is read once, over the seven category
 * directories and docs/, which cover every directory either check walks.
 */
const SCANNED_ROOTS = [...CATEGORIES, "docs"].map((c) => ({ dir: join(ROOT, c), rel: c }));
let ignoredFiles;
function textFilesUnder(dirs) {
  ignoredFiles ??= gitIgnoredFiles(SCANNED_ROOTS);
  return dirs.flatMap((d) => walk(d.dir, [], /./))
    .filter((f) => !BINARY_FILES.test(f) && !ignoredFiles.has(relOf(f)));
}

// ── 7: vendored SQL never redefines or drops a function a migration owns ─────
//
// SMD-1250. Three vendored files carried `CREATE OR REPLACE FUNCTION
// public.upsert_thought(p_content TEXT, p_payload JSONB DEFAULT '{}')` and
// presented themselves as additive sidecars. Against a brain built by
// db/migrate.ts that statement REPLACES the body migration 005 installed — no
// error, the signature matches — and the scan for the rest found worse:
// thought-work-claims put its own `release_thought` over 015's (every worker
// release then fails 015's CHECK, and its release_claims_for_worker deletes
// the rows), a recipe's "additive" migration put a 2026-04 body over the
// 3-argument `upsert_thought` every capture on the SQL path runs — 008's
// actor, 021's label, 022's window rule and 025's provenance gone in one
// paste — and over 024's `thought_stats_summary`, and the vendored
// provenance-chains schema carried `trace_provenance`/`find_derivatives` under
// 025/026's signatures (which fail on the return type, as it turned out, but
// install after the DROP its own rollback shows) and a `COMMENT ON COLUMN
// thoughts.derived_from` that silently overwrote 025's contract. The
// vendored files were fixed on that ticket (FORK.md change 58: the statements
// cut where the file adds to a brain, the file excepted where it creates one);
// this is what keeps the next rebase from bringing them back.
//
// The owned set is READ from db/migrations/ — every `CREATE [OR REPLACE]
// FUNCTION` at the start of a line, comments stripped, with the file that last
// defines it — never typed, so it cannot lag the next migration. A hit is any
// CREATE FUNCTION, DROP FUNCTION, ALTER FUNCTION or COMMENT ON FUNCTION naming
// an owned function at the start of a line (a header comment quoting one
// begins with `--`; prose naming one is not a statement) — COMMENT because 028
// and 031 carry a data contract in a function's comment, which a vendored
// COMMENT ON overwrites as silently as CREATE OR REPLACE overwrites the body —
// in every non-binary, non-ignored file under the seven category directories
// WHOLE (a category's README and its `_template` included, which
// contributionDirs() skips) AND docs/, where two of the three original files
// lived. The rule itself is db/config.mjs's coreFunctionStatement, which
// test-schema [31] applies too. By NAME, not signature: a matching signature is the
// silent replacement, and a new overload beside an owned function is the
// ambiguity 004's header names and the arity split SMD-1245 describes.
//
// Exceptions are per (file, function) and COUNTED, as check 6's are: the
// files that CREATE a brain from the getting-started shape — the guide the
// migrations were extracted from, a recipe's own Neon database, a Kubernetes
// init script — define these functions because they are building the
// database the migrations would otherwise build, and are excepted for exactly
// the lines they have today with the reason beside them; one more line fails,
// one fewer fails as stale. A sidecar that adds to an existing brain gets no
// exception: its statement was cut and a header says which migration owns the
// function.
const MIGRATION_TEXTS = readdirSync(join(ROOT, "db", "migrations")).filter((f) => f.endsWith(".sql")).sort()
  .map((f) => [f, readFileSync(join(ROOT, "db", "migrations", f), "utf8")]);
const OWNED_FUNCTIONS = ownedFunctionsIn(MIGRATION_TEXTS);
const OWNED_COLUMN_COMMENTS = ownedColumnCommentsIn(MIGRATION_TEXTS);
/** The whole-text rule as scanLines's `fileRe` (the g flag added; the line reported is the match's first). */
const asFileRe = (re) => new RegExp(re.source, re.flags + "g");
/** Strings the rule must catch — the check's own negative tests, run through the scan's machinery every time. */
const CORE_FUNCTION_PROBES = [
  ["upsert_thought", "CREATE OR REPLACE FUNCTION public.upsert_thought(p_content TEXT, p_payload JSONB DEFAULT '{}')"],
  ["upsert_thought", "create or replace function upsert_thought("],
  ["upsert_thought", "  CREATE FUNCTION upsert_thought (p_content text)"],
  ["match_thoughts", "create or replace function match_thoughts(\n  query_embedding vector(1536),"],
  ["trace_provenance", "DROP FUNCTION IF EXISTS public.trace_provenance(UUID, INT, INT);"],
  ["release_thought", "drop function release_thought;"],
  ["update_thought", "ALTER FUNCTION update_thought(uuid, text, jsonb) OWNER TO postgres;"],
  ["update_updated_at", "CREATE OR REPLACE FUNCTION update_updated_at()"],
  ["upsert_thought", "CREATE OR REPLACE FUNCTION\n  upsert_thought(p_content text)"],
  ["release_thought", "COMMENT ON FUNCTION public.release_thought IS"],
  ["claim_thoughts", "comment on function claim_thoughts(text, text, int, int) is 'x';"],
  // The quoting a Supabase dashboard export or `supabase db diff` emits.
  ["upsert_thought", 'CREATE OR REPLACE FUNCTION "public"."upsert_thought"("p_content" "text", "p_payload" "jsonb" DEFAULT \'{}\'::"jsonb")'],
  ["match_thoughts", '  DROP FUNCTION IF EXISTS public."match_thoughts"(vector, float, int, jsonb);'],
  ["update_thought", "> CREATE PROCEDURE update_thought(p_id uuid)"],
  ["renew_claims", "DROP ROUTINE renew_claims;"],
];
/** Ordinary lines the rule must not catch. */
const CORE_FUNCTION_NON_PROBES = [
  "CREATE OR REPLACE FUNCTION match_thoughts_recency(",
  "CREATE OR REPLACE FUNCTION update_updated_at_column()",
  "CREATE OR REPLACE FUNCTION upsert_thoughts_batch(",
  "-- CREATE OR REPLACE FUNCTION upsert_thought(text, jsonb) is the statement 003 ran",
  "SELECT upsert_thought('x', '{}'::jsonb);",
  "GRANT EXECUTE ON FUNCTION public.upsert_thought(TEXT, JSONB) TO service_role;",
  "COMMENT ON FUNCTION public.release_thought_legacy IS 'x';",
  "COMMENT ON COLUMN public.thoughts.derived_from IS 'x';",
  "REVOKE EXECUTE ON FUNCTION public.trace_provenance(UUID, INT, INT) FROM PUBLIC;",
  "calls `upsert_thought` through PostgREST, then match_thoughts",
  "The `CREATE OR REPLACE FUNCTION upsert_thought` in upstream's file is cut here.",
  '-- > CREATE OR REPLACE FUNCTION "public"."upsert_thought"(',
  "CREATE OR REPLACE FUNCTION public.upsert_thought_v2(",
];
/** Column comments the rule must catch, and ordinary ones it must not. */
const COLUMN_COMMENT_PROBES = [
  ["derived_from", "COMMENT ON COLUMN public.thoughts.derived_from IS"],
  ["supersedes", 'comment on column "thoughts"."supersedes" is \'x\';'],
];
const COLUMN_COMMENT_NON_PROBES = [
  "COMMENT ON COLUMN public.thoughts.derivation_layer IS 'x';",
  "COMMENT ON COLUMN thought_work_claims.ttl_expires_at IS 'x';",
  "-- COMMENT ON COLUMN thoughts.derived_from IS what 025 runs",
];
// Files that create a brain from the getting-started shape, not sidecars that
// add to one. Exactly this many lines, for exactly these functions.
const GUIDE = "the guide migrations 001-003 were extracted from, creating the brain; SETUP.md sends this fork's readers past it";
const NEON = "creates the recipe's own Neon database from the guide's shape; never run against a migrated brain";
const LOCAL_INIT = "the init script of the recipe's own Postgres container, run once on an empty database";
const one = (why) => ({ why, lines: 1 });
const CORE_FUNCTION_EXCEPTIONS = new Map([
  ["docs/01-getting-started.md", { update_updated_at: one(GUIDE), match_thoughts: one(GUIDE), upsert_thought: one(GUIDE) }],
  ["recipes/content-fingerprint-dedup/README.md", {
    upsert_thought: one("the recipe migration 003 was extracted from, kept as its record; the note above its Step 2 says a migrated brain must not paste it"),
  }],
  ["recipes/vercel-neon-telegram/sql/001-create-thoughts.sql", { update_updated_at: one(NEON) }],
  ["recipes/vercel-neon-telegram/sql/002-match-thoughts.sql", { match_thoughts: one(NEON) }],
  ["integrations/kubernetes-deployment/k8s/init.sql", {
    match_thoughts: one("the init script of the deployment's own Postgres, run once on an empty database"),
  }],
  ["integrations/kubernetes-deployment/k8s/openbrain.yml", {
    match_thoughts: one("the ConfigMap carrying k8s/init.sql, the deployment's own Postgres init, run once on an empty database"),
  }],
  ["recipes/local-brain-no-mcp/volumes/db/init/01-thoughts-schema.sh", { update_updated_at: one(LOCAL_INIT) }],
  ["recipes/local-brain-no-mcp/volumes/db/init/02-match-thoughts-fn.sh", {
    match_thoughts: one(LOCAL_INIT),
    upsert_thought: one(`${LOCAL_INIT} (a third signature, text/vector/jsonb)`),
  }],
]);

/** Which of `owned`'s names a text names in a statement, by the rule the scan applies to the whole text. */
const namedIn = (owned, ruleFor, text) => new Set([...owned.keys()].filter((name) => ruleFor(name).test(text)));
const coreStatementsIn = (text) => namedIn(OWNED_FUNCTIONS, coreFunctionStatement, text);
const columnCommentsIn = (text) => namedIn(OWNED_COLUMN_COMMENTS, coreColumnCommentStatement, text);

function checkCoreFunctions() {
  const SELF = "scripts/check-fork-consistency.mjs";
  if (OWNED_FUNCTIONS.size === 0) return fail(SELF, "no migration under db/migrations defines a function — the owned set is empty and check 7 would pass everything");
  for (const [fn, probe] of CORE_FUNCTION_PROBES) {
    if (!OWNED_FUNCTIONS.has(fn)) fail(SELF, `core-function probe names '${fn}', which no migration defines — the probe or the owned set is stale`);
    else if (!coreStatementsIn(probe).has(fn)) fail(SELF, `core-function rule no longer catches its probe for '${fn}': ${probe}`);
  }
  for (const text of CORE_FUNCTION_NON_PROBES) {
    const [fn] = coreStatementsIn(text);
    if (fn) fail(SELF, `core-function rule for '${fn}' catches ordinary text it must not: ${text}`);
  }
  if (OWNED_COLUMN_COMMENTS.size === 0) fail(SELF, "no migration under db/migrations comments a thoughts column — the owned column set is empty and its rule would pass everything");
  for (const [col, probe] of COLUMN_COMMENT_PROBES) {
    if (!OWNED_COLUMN_COMMENTS.has(col)) fail(SELF, `column-comment probe names 'thoughts.${col}', which no migration comments — the probe or the owned set is stale`);
    else if (!columnCommentsIn(probe).has(col)) fail(SELF, `column-comment rule no longer catches its probe for 'thoughts.${col}': ${probe}`);
  }
  for (const text of COLUMN_COMMENT_NON_PROBES) {
    const [col] = columnCommentsIn(text);
    if (col) fail(SELF, `column-comment rule for 'thoughts.${col}' catches ordinary text it must not: ${text}`);
  }
  // The seven category directories whole — not contributionDirs(), which
  // yields one entry per contribution and so skips each category's README and
  // its `_template` — and docs/, upstream's guide and drafts, where two of the
  // three files this check was written for lived.
  const before = violations.length;
  const counts = scanLines(textFilesUnder(SCANNED_ROOTS), [
    ...[...OWNED_FUNCTIONS].map(([fn, file]) => ({
      name: fn,
      fileRe: asFileRe(coreFunctionStatement(fn)),
      msg: `redefines, drops or re-comments ${fn}, which the core migrations own (last defined by db/migrations/${file}); vendored SQL must not touch a function a migration owns (SMD-1250)`,
      suppress: (rel) => Boolean(CORE_FUNCTION_EXCEPTIONS.get(rel)?.[fn]),
    })),
    ...[...OWNED_COLUMN_COMMENTS].map(([col, file]) => ({
      name: `thoughts.${col}`,
      fileRe: asFileRe(coreColumnCommentStatement(col)),
      msg: `re-comments thoughts.${col}, whose comment db/migrations/${file} writes as a data contract; vendored SQL must not overwrite it (SMD-1250)`,
    })),
  ]);
  // Why, and what to do — once per run, not once per matching line.
  if (violations.length > before) {
    fail("check 7", "a CREATE OR REPLACE on a matching signature replaces the migration's body silently, an overload beside it splits callers by arity, a DROP removes it, a COMMENT ON overwrites a contract 021, 025, 028 or 031 wrote there. Cut the statement and say in the file's header which migration owns the object (a sidecar that adds to a brain), or, if the file creates a brain rather than adds to one, list it in CORE_FUNCTION_EXCEPTIONS with its line count and the reason (FORK.md, change 58)");
  }
  for (const [rel, byFn] of CORE_FUNCTION_EXCEPTIONS) {
    for (const [fn, { why, lines }] of Object.entries(byFn)) {
      const seen = counts.get(`${rel} ${fn}`) ?? 0;
      if (seen !== lines) {
        fail(rel, seen === 0
          ? `listed as a core-function exception for '${fn}' (${why}) but matches nothing — remove it from CORE_FUNCTION_EXCEPTIONS`
          : `core-function exception for '${fn}' (${why}) covers ${lines} line(s) but ${seen} match — a new definition beside the documented one, or the exception's count is stale`);
      }
    }
  }
}


// ── 8: a credential from the environment is never compared with === ─────────
//
// SMD-1252. Seven vendored extension servers authenticated with two lines —
// `const expected = Deno.env.get("MCP_ACCESS_KEY"); if (!key || key !== expected)`
// — and then ran as the service role: one shared plaintext secret, compared
// byte by byte (the timing leak fix 14 closed in the core server), no scope,
// no revocation short of re-keying every client, and full write access on a
// key accepted from a URL query string. FORK.md change 64 made them consumers
// of server-portable/auth.ts — named, scoped, hashed keys; a read-scoped key
// is never given the tools that write — and this is what keeps the next rebase
// from bringing the two lines back. Its first run found the same compare in
// seventeen more vendored files; change 67 (SMD-1455) moved every one — the
// MCP and HTTP servers onto the module, the webhook receivers onto a
// timing-safe compare of digests — and the exception list below emptied.
//
// The rule is the MECHANISM, not the seven files' spelling: a strict or loose
// (in)equality with a value read from the environment under a credential's
// name (…KEY, …SECRET, …TOKEN, …PASSWORD) on either side — read inline, in
// any wrapping (`!== Deno.env.get("MCP_ACCESS_KEY")`, `!== (Deno.env.get(…) ??
// "")`, `Deno.env.get(…)!.trim() ===`), or through an identifier the file binds
// from a statement that contains such a read (`const expected = Deno.env.get(…)`,
// `const KEY = String(process.env.KEY ?? "").trim()`, `expected ??= …`, `const {
// API_TOKEN } = process.env`, `const { API_TOKEN: expected } = process.env`,
// Python's `os.environ`), the read spelled `Deno.env.get`, `process.env`,
// `Bun.env`, Hono's `c.env` and `env(c)` (the `hono/adapter` form, the one a
// server on Workers or Deno reaches for), a bare `env(…)`/`env.X`, or
// `os.environ` — in every
// non-binary, non-ignored file under the seven category directories and docs/,
// prose included, since a README's code block is what the next extension is
// copied from. Not a compare of the credential: `.length` (a timing-safe
// compare guards its lengths first), a call or an index on it, `typeof`, or a
// literal on the other side — nullish or empty (`if (KEY === undefined)` is a
// presence check) or a string (`if (KEY === "your-key-here")` is a placeholder
// check, a different smell). A name bound from a credential read is the
// credential for the WHOLE file: every compare of it counts, wherever it sits.
// Three review passes tried to except a re-declared name — a loop variable, a
// parameter, a destructure — and each pass found the previous pass's scoping
// both silencing real compares and failing ordinary code, because scope in
// regex over unparsed text is not a thing; the fourth took the altitude. A
// false positive here fails CI in the open and is answered with a rename or a
// counted exception; a miss is silent. Also outside the rule, by design: a
// compare of a secret the CALLER echoes — a webhook's `secret_token` — when it
// is not read from the environment on either side, and any compare routed
// through a function (`secretMatches(a, b)`, `timingSafeEqual`): the rule
// catches the operator, and a call is where the timing-safe compare lives.
// Outside the rule, and said so: `.includes`,
// `Object.is`, `switch`, `.localeCompare`, a compare through a class field or
// an object property — unless the object was bound from a statement that
// reads a credential from the environment (`const keys = { MCP_ACCESS_KEY:
// Deno.env.get(…) }`, one line or many, the shape change 67's workers use),
// whose credential-named properties, bracket reads and destructured names are
// followed; a free property clause fired on `opts.MAX_TOKENS` and
// `table.PRIMARY_KEY`, so it is anchored to those objects (not followed: a
// property assigned after the object was made, `cfg.API_KEY = process.env.API_KEY`;
// a nested one, `cfg.auth.KEY`; a literal that never closes) — a helper that
// returns the key, several declarators on
// one statement, a read through `Deno.env.toObject()` into a variable, a read
// by a non-literal name (`Deno.env.get(name)`), a parenthesised bound name
// (`(expected) === key`), a shell test (`[ "$KEY" != "$MCP_ACCESS_KEY" ]`),
// and braces or `=>` inside a string, comment or regex literal — each a
// spelling the review passes named and this rule does not chase. Exceptions are
// per file and COUNTED, as checks 6 and 7's are: a vendored file that must keep
// a compare is listed with the ticket that holds its fix, for exactly the lines
// it has today — one fixed drops out as stale, one added fails. The list has
// been empty since change 67.
const CREDENTIAL_ENV_NAME = /(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD)(?:S|_?V?\d+)?\b/i;
const IDENT = String.raw`[A-Za-z_$][\w$]*`;
/** One read of the environment; the variable's name is the first defined group. */
const ENV_READ = String.raw`(?:Deno\.env\.get\(\s*["'\x60](${IDENT})["'\x60]\s*\)|process\.env\.(${IDENT})|process\.env\[\s*["'\x60](${IDENT})["'\x60]\s*\]|\b(?:Bun|c|ctx|context)\.env\.(${IDENT})|import\.meta\.env\.(${IDENT})|(?<![\w.$])env\(\s*${IDENT}\s*\)\.(${IDENT})|(?<![\w.$])env\(\s*["'](${IDENT})["']\s*\)|(?<![\w.$])env\(\)\.(${IDENT})|(?<![\w.$])env\.(${IDENT})|os\.environ(?:\.get)?[[(]\s*["'](${IDENT})["']|os\.[gG]etenv\(\s*["'](${IDENT})["'])`;
/** An equality operator, strict or loose, and not part of `=>`, `<=`, `>=` or `!` alone. */
const EQ = String.raw`(?<![=!<>])(?:!==|===|!=|==)(?!=)`;
/** What on the far side of a compare makes it a presence or placeholder check, not a compare of the credential. */
const NOT_A_VALUE = String.raw`(?:undefined\b|null\b|None\b|"[^"\n]*"|'[^'\n]*'|` + "`[^`\n]*`" + `)`;
/** What may wrap an inline read on the left of a compare: `!`, `)`, `?? ""`, `|| ""`, `.trim()`. */
const WRAP = String.raw`(?:[!)]|\s*(?:\?\?|\|\|)\s*(?:""|'')|\.trim\(\))*`;
/** A bound name as an operand, in the wrappings a compare puts around one: `String(x)`, `(x ?? "")`, `x.trim()`, `x?.trim()`, bare — not `x.y`, `x(`, `x[` or `x?.y`; a ternary's `?` after it is fine. */
const bound = (N) => String.raw`(?:String\(\s*${N}\s*\)|\(\s*${N}\s*(?:\?\?|\|\|)\s*(?:""|'')\s*\)|${N}(?:\?\.|\.)trim\(\)|${N}\b(?!\s*(?:[.(\[]|\?\.)))`;
const envNameOf = (groups) => groups.find((g) => g !== undefined) ?? "";

/**
 * The 1-based lines of `text` that compare an environment credential with an
 * equality operator, by the rule above. Bindings are collected over the whole
 * text first, so a compare may sit above or below the read it compares.
 */
function credentialComparesIn(text) {
  const names = new Set();
  // `x = <anything on the statement containing a credential read>` — `=`, `??=`
  // and `||=`, a type annotation before it, a line break after it, a wrapper
  // (`String(…)`, `(… ?? "")`, `.trim()`) around the read.
  for (const m of text.matchAll(new RegExp(String.raw`(?<![\w$.])(${IDENT})\s*(?::[^=\n]*?)?\s*(?:\?\?|\|\|)?(?<![=!<>])=(?![=>])\s*[^;\n]*?${ENV_READ}`, "g"))) {
    if (CREDENTIAL_ENV_NAME.test(envNameOf(m.slice(2)))) names.add(m[1]);
  }
  // An object bound from a statement that reads a credential from the
  // environment — `const keys = { MCP_ACCESS_KEY: Deno.env.get("MCP_ACCESS_KEY") }`,
  // on one line or many (the binding rule above stops at the line break; this
  // walks the braces). Its credential-named properties, bracket reads and a
  // destructure from it are the credential below. Anchored to these objects
  // only: a clause over any object's upper-case properties fired on
  // `opts.MAX_TOKENS` and `table.PRIMARY_KEY`.
  const objects = new Set();
  for (const m of text.matchAll(new RegExp(String.raw`(?<![\w$.])(${IDENT})\s*(?::[^=\n]*?)?\s*=\s*\{`, "g"))) {
    let depth = 0, i = m.index + m[0].length - 1;
    for (; i < text.length; i++) { if (text[i] === "{") depth++; else if (text[i] === "}" && --depth === 0) break; }
    if (i === text.length) continue; // a literal that never closes (prose, a truncated block) binds nothing
    const block = text.slice(m.index, i + 1);
    if ([...block.matchAll(new RegExp(ENV_READ, "g"))].some((r) => CREDENTIAL_ENV_NAME.test(envNameOf(r.slice(1))))) objects.add(m[1]);
  }
  const OBJECTS = [...objects].map((o) => o.replace(/\$/g, "\\$"));
  // `const { MCP_ACCESS_KEY } = process.env` binds the env name; `{ MCP_ACCESS_KEY: expected }` binds the local one; so does a destructure from an object above.
  for (const m of text.matchAll(new RegExp(String.raw`(?:const|let|var)\s*\{([^}]*)\}\s*=\s*(?:process\.env|Deno\.env\.toObject\(\)|Bun\.env|c\.env|env\(\s*\w+\s*\)${OBJECTS.map((o) => "|" + o).join("")})(?![\w$])`, "g"))) {
    for (const part of m[1].split(",")) {
      const [envName, local] = part.split(":").map((p) => p.trim().split(/[\s=]/)[0]);
      if (envName && CREDENTIAL_ENV_NAME.test(envName)) names.add(local || envName);
    }
  }
  const lines = new Set();
  const lineOf = (i) => text.slice(0, i).split("\n").length;
  const flag = (re, keep = () => true) => {
    for (const m of text.matchAll(re)) if (keep(m)) lines.add(lineOf(m.index));
  };
  const credential = (m) => CREDENTIAL_ENV_NAME.test(envNameOf(m.slice(1)));
  flag(new RegExp(String.raw`${EQ}\s*\(*\s*${ENV_READ}`, "g"), credential);
  flag(new RegExp(String.raw`${ENV_READ}${WRAP}\s*${EQ}`, "g"), credential);
  for (const name of names) {
    const N = name.replace(/\$/g, "\\$");
    // The credential on the right: `key !== expected`, `!== expected.trim()`, `!== String(expected)`, `!== (expected ?? "")`
    // — not `expected.length`, `expected(`, `expected[`, `expected?.x`.
    flag(new RegExp(String.raw`(?<!${NOT_A_VALUE}\s*)${EQ}\s*${bound(N)}`, "g"));
    // The credential on the left: `MCP_ACCESS_KEY === key` — not `typeof MCP_ACCESS_KEY`, not against a nullish, empty or string literal.
    flag(new RegExp(String.raw`(?<![\w$.])(?<!typeof\s+)${bound(N)}\s*${EQ}(?!\s*${NOT_A_VALUE})`, "g"));
  }
  // A credential-named property of an object bound from the environment (above):
  // `keys.MCP_ACCESS_KEY`, `keys?.MCP_ACCESS_KEY`, `keys["MCP_ACCESS_KEY"]`, with
  // `.trim()` allowed. Same guards as a bound name: not `typeof`, not against a
  // nullish, empty or string literal, not `.x`, `(`, `[` after it.
  for (const O of OBJECTS) {
    const P = String.raw`(?<![\w$.])${O}(?:(?:\?\.|\.)(${IDENT})|(?:\?\.)?\[\s*["'](${IDENT})["']\s*\])(?:(?:\?\.|\.)trim\(\))?`;
    const cred = (m) => CREDENTIAL_ENV_NAME.test(m[1] ?? m[2] ?? "");
    flag(new RegExp(String.raw`(?<!${NOT_A_VALUE}\s*)${EQ}\s*${P}(?!\s*(?:[.(\[]|\?\.))`, "g"), cred);
    flag(new RegExp(String.raw`(?<!typeof\s+)${P}\s*${EQ}(?!\s*${NOT_A_VALUE})`, "g"), cred);
  }
  return [...lines].sort((a, b) => a - b);
}

/** Texts the rule must catch — the check's own negative tests, run on every run. */
const CREDENTIAL_COMPARE_PROBES = [
  'const key = c.req.query("key") || c.req.header("x-access-key");\nconst expected = Deno.env.get("MCP_ACCESS_KEY");\nif (!key || key !== expected) {',
  'const MCP_ACCESS_KEY = Deno.env.get("MCP_ACCESS_KEY")!;\n// …\nif (!provided || provided !== MCP_ACCESS_KEY) {',
  'const MCP_ACCESS_KEY = Deno.env.get("MCP_ACCESS_KEY") ?? "";\nreturn key === MCP_ACCESS_KEY;',
  'const READWISE_WEBHOOK_SECRET = Deno.env.get("READWISE_WEBHOOK_SECRET")!;\nif (body.secret !== READWISE_WEBHOOK_SECRET) {',
  'const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET;\nif (secret !== expectedSecret) {',
  'if (key !== Deno.env.get("MCP_ACCESS_KEY")) {',
  'if (req.headers.get("x-key") != process.env.API_TOKEN) {',
  'if (process.env["BRAIN_ACCESS_KEY"] === provided) ok();',
  'if key != os.environ.get("API_KEY"):',
  'if presented == os.Getenv("API_KEY") {',
  'if presented == os.getenv(\'MCP_ACCESS_KEY\'):',
  'EXPECTED = os.environ["WEBHOOK_SECRET"]\nif token == EXPECTED:',
  'const { MCP_ACCESS_KEY } = process.env;\nif (k === MCP_ACCESS_KEY) {',
  'let token: string | undefined = process.env.BOT_TOKEN;\nreturn token === presented;',
  'const expected = env("MCP_ACCESS_KEY");\nif (provided !== expected) return 401;',
  'const AUDITOR_ACCESS_KEY = Deno.env.get("AUDITOR_ACCESS_KEY")!;\nif (key !== AUDITOR_ACCESS_KEY) {',
  'return Boolean(provided && provided === MCP_ACCESS_KEY);\nconst MCP_ACCESS_KEY = Deno.env.get("MCP_ACCESS_KEY")!;',
  // What the first review pass found slipping past: a renamed destructure, Hono's
  // bindings and Bun's env, a wrapped read, a wrapped inline compare, `??=`.
  'const { MCP_ACCESS_KEY: expected } = process.env;\nif (key !== expected) {',
  'if (provided !== c.env.MCP_ACCESS_KEY) {',
  'const KEY = Bun.env.MCP_ACCESS_KEY;\nreturn key === KEY;',
  'const expected = (Deno.env.get("MCP_ACCESS_KEY") ?? "").trim();\nif (key !== expected) {',
  'const expected = String(process.env.MCP_ACCESS_KEY);\nif (key !== expected) {',
  'let expected: string | undefined;\nexpected ??= Deno.env.get("MCP_ACCESS_KEY");\nif (key !== expected) {',
  'if (key !== (Deno.env.get("MCP_ACCESS_KEY") ?? "")) {',
  'if (Deno.env.get("MCP_ACCESS_KEY")! !== key) {',
  'if (Deno.env.get("MCP_ACCESS_KEY")!.trim() === key) ok();',
  // What the second review pass found slipping past: wrappers on the bound
  // name, template quotes, import.meta.env, a suffixed name, a compare that
  // precedes a shadow rather than following one.
  'const expected = Deno.env.get("MCP_ACCESS_KEY");\nif (key.trim() !== expected.trim()) {',
  'const expected = Deno.env.get("MCP_ACCESS_KEY");\nif (key !== expected?.trim()) {',
  'const expected = Deno.env.get("MCP_ACCESS_KEY");\nif (key !== String(expected)) {',
  'const expected = Deno.env.get("MCP_ACCESS_KEY");\nif ((key ?? "") !== (expected ?? "")) {',
  'const expected = Deno.env.get(`MCP_ACCESS_KEY`);\nif (key !== expected) {',
  'if (import.meta.env.VITE_API_KEY === presented) {',
  'const expected = Deno.env.get("MCP_ACCESS_KEY_V2");\nif (key !== expected) {',
  'const token = process.env.API_TOKEN;\nif (presented === token) ok();\nfor (const token of list) use(token);',
  // What the third review pass found the shadow rule silencing: a declaration
  // whose block has closed, one in another function, one before the binding,
  // and a second binding of the same name.
  'const token = process.env.BOT_TOKEN;\nfunction lens() { return tokens.map((token) => token.length); }\nif (presented === token) ok();',
  'const secret = Deno.env.get("WEBHOOK_SECRET");\nfunction other() { for (const secret of list) use(secret); }\nif (body.secret !== secret) deny();',
  'const key = Deno.env.get("MCP_ACCESS_KEY");\nfunction lookup(key) { return map.get(key); }\nif (c.req.query("key") !== key) deny();',
  'const token = process.env.API_TOKEN;\nfor (const token of tokens) { use(token); }\nif (presented === token) ok();',
  'function a() { let expected = 0; return expected; }\nconst expected = Deno.env.get("MCP_ACCESS_KEY");\nif (key !== expected) deny();',
  'app.post("/mcp", (c) => { const expected = Deno.env.get("MCP_ACCESS_KEY"); if (k !== expected) deny(); });\napp.post("/sse", (c) => { const expected = Deno.env.get("MCP_ACCESS_KEY"); if (k !== expected) deny(); });',
  // What the fourth review pass found the (since removed) shadow rule silencing,
  // plus a ternary and a binding broken over two lines.
  'const token = process.env.API_TOKEN;\nfor (const token of tokens) if (token === close) break;\nif (presented === token) deny();',
  'const key = process.env.API_KEY;\nconst hit = list.some((key) => key === wanted);\nif (presented === key) deny();',
  'const expected = Deno.env.get("MCP_ACCESS_KEY");\nreturn key === expected ? ok() : deny();',
  'const expected = Deno.env.get("MCP_ACCESS_KEY");\nconst status = key !== expected ? 401 : 200;',
  'const expected =\n  Deno.env.get("MCP_ACCESS_KEY");\nif (k !== expected) deny();',
  // The fifth pass: Hono's adapter form.
  'import { env } from "hono/adapter";\nif (provided !== env(c).MCP_ACCESS_KEY) deny();',
  'const { MCP_ACCESS_KEY } = env(c);\nif (provided !== MCP_ACCESS_KEY) deny();',
  // Change 67's third and fourth passes: an object bound from the environment, its
  // credential-named property compared — dotted, bracketed, or destructured out of it.
  'const keys = { MCP_ACCESS_KEYS: Deno.env.get("MCP_ACCESS_KEYS"), MCP_ACCESS_KEY: Deno.env.get("MCP_ACCESS_KEY") };\nif (provided === keys.MCP_ACCESS_KEY) deny();',
  'const keys = {\n  MCP_ACCESS_KEY: Deno.env.get("MCP_ACCESS_KEY"),\n};\nif (!provided || provided !== keys.MCP_ACCESS_KEY?.trim()) deny();',
  'const keys = { MCP_ACCESS_KEY: Deno.env.get("MCP_ACCESS_KEY") };\nif (provided === keys["MCP_ACCESS_KEY"]) deny();',
  'const keys = { MCP_ACCESS_KEY: Deno.env.get("MCP_ACCESS_KEY") };\nif (provided === keys?.["MCP_ACCESS_KEY"]) deny();',
  'const keys = {\n  MCP_ACCESS_KEY: Deno.env.get("MCP_ACCESS_KEY"),\n};\nconst { MCP_ACCESS_KEY } = keys;\nif (provided !== MCP_ACCESS_KEY) deny();',
];
/** Texts the rule must not catch — ordinary code and prose. */
const CREDENTIAL_COMPARE_NON_PROBES = [
  'const MCP_ACCESS_KEY = Deno.env.get("MCP_ACCESS_KEY");\nif (!MCP_ACCESS_KEY) throw new Error("unset");',
  'const expected = process.env.BRAIN_ACCESS_KEY;\nif (key.length !== expected.length) return false;\nreturn timingSafeEqual(Buffer.from(key), Buffer.from(expected));',
  'if (process.env.OB1_STORE === "postgrest") {',
  'if (response.status !== expectedStatus) {',
  'const MCP_ACCESS_KEY = Deno.env.get("MCP_ACCESS_KEY");\nif (MCP_ACCESS_KEY === undefined) fail();',
  'const MCP_ACCESS_KEY = Deno.env.get("MCP_ACCESS_KEY") ?? "";\nif (MCP_ACCESS_KEY === "") console.warn("unset");',
  'const MCP_ACCESS_KEY = Deno.env.get("MCP_ACCESS_KEY");\nif (typeof MCP_ACCESS_KEY !== "string") fail();',
  'if (embedding.length !== EXPECTED_DIM) {',
  'const apiKey = process.env.OPENROUTER_API_KEY;\nif (args.grader === "openrouter" && !apiKey) {',
  'const key = c.req.query("key");\nif (!key) return c.json({ error: "Unauthorized" }, 401);',
  'supabase secrets set MCP_ACCESS_KEY=your-generated-key-here',
  'MCP_ACCESS_KEYS=laptop:write:<sha256 of the key>',
  'const principal = authenticateRequest(c.req.raw, { MCP_ACCESS_KEYS: Deno.env.get("MCP_ACCESS_KEYS"), MCP_ACCESS_KEY: Deno.env.get("MCP_ACCESS_KEY") });',
  'const token = process.env.TELEGRAM_BOT_TOKEN;\nif (!token) throw new Error("TELEGRAM_BOT_TOKEN is required");',
  'const expected = process.env.EXPECTED_DIM;\nif (_embedDimCache !== expected) {',
  'seven files compared the key with `!==` and are consumers of auth.ts now',
  'const secret = process.env.WEBHOOK_SECRET ?? "";\nconst ok = secret.length > 0 && timingSafeEqual(a, b);',
  'const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;\nif (key === "your-service-role-key") throw new Error("placeholder");',
  'const key = process.env.API_KEY;\nfor (const key of Object.keys(row)) if (key === "id") continue;',
  'const c = new Hono();\nif (c.env.OB1_STORE === "sql") {',
  'const expected = Deno.env.get("MCP_ACCESS_KEY");\nif (expected?.length !== 64) warn();',
  // Change 67's servers: a property of a bound principal is not the credential, and a
  // typeof test beside a bound secret is a type check, not a compare of it.
  'const principal = authenticateRequest(c.req.raw, { MCP_ACCESS_KEYS: Deno.env.get("MCP_ACCESS_KEYS") });\nif (session.scope !== principal.scope) session = undefined;',
  'const READWISE_WEBHOOK_SECRET = Deno.env.get("READWISE_WEBHOOK_SECRET")!;\nif (!secretMatches(typeof body.secret === "string" ? body.secret : null, READWISE_WEBHOOK_SECRET)) deny();',
  // A property's presence, type or absence is not a compare of it; the workers' fail-closed check.
  'const keys = { MCP_ACCESS_KEY: Deno.env.get("MCP_ACCESS_KEY") };\nif (keys.MCP_ACCESS_KEY === undefined) warn();',
  'const keys = { MCP_ACCESS_KEY: Deno.env.get("MCP_ACCESS_KEY") };\nif (typeof keys.MCP_ACCESS_KEY === "string") ok();',
  'const keys = { MCP_ACCESS_KEYS: Deno.env.get("MCP_ACCESS_KEYS"), MCP_ACCESS_KEY: Deno.env.get("MCP_ACCESS_KEY") };\nif (!keys.MCP_ACCESS_KEYS && !keys.MCP_ACCESS_KEY) return json({ error: "misconfigured" }, 503);',
  // An upper-case property with a credential suffix on an object NOT bound from the
  // environment is not the credential — the fourth pass anchored the clause after these fired.
  'if (opts.MAX_TOKENS === 4096) trim();',
  'if (col === table.PRIMARY_KEY) skip();',
  // A helper that returns the key is outside the rule, and said so above.
  'const cfg = accessKeys();\nif (k !== cfg.MCP_ACCESS_KEY) deny();',
  // An object literal that never closes binds nothing, whatever is read below it.
  'const keys = {\nconst KEY = Deno.env.get("KEY");\nif (p === keys.KEY) deny();',
];
// Empty since SMD-1455 (FORK.md change 67) moved the seventeen files check 8's
// first run found onto the shared module. The shape stays for the next audit: a
// vendored file that must keep a compare is listed with its line count and the
// ticket that holds its fix, and the count is checked both ways — one fixed
// makes its entry stale (remove it), one added beside it fails.
const CREDENTIAL_COMPARE_EXCEPTIONS = new Map([]);

function checkCredentialCompares() {
  const SELF = "scripts/check-fork-consistency.mjs";
  for (const probe of CREDENTIAL_COMPARE_PROBES) {
    // Every line of a probe that carries a compare must be caught — a probe with
    // two routes is two compares, and the second binding is not a shadow of the first.
    const expected = probe.split("\n").map((l, i) => (/(?:!==|===|!=|==)/.test(l) ? i + 1 : 0)).filter(Boolean);
    const got = credentialComparesIn(probe);
    if (expected.some((l) => !got.includes(l))) fail(SELF, `credential-compare rule no longer catches its probe (lines ${expected.join(",")}, caught ${got.join(",") || "none"}): ${JSON.stringify(probe)}`);
  }
  for (const text of CREDENTIAL_COMPARE_NON_PROBES) {
    if (credentialComparesIn(text).length > 0) fail(SELF, `credential-compare rule catches ordinary text it must not: ${JSON.stringify(text)}`);
  }
  const MSG = "compares a credential from the environment with an equality operator — one shared plaintext secret, a timing leak, no scope and no revocation; authenticate through the _shared/auth.ts beside the file (a copy of server-portable/auth.ts) as the extensions, recipes and integrations do (SMD-1252 and SMD-1455, FORK.md changes 64 and 67) — or, for a secret the caller echoes, compare digests with its secretMatches() — or list the file in CREDENTIAL_COMPARE_EXCEPTIONS with its line count and the ticket that holds its fix";
  const counts = new Map();
  for (const file of textFilesUnder(SCANNED_ROOTS)) {
    const rel = relOf(file);
    const hits = credentialComparesIn(readFileSync(file, "utf8"));
    if (hits.length === 0) continue;
    counts.set(rel, hits.length);
    if (!CREDENTIAL_COMPARE_EXCEPTIONS.has(rel)) for (const line of hits) fail(`${rel}:${line}`, MSG);
  }
  for (const [rel, { why, lines }] of CREDENTIAL_COMPARE_EXCEPTIONS) {
    const seen = counts.get(rel) ?? 0;
    if (seen !== lines) {
      fail(rel, seen === 0
        ? `listed as a credential-compare exception (${why}) but matches nothing — remove it from CREDENTIAL_COMPARE_EXCEPTIONS`
        : `credential-compare exception (${why}) covers ${lines} line(s) but ${seen} match — a new compare beside the documented one, or the exception's count is stale`);
    }
  }
}

// ── 10: a thought's content or vector is written only through the functions ──
//
// SMD-1228. Three integrations named in FORK.md changes 38 and 40 updated a
// thought's `content` or `embedding` with a raw PostgREST `.update(…)` on
// `thoughts` rather than through `update_thought` — and the audit for this
// check found nine files with eleven such statements: the two MCP servers
// (`update-thought-mcp`, `enhanced-mcp`), three HTTP APIs
// (`agent-memory-api`, `open-brain-rest`, `rest-api`), a worker
// (`consolidation-workers/bio`), a recipe's server (`repo-learning-coach`), a
// recipe's paste-in snippet (`provenance-chains`) and a README's sample
// (`telegram-capture`). Every rule the fork put into the
// writers is bypassed by such a statement: 003/018's fingerprint is left
// describing the old text (018's `fingerprint_held_by` report exists for the
// row it leaves), 021's label is left describing the old vector, 022's chunk
// rows of the old vector stay under the new one, and 008's actor is not set.
// FORK.md change 69 routed every one through `update_thought` (edits) or the
// 3-argument `upsert_thought` (captures, the vector and its label in one
// call); this is what keeps the next rebase from bringing one back.
//
// The rule is the MECHANISM: a PostgREST table verb that replaces columns —
// `.update(` or `.upsert(` — on `thoughts` (`.from("thoughts")`, either
// quote, or Python's `.table("thoughts")`, whitespace and line breaks
// allowed before the verb), whose payload carries a `content` or `embedding`
// key: an object literal (quoted, bare or computed key, the shorthand
// `{ embedding }`, an array of literals for an upsert, an `Object.assign(…)`
// of literals), or an identifier the file binds to one (`const update = {
// embedding, … }`, `Object.assign(patch, { … })`, `updates.content = …`,
// `patch["embedding"] = …`, anywhere in the file) — a key, not a value
// (`summary: content` is not one), at the literal's top level (`{ metadata: {
// content } }` is a metadata write); a row type on the client and a line
// comment before the verb do not hide it; and the SQL form, `UPDATE [ONLY]
// thoughts … SET` — `public.`, quoted identifiers and an alias allowed — with
// `content =` or `embedding =` in the SET list before its WHERE, or either
// name in the tuple form `SET (…) = (…)`. Word-bounded:
// `content_fingerprint =` and `embedding_model =` are other columns (023's
// backfill and the fingerprint recipe's are theirs to write). In every
// non-binary, non-ignored file under the seven category directories and
// docs/, prose included — a README's code block is what the next integration
// is copied from. SMD-1524 (change 71) added the fresh row: `.insert(` with
// either key (a literal, an array of literals, a bound name — one filled by
// `x.push({ … })` or Python's `x.append({ … })` too), and the SQL
// `INSERT INTO [public.]thoughts [AS alias] (<columns>)` naming either column
// — a row written around the 3-argument upsert_thought has no fingerprint
// (003: 016's trigger does not fill it; the row is invisible to dedup until
// 023's backfill and a later capture of the text makes a twin), no model
// label (021: a vector of unknown model, which the re-embed pool treats as
// not at the target), and no actor for 008. Not in the rule, and said so: an
// INSERT with no column list (`INSERT INTO thoughts VALUES …`, `INSERT INTO
// thoughts SELECT …`, a client's `${sql(rows)}` helper), a metadata-only update
// (nothing it leaves stale), a REST `PATCH …/rest/v1/thoughts` built by hand
// (none in the tree), a payload spread from another object (`{ ...updates }`),
// a payload that arrives as a function's return value or parameter, a builder
// split across statements (`const q = supabase.from("thoughts"); q.update(…)`),
// a table name held in a variable, a payload behind a type assertion or a
// conditional (`.update(<any>p)`, `.update(cond ? { content } : {})`), a
// two-hop `Object.assign({}, a, b)` of bound names, Python's
// `dict(content=…)`, a list built by comprehension from a function's return
// (`[build_row(h) for h in batch]` — readwise-import's, converted by hand and
// held by test-writes.ts's text guard), and an `.rpc("update_thought", …)` or
// `.rpc("upsert_thought", …)`, which is the remedy — the dataflow cases need
// what this rule does not have, and a miss there is what the second half of
// the audit, extensions/test-writes.ts, is for. Exceptions are per file and
// COUNTED, as checks 6–8's are: a file that deliberately writes around the
// functions is listed with the reason and the line count, and its README must
// say what its rows lack; one fixed drops out as stale, one added fails. Seven
// today, none a bypass a fix could remove: three deployments whose database is
// their own (the fork's functions are not in it — two of them the files check 7
// excepts for creating a brain), the two guides and the one container init that
// show an upsert_thought body (the INSERT is the function's own), and the test
// that plants a row as an older write left it, to be moved by the writer under test.
/** The table, as PostgREST's client (with a row type), the SQL shim or Python's client name it. */
const THOUGHTS_TABLE = String.raw`\.(?:from|from_|table)(?:<[^>\n]*>)?\s*\(\s*["'\x60]thoughts["'\x60]\s*\)`;
/** What may sit between the table and its verb: whitespace, line and block comments. */
const GAP = String.raw`(?:\s|//[^\n]*|/\*[\s\S]*?\*/)*`;
/**
 * A `content` or `embedding` KEY of an object literal: `content:`, `"embedding":`,
 * `["content"]:`, the shorthand `{ embedding }` / `content,`. A key follows `{`
 * or `,`; a name after `:` is a value (`summary: content`), not a key. Tested
 * on a literal's top level only — see topLevel() — so `{ metadata: { content } }`
 * is a metadata write.
 */
const PAYLOAD_KEY = /(?:^|[{,])\s*(?:["'\x60]?(?:content|embedding)["'\x60]?|\[\s*["'\x60](?:content|embedding)["'\x60]\s*\])\s*(?::|,|\})/;
/**
 * Walk the characters of `text` from `open`, calling `visit(ch, i, inString)` for every character;
 * a `"`, `'` or backtick run is a string (escapes honoured), so a brace inside
 * one is not structure — `{ note: "}", content }` closes where the code says.
 */
function walkChars(text, open, visit) {
  let quote = null;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\") { visit(ch, i, true); visit(text[++i] ?? "", i, true); continue; }
      if (ch === quote) quote = null;
      visit(ch, i, true);
    } else {
      if (ch === '"' || ch === "'" || ch === "\x60") quote = ch;
      if (visit(ch, i, false) === false) return;
    }
  }
}
/** The brace- or bracket-balanced block that opens at `text[open]`, or null when it never closes. */
function blockAt(text, open) {
  let depth = 0, end = -1;
  walkChars(text, open, (ch, i, inString) => {
    if (inString) return;
    if (ch === "{" || ch === "[") depth++;
    else if ((ch === "}" || ch === "]") && --depth === 0) { end = i; return false; }
  });
  return end < 0 ? null : text.slice(open, end + 1);
}
/**
 * `block` with everything nested deeper than `depth` blanked — an object's own
 * keys at 1, an array's elements' keys at 2. A `[` that follows `{` or `,` is a
 * computed key (`{ ["content"]: x }`), not a nested value, and stays at its depth.
 */
function topLevel(block, depth = 1) {
  let d = 0, out = "", last = "";
  const nests = [];
  walkChars(block, 0, (ch, _i, inString) => {
    if (!inString && (ch === "{" || ch === "[")) {
      const nest = ch === "{" || !(last === "{" || last === ",");
      nests.push(nest);
      if (nest) d++;
      out += d <= depth ? ch : " ";
    } else if (!inString && (ch === "}" || ch === "]")) {
      out += d <= depth ? ch : " ";
      if (nests.pop() !== false) d--;
    } else out += d <= depth ? ch : " ";
    if (!/\s/.test(ch)) last = ch;
  });
  return out;
}
/**
 * SQL from a statement's head onward with its dash-dash line comments and
 * slash-star block comments blanked (newlines kept), and a single-quoted
 * string's text blanked between its quotes — a dash pair, a comma or a column
 * name inside one is text: a column named in a comment or a string is not a
 * column, one beside a comment is, and a comment's own `;`, `WHERE` or `(` no
 * longer ends the list early — the three review passes.
 * Started at the head, where the text is SQL, so a quote in the prose before
 * it does not open a string.
 */
function sqlUncommented(sqlText) {
  let out = "", i = 0, quote = false, escapes = false, ident = false;
  while (i < sqlText.length) {
    const ch = sqlText[i];
    if (quote) {
      // An E'…' string reads a backslash-escaped quote as text (the fourth review pass).
      if (escapes && ch === "\\") { out += "  "; i += 2; continue; }
      out += ch === "'" || ch === "\n" ? ch : " "; if (ch === "'") quote = false; i++; continue;
    }
    // A "quoted identifier" is a name, read whole: a dash pair inside it is not a comment (the fourth review pass).
    if (ident) { out += ch; if (ch === '"') ident = false; i++; continue; }
    if (ch === '"') { ident = true; out += ch; i++; continue; }
    if (ch === "'") { quote = true; escapes = /[eE]$/.test(out.slice(-1)) && !/\w/.test(out.slice(-2, -1)); out += ch; i++; continue; }
    if (ch === "-" && sqlText[i + 1] === "-") { while (i < sqlText.length && sqlText[i] !== "\n") { out += " "; i++; } continue; }
    if (ch === "/" && sqlText[i + 1] === "*") {
      const end = sqlText.indexOf("*/", i + 2);
      const stop = end < 0 ? sqlText.length : end + 2;
      for (; i < stop; i++) out += sqlText[i] === "\n" ? "\n" : " ";
      continue;
    }
    out += ch; i++;
  }
  return out;
}
/** The text from `from` on, comments blanked, as far as a statement can reasonably run: 4000 characters (the longest in the tree is under 400). */
const sqlFrom = (text, from) => sqlUncommented(text.slice(from, from + 4000));
/** Whether a literal opening at `text[open]` — `{…}` or `[{…}, …]` — carries either key at the level a table verb reads. */
const literalCarries = (text, open) => {
  const block = blockAt(text, open);
  return block !== null && PAYLOAD_KEY.test(topLevel(block, text[open] === "[" ? 2 : 1));
};

/**
 * The 1-based lines of `text` that write a thought's content or vector around
 * the functions, by the rule above. Bindings are collected over the whole text
 * first, so a payload may be filled above or below the verb that sends it — and
 * a name bound to such a payload is one for the WHOLE file, as check 8's bound
 * credential is: scope in regex over unparsed text is not a thing, and a hit on
 * a second, cleaner send of the same name is answered with a rename.
 */
function thoughtWritesAroundIn(text) {
  const lineOf = (i) => text.slice(0, i).split("\n").length;
  const lines = new Set();
  // Identifiers bound to a payload with either key: `x = { … content … }` or
  // `x = [{ … }]` (the block walked), `Object.assign(x, { … })`, `x.push({ … })`,
  // `x.content = …`, `x.embedding ??= …`, `x.content += …`, `x["embedding"] = …`.
  const payloads = new Set();
  for (const m of text.matchAll(new RegExp(String.raw`(?<![\w$.])(${IDENT})\s*(?::[^=\n]*?)?\s*=\s*([{[])`, "g"))) {
    if (literalCarries(text, m.index + m[0].length - 1)) payloads.add(m[1]);
  }
  for (const m of text.matchAll(new RegExp(String.raw`Object\.assign\(\s*(${IDENT})\s*,\s*\{`, "g"))) {
    if (literalCarries(text, m.index + m[0].length - 1)) payloads.add(m[1]);
  }
  // A list filled one literal at a time — `rows.push({ … })`, Python's `rows.append({ … })` — is an array of them (SMD-1524).
  for (const m of text.matchAll(new RegExp(String.raw`(?<![\w$.])(${IDENT})\.(?:push|append)\(\s*\{`, "g"))) {
    if (literalCarries(text, m.index + m[0].length - 1)) payloads.add(m[1]);
  }
  for (const m of text.matchAll(new RegExp(String.raw`(?<![\w$.])(${IDENT})!?(?:\.(?:content|embedding)|\[\s*["'\x60](?:content|embedding)["'\x60]\s*\])\s*(?:\?\?|\|\||\+)?=(?![=>])`, "g"))) {
    payloads.add(m[1]);
  }
  // The verb — `.update(`, `.upsert(`, or, since SMD-1524, `.insert(` (a type
  // argument allowed): its first argument a literal, a bound name, or an
  // `Object.assign(…)` whose own literals — not the ones nested in them — are read.
  for (const m of text.matchAll(new RegExp(String.raw`${THOUGHTS_TABLE}${GAP}\.(update|upsert|insert)(?:<[^>\n]*>)?\(\s*(?:([{[])|Object\.assign\(|(${IDENT}))`, "g"))) {
    const verbAt = m.index + m[0].lastIndexOf("." + m[1]);
    let hit = false;
    if (m[2]) hit = literalCarries(text, m.index + m[0].length - 1);
    else if (m[3]) hit = payloads.has(m[3]);
    else {
      // The assign's argument list, parens read as brackets so blockAt() spans it; each `{` at its top level is a literal it merges.
      const parens = text.replace(/[()]/g, (c) => (c === "(" ? "[" : "]"));
      const args = blockAt(parens, m.index + m[0].length - 1) ?? "";
      let d = 0;
      walkChars(args, 0, (ch, i, inString) => {
        if (inString) return;
        if (ch === "{" && d === 1 && literalCarries(args, i)) hit = true;
        if (ch === "{" || ch === "[") d++;
        else if (ch === "}" || ch === "]") d--;
      });
    }
    if (hit) lines.add(lineOf(verbAt));
  }
  // SQL: `UPDATE [ONLY] [public.]thoughts [[AS] alias] SET <list>` up to WHERE/RETURNING/;, identifiers
  // quoted or not — the list naming either column as an assignment target, or the tuple form `SET (a, b) = …`.
  // The head is found in the text; the list is read from the text with its comments blanked, so a
  // comment's `;` or `WHERE` does not end it (the third review pass).
  for (const m of text.matchAll(/\bUPDATE\s+(?:ONLY\s+)?(?:"?public"?\.)?"?thoughts"?(?![\w"])(?:\s+(?:AS\s+)?(?!SET\b)\w+)?\s+SET\b/gi)) {
    const list = /^([\s\S]*?)(?=\bWHERE\b|\bRETURNING\b|;|$)/.exec(sqlFrom(text, m.index + m[0].length))[1];
    const tuple = /^\s*\(([^)]*)\)\s*=/.exec(list);
    // An assignment TARGET: first in the list or after a comma — `SET summary = CASE WHEN content = 'x'` compares, it does not assign.
    if (tuple ? /(?:^|[\s,(])"?(?:content|embedding)"?\s*(?:,|$)/i.test(tuple[1]) : /(?:^|,)\s*"?(?:content|embedding)"?\s*=(?!=)/i.test(list)) lines.add(lineOf(m.index));
  }
  // SQL: `INSERT INTO [public.]thoughts [[AS] alias] (<columns>)` — the column list naming either
  // column (SMD-1524). No list, no rule: `INSERT INTO thoughts VALUES …` and `… SELECT …` say nothing.
  for (const m of text.matchAll(/\bINSERT\s+INTO\s+(?:"?public"?\.)?"?thoughts"?(?![\w"])(?:\s+(?:AS\s+)?(?!VALUES\b|SELECT\b)\w+)?\s*\(/gi)) {
    const list = /^([^()]*)\)/.exec(sqlFrom(text, m.index + m[0].length));
    if (list && /(?:^|[\s,])"?(?:content|embedding)"?\s*(?:,|$)/i.test(list[1])) lines.add(lineOf(m.index));
  }
  return [...lines].sort((a, b) => a - b);
}

/** Texts the rule must catch — the nine files' eleven updates and the eight files' inserts, one probe each, the forms a rebase could bring, and the review passes' escapes. */
const THOUGHT_WRITE_PROBES = [
  // update-thought-mcp: a payload filled by property assignment, sent by name, verb on its own line.
  'const updates: Record<string, unknown> = {};\nif (content !== undefined) {\n  updates.content = content;\n  updates.embedding = `[${embedding.join(",")}]`;\n}\nconst { data, error } = await supabase\n  .from("thoughts")\n  .update(updates)\n  .eq("id", id)\n  .select("id")\n  .single();',
  // enhanced-mcp: a literal over several lines, with the file\'s own fingerprint beside the content.
  'const { error: updateError } = await supabase\n  .from("thoughts")\n  .update({\n    content,\n    content_fingerprint: fingerprint,\n    embedding,\n    type: extracted.type,\n    updated_at: new Date().toISOString(),\n  })\n  .eq("id", id);',
  // agent-memory-api and repo-learning-coach: the vector alone, after a 2-argument upsert.
  'if (thoughtId) await supabase.from("thoughts").update({ embedding }).eq("id", thoughtId);',
  "const { error: embeddingError } = await supabase\n  .from('thoughts')\n  .update({ embedding })\n  .eq('id', thoughtId)",
  // open-brain-rest: a literal bound to a name, then sent.
  'const update = {\n  embedding,\n  metadata,\n  type,\n  status,\n};\nconst { error } = await supabase.from("thoughts").update(update).eq("id", thoughtId);',
  'const update: Record<string, unknown> = { metadata };\nif (parsed.data.content !== undefined) {\n  update.content = parsed.data.content;\n  update.embedding = await getEmbedding(parsed.data.content);\n}\nconst { error } = await supabase.from("thoughts").update(update).eq("id", id);',
  // rest-api: a typed record bound with the content, the vector added when it came.
  'const updates: Record<string, unknown> = { content, updated_at: new Date().toISOString() };\nif (embedding) updates.embedding = embedding;\nconst { error: updateErr } = await supabase.from("thoughts").update(updates).eq("id", id);',
  'const columnUpdates: Record<string, unknown> = { metadata: existingMetadata };\nif (enriched.embedding) columnUpdates.embedding = enriched.embedding;\nawait supabase.from("thoughts").update(columnUpdates).eq("id", thoughtId);',
  // consolidation-bio: the profile rewrite, a literal over several lines with the text first.
  'const { error: updateError } = await supabase\n  .from("thoughts")\n  .update({\n    content: profileContent,\n    type: "person_note",\n    importance: 5,\n    metadata: profileMetadata,\n    updated_at: now,\n  })\n  .eq("id", existingId);',
  // provenance-chains: a patch that starts as the vector and grows.
  'const patch: Record<string, unknown> = { embedding };\nif (supersedes) patch.supersedes = supersedes;\nconst { error: patchError } = await supabase\n  .from("thoughts")\n  .update(patch)\n  .eq("id", thoughtId);',
  // telegram-capture\'s sample: content and vector in one literal.
  'const { error } = await supabase\n  .from("thoughts")\n  .update({\n    content: messageText,\n    embedding,\n    metadata: { ...metadata, edited: true },\n  })\n  .eq("id", existing[0].id);',
  // The forms a rebase could bring: quoted keys, a bracket assignment, upsert, Python, SQL with an alias, SQL over lines.
  'await supabase.from("thoughts").update({ "embedding": vec }).eq("id", id);',
  'patch["content"] = text;\nawait supabase.from("thoughts").update(patch).eq("id", id);',
  "await supabase.from('thoughts').upsert({ id, content, embedding });",
  'supabase.table("thoughts").update({"content": content, "embedding": embedding}).eq("id", thought_id).execute()',
  'UPDATE thoughts SET content = $2, embedding = $3, updated_at = now() WHERE id = $1;',
  'UPDATE public.thoughts t\nSET embedding = e.vec,\n    updated_at = now()\nFROM embeddings e\nWHERE t.id = e.thought_id;',
  'UPDATE thoughts AS t SET content = trim(t.content) WHERE t.content <> trim(t.content);',
  // The first review pass's escapes: a row type on the client, a comment before the verb,
  // Object.assign into a bound name and inline, an array payload bound or inline, a computed
  // key, Python's from_, UPDATE ONLY, quoted identifiers, the tuple form.
  'await supabase.from<Thought>("thoughts").update({ content, embedding }).eq("id", id);',
  'await supabase\n  .from("thoughts") // the row\n  .update({ content })\n  .eq("id", id);',
  'const patch: Record<string, unknown> = {};\nObject.assign(patch, { embedding });\nawait supabase.from("thoughts").update(patch).eq("id", id);',
  'await supabase.from("thoughts").update(Object.assign({}, base, { content })).eq("id", id);',
  'const rows = [{ id, content, embedding }];\nawait supabase.from("thoughts").upsert(rows, { onConflict: "id" });',
  'await supabase.from("thoughts").upsert([{ id, content }]);',
  'await supabase.from("thoughts").update({ ["content"]: text }).eq("id", id);',
  "supabase.from_('thoughts').update({'content': content}).eq('id', thought_id).execute()",
  'UPDATE ONLY thoughts SET embedding = $2 WHERE id = $1;',
  'UPDATE "public"."thoughts" SET "content" = $2 WHERE "id" = $1;',
  'UPDATE thoughts SET (content, embedding) = ($2, $3) WHERE id = $1;',
  // The second review pass's escapes: a type argument on the verb, a block comment before it, a
  // space before the table's paren, a string value with an unbalanced brace before the key, a
  // backtick key, a backtick bracket assignment, an upsert chain (its line is the verb's).
  'await supabase.from("thoughts").update<Thought>({ content }).eq("id", id);',
  'await supabase\n  .from("thoughts")\n  /* the row */\n  .update({ content })\n  .eq("id", id);',
  'await supabase.from ("thoughts").update({ embedding }).eq("id", id);',
  'await supabase.from("thoughts").update({ note: "}", content }).eq("id", id);',
  'await supabase.from("thoughts").update({ [`embedding`]: vec }).eq("id", id);',
  'const p: Record<string, unknown> = {};\np[`content`] = text;\nawait supabase.from("thoughts").update(p).eq("id", id);',
  // SMD-1524: the fresh row. The Slack/Telegram samples' literal (the non-probe change 69 carried,
  // moved here); readwise-capture's, with the enhanced columns beside the vector; consolidation-bio's,
  // with the file's own fingerprint and no vector; the classification recipe's, content alone; the
  // Python client's dict; a list filled by append, sent by name; a list pushed, sent by name; an
  // array literal; a bound array; the Kubernetes server's SQL with casts; the Neon recipe's template
  // over lines; quoted identifiers with a schema; an alias; INSERT … SELECT with a column list.
  'await supabase.from("thoughts").insert({ content, embedding, metadata });',
  'const { error } = await supabase.from("thoughts").insert({\n  content,\n  embedding,\n  source_type: "readwise",\n  type: "reference",\n  metadata: {\n    source: "readwise",\n    readwise_highlight_id: event.id,\n  },\n});',
  'const { data, error: insertError } = await supabase\n  .from("thoughts")\n  .insert({\n    content: profileContent,\n    type: "person_note",\n    importance: 5,\n    metadata: profileMetadata,\n    content_fingerprint: contentFingerprint,\n  })\n  .select("id")\n  .single();',
  'await db.from("thoughts").insert({\n  content: classified.title,\n  type: classified.type,\n  created_at: new Date().toISOString(),\n});',
  'supabase.table("thoughts").insert({"content": content, "embedding": embedding, "metadata": meta}).execute()',
  'rows = []\nfor h in highlights:\n    rows.append({"content": h["text"], "embedding": h["vec"]})\nsupabase.table("thoughts").insert(rows).execute()',
  'const rows: Record<string, unknown>[] = [];\nrows.push({ content, embedding });\nawait supabase.from("thoughts").insert(rows);',
  'await supabase.from("thoughts").insert([{ content: a, embedding: va }, { content: b, embedding: vb }]);',
  'const batch = [{ content, embedding, metadata }];\nconst { error } = await supabase.from("thoughts").insert(batch);',
  'await client.queryObject(\n  `INSERT INTO thoughts (content, embedding, metadata)\n   VALUES ($1, $2::vector, $3::jsonb)`,\n  [content, embStr, JSON.stringify(meta)]\n);',
  'const rows = await sql`\n  INSERT INTO thoughts (content, embedding, metadata, source)\n  VALUES (${content}, ${embeddingStr}::vector, ${metadataStr}::jsonb, ${source})\n  RETURNING id\n`;',
  'INSERT INTO "public"."thoughts" ("content", "metadata") VALUES ($1, $2);',
  'INSERT INTO thoughts AS t (content, embedding) VALUES ($1, $2::vector) ON CONFLICT DO NOTHING;',
  'INSERT INTO thoughts (content, metadata) SELECT body, \'{}\'::jsonb FROM staging;',
  // The first review pass: a column list over lines with a comment beside a column.
  'INSERT INTO thoughts (\n  content, -- the text\n  metadata\n) VALUES ($1, $2);',
  // The second review pass: a comment after the comma in a SET list, a block comment beside a column.
  'UPDATE thoughts SET metadata = $1, -- note\n  content = $3 WHERE id = $2;',
  'INSERT INTO thoughts (content /* the text */, metadata) VALUES ($1, $2);',
  // The third review pass: a comment whose text would end the list — a `;`, a WHERE, a paren — and a
  // dash pair inside a string beside a real target.
  'UPDATE thoughts SET metadata = $1, -- v2; was v1\n  content = $2 WHERE id = $3;',
  'UPDATE thoughts SET metadata = $1 -- where content lives\n, content = $2 WHERE id = $3;',
  'INSERT INTO thoughts (content, -- (the text)\n  metadata) VALUES ($1, $2);',
  "UPDATE thoughts SET summary = 'a -- b', content = $2 WHERE id = $1;",
  'UPDATE thoughts SET metadata = $1 /* where */ , embedding = $2 WHERE id = $3;',
  'INSERT INTO thoughts (metadata /* (note) */, content) VALUES ($1, $2);',
  // The fourth review pass: a doubled quote, an E-string's escaped quote and a dash pair inside a
  // quoted identifier, each beside a real target.
  "UPDATE thoughts SET summary = 'it''s', content = $2 WHERE id = $1;",
  "UPDATE thoughts SET summary = E'a\\'b', content = $2 WHERE id = $1;",
  'UPDATE thoughts SET "note--x" = $1, content = $2 WHERE id = $3;',
];
/** Texts the rule must not catch — the remedy, the other columns, the other tables, reads, prose. */
const THOUGHT_WRITE_NON_PROBES = [
  'const { data, error } = await supabase.rpc("update_thought", { p_id: id, p_content: content, p_embedding: embedding, p_embedding_model: EMBEDDING_MODEL });',
  'await supabase.rpc("upsert_thought", { p_content: content, p_payload: { metadata, embedding_model: model }, p_embedding: embedding });',
  'await supabase.from("thoughts").update({ metadata: updatedMeta }).eq("id", survivorId);',
  'await supabase.from("thoughts").update({ status: "new", status_updated_at: new Date().toISOString() }).eq("id", id);',
  'const sidecar = { type: extracted.type, sensitivity_tier: resolvedTier, importance: 3 };\nawait supabase.from("thoughts").update(sidecar).eq("id", id);',
  'const { data } = await supabase.from("thoughts").select("id, content, embedding, metadata").eq("id", id).single();',
  'await supabase.from("thought_chunks").update({ content: window }).eq("id", chunkId);',
  'await supabase.from("agent_memories").update({ content: row.content, summary }).eq("id", id);',
  'const updates: Record<string, unknown> = {};\nupdates.type = sanitizeType(String(body.type));\nawait supabase.from("thoughts").update(updates).eq("id", id);',
  'UPDATE thoughts\nSET content_fingerprint = encode(sha256(convert_to(lower(trim(content)), \'UTF8\')), \'hex\')\nWHERE content_fingerprint IS NULL;',
  'UPDATE thoughts SET embedding_model = NULL WHERE embedding IS NULL;',
  "UPDATE thoughts SET metadata = metadata || '{\"source\": \"mcp\"}'::jsonb WHERE metadata->>'source' IS NULL;",
  "UPDATE public.thoughts\nSET type = metadata->>'type'\nWHERE type IS NULL AND metadata->>'type' IS NOT NULL;",
  'UPDATE public.thoughts t\nSET supersedes = NULL\nFROM public.thought_edges te\nWHERE te.to_thought_id = t.id;',
  'UPDATE thoughts SET updated_at = now() WHERE id = $1 RETURNING content, embedding;',
  'a raw UPDATE of the vector around them is the operator\'s, as 021 says',
  'the hasher: createHash("sha256").update(content).digest("hex")',
  'const { error } = await supabase.from("thoughts").update({ ...updates }).eq("id", id);',
  // The first review pass's false positives: a bare name as a VALUE, a nested object, an
  // assignment whose right side is the column.
  'await supabase.from("thoughts").update({ summary: content }).eq("id", id);',
  'const sidecar = { type: t, note: embedding };\nawait supabase.from("thoughts").update(sidecar).eq("id", id);',
  'await supabase.from("thoughts").update({ metadata: { content: "x", embedding: null } }).eq("id", id);',
  'UPDATE thoughts SET summary = content, reviewed = true WHERE id = $1;',
  "UPDATE thoughts SET metadata = jsonb_set(metadata, '{content}', to_jsonb(summary)) WHERE id = $1;",
  'UPDATE thoughts SET metadata = metadata || jsonb_build_object(\'embedding\', 1) WHERE id = $1;',
  // The second review pass's false positives: a column compared inside a CASE in the SET list, a
  // nested object inside an inline Object.assign.
  "UPDATE thoughts SET summary = CASE WHEN content = 'x' THEN 'y' ELSE summary END WHERE id = $1;",
  'await supabase.from("thoughts").update(Object.assign({}, base, { metadata: { content: "x" } })).eq("id", id);',
  // SMD-1524: inserts that are not the rule's — another table, the other columns, no column list,
  // a metadata-only row, the function's own remedy, prose naming the statement, a chunk row.
  'INSERT INTO thought_chunks (thought_id, chunk_index, content, embedding) VALUES ($1, 0, $2, $3::vector);',
  'INSERT INTO thoughts (id, content_fingerprint, embedding_model, created_at) VALUES ($1, $2, $3, now());',
  'INSERT INTO thoughts VALUES ($1, $2, $3);',
  "INSERT INTO thoughts SELECT * FROM thoughts_staging;",
  'await supabase.from("thoughts").insert({ metadata: { source: "import" } });',
  'await supabase.from("readwise_books").insert({ content: note, title });',
  'await supabase.from("consolidation_log").insert({ operation: "profile", details: { content: "x" } });',
  'Any code path that writes a raw `INSERT INTO thoughts` — a webhook handler — will insert a row with a NULL fingerprint.',
  'await supabase.rpc("upsert_thought", { p_content: content, p_payload: { metadata: meta, embedding_model: EMBEDDING_MODEL }, p_embedding: embedding });',
  'thoughts = [build_thought(h, book) for h in batch]\nsupabase.table("thoughts").insert(thoughts).execute()',
  // The first review pass: a comment naming the column is not the column.
  'INSERT INTO thoughts (\n  metadata -- not content\n) VALUES ($1);',
  // The second review pass: the same in a block comment, and in a SET list.
  'INSERT INTO thoughts (metadata /* content */) VALUES ($1);',
  'UPDATE thoughts SET metadata = $1 /* content = $3, */ WHERE id = $2;',
  // The third review pass: the column named inside a string is text, not a target.
  "UPDATE thoughts SET summary = 'x -- content = 1' WHERE id = $1;",
  "UPDATE thoughts SET summary = 'see, content = old' WHERE id = $1;",
];
const OWN_DATABASE = (what) => ({ why: `${what} — the fork's functions are not in it, so the capture is a raw row with no fingerprint, no label and no audit actor; the README says so`, lines: 1 });
const THOUGHT_WRITE_EXCEPTIONS = new Map([
  // The guides that show upstream's upsert_thought body: the INSERT is the function's own (check 7 excepts the same lines).
  ["docs/01-getting-started.md", { why: "the INSERT inside upstream's upsert_thought definition, the function itself, shown as the guide's; SETUP.md sends this fork's readers past it", lines: 1 }],
  ["recipes/content-fingerprint-dedup/README.md", { why: "the INSERT inside the upsert_thought definition migration 003 was extracted from, kept as its record", lines: 1 }],
  // Two deployments whose database is their own, built from the guide's shape.
  ["integrations/kubernetes-deployment/index.ts", OWN_DATABASE("its own Postgres in the cluster, built by k8s/init.sql")],
  ["recipes/vercel-neon-telegram/src/lib/db.ts", OWN_DATABASE("its own Neon database, built by sql/001-create-thoughts.sql")],
  ["recipes/schema-aware-routing/index.ts", OWN_DATABASE("its own five-table project, built by its README's SQL (a `thoughts` with domain/status/source columns)")],
  // The recipe's own container: its upsert_thought body, the guide's shape — the INSERT is the function's own.
  ["recipes/local-brain-no-mcp/volumes/db/init/02-match-thoughts-fn.sh", { why: "the INSERT inside the recipe's own upsert_thought, in its own container's init (check 7 excepts the same definition); the README says what its rows lack", lines: 1 }],
  // The fixture: a row as an older write left it — fingerprint and label by hand — for the writer under test to move.
  ["extensions/test-writes.ts", { why: "plants a thought as an older write left it, fingerprint and label supplied by hand, for the writer under test to move whole", lines: 1 }],
]);

function checkThoughtWritesAround() {
  const SELF = "scripts/check-fork-consistency.mjs";
  for (const probe of THOUGHT_WRITE_PROBES) {
    // Caught on exactly one line, and that line is the verb's (or the UPDATE's): the second review
    // pass found an upsert chain reported on the line before its verb, which a count alone passed.
    const got = thoughtWritesAroundIn(probe);
    const verbLine = probe.split("\n").findIndex((l) => /\.(?:update|upsert|insert)\b/.test(l) || /\b(?:UPDATE\s+(?:ONLY\s+)?|INSERT\s+INTO\s+)"?(?:public|thoughts)\b/i.test(l)) + 1;
    if (got.length !== 1 || got[0] !== verbLine) fail(SELF, `thought-write rule no longer catches its probe on its verb's line ${verbLine} (caught ${got.join(",") || "none"}): ${JSON.stringify(probe)}`);
  }
  for (const text of THOUGHT_WRITE_NON_PROBES) {
    if (thoughtWritesAroundIn(text).length > 0) fail(SELF, `thought-write rule catches ordinary text it must not: ${JSON.stringify(text)}`);
  }
  const MSG = "writes a thought's content or vector around the functions that own them — the fingerprint (003/018), the model label (021) and the chunk rows (022) are left describing the text and vector before the write, and no actor reaches the audit (008); route an edit through update_thought(p_id, p_content, p_metadata_patch, p_embedding, …, p_embedding_model) and a capture — an insert too — through the 3-argument upsert_thought with embedding_model in the payload, the columns it does not know by an update carrying neither content nor vector (FORK.md changes 69 and 70, SMD-1228 and SMD-1524) — or list the file in THOUGHT_WRITE_EXCEPTIONS with its line count and the reason, and say in its README what its rows lack";
  const counts = new Map();
  for (const file of textFilesUnder(SCANNED_ROOTS)) {
    const rel = relOf(file);
    const hits = thoughtWritesAroundIn(readFileSync(file, "utf8"));
    if (hits.length === 0) continue;
    counts.set(rel, hits.length);
    if (!THOUGHT_WRITE_EXCEPTIONS.has(rel)) for (const line of hits) fail(`${rel}:${line}`, MSG);
  }
  for (const [rel, { why, lines }] of THOUGHT_WRITE_EXCEPTIONS) {
    const seen = counts.get(rel) ?? 0;
    if (seen !== lines) {
      fail(rel, seen === 0
        ? `listed as a thought-write exception (${why}) but matches nothing — remove it from THOUGHT_WRITE_EXCEPTIONS`
        : `thought-write exception (${why}) covers ${lines} line(s) but ${seen} match — a new write beside the documented one, or the exception's count is stale`);
    }
  }
}

// ── 11: a file on the SQL shim runs under Bun ────────────────────────────────
//
// SMD-1480 (FORK.md change 74). The shim imports `bun`, and the files fix 13's
// codemod put on it were Supabase Edge Functions — `Deno.env.get` for their
// environment, `Deno.serve` at the end. One import line therefore left sixteen
// of them running nowhere: not under Deno, which cannot resolve `bun`, and not
// under Bun, which has no `Deno` — exercised only under the tests' stand-in for
// those globals, their READMEs sending a reader to `supabase functions deploy`.
// compat/deno-on-bun.ts is the second line: imported FIRST, it gives Bun
// exactly `Deno.env.get` and `Deno.serve`, and `bun <file>` serves the file as
// written. This holds the state a migrated file must be in to run:
//   - a file that imports compat/supabase-sql and — itself, or through the
//     relative imports it evaluates — uses a member of `Deno` imports
//     compat/deno-on-bun.ts as its first import statement (ES modules evaluate
//     imports in order; a helper whose module body reads `Deno.env` before the
//     polyfill has run is a ReferenceError at startup);
//   - no member of `Deno` beyond `env.get` and `serve` is used, in the file or
//     the files it imports — the polyfill provides only those two, and an
//     emulation of `readTextFile`, `exit` or `args` would be a guess at another
//     runtime's semantics; a new use fails at the call under Bun, and here;
//   - no import specifier Bun cannot resolve remains — `jsr:`, `npm:`, a URL —
//     in the file or the files it imports, a dynamic `import("…")` included
//     (`node:` is fine; the codemod swaps the one such line these files had
//     and records it);
//   - `Deno` is reached only as `Deno.env.get` or `Deno.serve`: an alias, a
//     bracket or a destructure is a use the rule cannot follow, so it is
//     refused as one — and so are `typeof Deno` and `"Deno" in globalThis`:
//     a migrated file does not detect its runtime, the polyfill is that.
// Comments and string contents are not code: members and specifiers are read
// with both blanked (line numbers kept). Scanned: every .ts/.js/.mjs under the
// seven category directories and docs/ that imports the shim. No exceptions —
// a file that must stay a Deno deployment is kept on supabase-js by the
// codemod's KEEP list (the local-brain recipe's client), not excepted here.
/** Members of `Deno` compat/deno-on-bun.ts provides. */
const DENO_PROVIDED = new Set(["env.get", "serve"]);
/** `Deno` wherever it appears in code: a member chain of up to two names, or bare — an alias (`const D = Deno`), a bracket (`Deno["env"]`), a destructure. */
const DENO_MEMBER = /\bDeno\b(?:\.([A-Za-z_$][\w$]*)(?:\.([A-Za-z_$][\w$]*))?)?/g;
/** A dynamic import's literal specifier — quoted or in a plain backtick literal; one with `${…}` is not a literal and is not read. */
const DYNAMIC_IMPORT = /\bimport\s*\(\s*(["'\x60])([^"'\x60\n$]+)\1/g;
const SHIM_SPECIFIER = /compat\/supabase-sql\/index\.ts$/;
const RUNTIME_SPECIFIER = /compat\/deno-on-bun\.ts$/;
/** A specifier Bun does not resolve: Deno's registries and a URL. */
const NOT_ON_BUN = /^(?:jsr:|npm:|https?:\/\/)/;

/**
 * `text` with comments blanked, and — when `stringsToo` — string contents
 * blanked as well; every blanked character becomes a space, newlines stay, so
 * offsets and line numbers hold. A regex literal is not tracked: a quote or
 * `//` inside one may blank to the next quote or line end, which only ever
 * hides text from this check, never invents a member or a specifier. A
 * template literal is blanked whole, `${…}` included, so a `Deno` member
 * inside one is not seen either way (no file on the shim has one).
 */
function blanked(text, stringsToo) {
  let out = "";
  for (let i = 0; i < text.length;) {
    const c = text[i], d = text[i + 1];
    if (c === "/" && d === "/") { while (i < text.length && text[i] !== "\n") { out += " "; i++; } continue; }
    if (c === "/" && d === "*") {
      const end = text.indexOf("*/", i + 2), stop = end < 0 ? text.length : end + 2;
      for (; i < stop; i++) out += text[i] === "\n" ? "\n" : " ";
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      out += c; i++;
      while (i < text.length && text[i] !== c) {
        if (text[i] === "\\") { out += stringsToo ? "  " : text.slice(i, i + 2); i += 2; continue; }
        out += stringsToo && text[i] !== "\n" ? " " : text[i]; i++;
      }
      if (i < text.length) { out += c; i++; }
      continue;
    }
    out += c; i++;
  }
  return out;
}

/**
 * Every import (and export-from) statement's specifier, with the line it starts
 * on, in order. A statement ends at its `;` — the tree's imports all carry one;
 * a semicolon-less import would run on to the next `;` and its specifier be
 * missed (a silent miss, never a false catch), so the rule says so here.
 */
function importSpecifiers(text) {
  const code = blanked(text, false);
  const out = [];
  for (const m of code.matchAll(/^[ \t]*(?:import|export)\b[^;]*;/gm)) {
    const spec = /\bfrom\s*(["'])([^"'\n]+)\1\s*;$/.exec(m[0]) ?? /^[ \t]*import\s*(["'])([^"'\n]+)\1\s*;$/.exec(m[0]);
    if (spec) out.push({ spec: spec[2], line: code.slice(0, m.index).split("\n").length });
  }
  return out;
}

/** Whether `text` imports the SQL shim by a relative specifier. */
const importsShim = (text) => importSpecifiers(text).some((s) => SHIM_SPECIFIER.test(s.spec));

/**
 * The gaps between a shim-importing entry file and running under Bun, as
 * strings: `no-runtime-import` / `runtime-not-first` (the entry, given that it
 * or a dependency uses `Deno`), `deno-member:<m>@<line>` for a member the
 * polyfill does not provide, `specifier:<s>@<line>` for one Bun does not
 * resolve. `deps` are the texts of the files the entry imports, relatively and
 * transitively; their own gaps come back prefixed with their index (`dep0:`).
 * Pure over texts so the probes below need no files.
 */
function shimRuntimeGapsIn(entry, deps = []) {
  const gaps = [];
  let usesDeno = false;
  [entry, ...deps].forEach((text, i) => {
    const at = i === 0 ? "" : `dep${i - 1}:`;
    const code = blanked(text, true);
    for (const m of code.matchAll(DENO_MEMBER)) {
      usesDeno = true;
      // `globalThis.Deno.x` reads as `Deno.x`; a bare `Deno` (aliased, bracketed, destructured) is a use the rule cannot follow, so it is refused as one.
      const member = m[1] === undefined ? "<bare>" : m[2] ? `${m[1]}.${m[2]}` : m[1];
      const line = text.slice(0, m.index).split("\n").length;
      if (!DENO_PROVIDED.has(member)) gaps.push(`${at}deno-member:${member}@${line}`);
    }
    for (const s of importSpecifiers(text)) if (NOT_ON_BUN.test(s.spec)) gaps.push(`${at}specifier:${s.spec}@${s.line}`);
    for (const m of code.matchAll(DYNAMIC_IMPORT)) {
      // The specifier's text is blanked in `code`; read it from the original at the same offset.
      const spec = text.slice(m.index + m[0].length - m[2].length - 1, m.index + m[0].length - 1);
      if (NOT_ON_BUN.test(spec)) gaps.push(`${at}specifier:${spec}@${text.slice(0, m.index).split("\n").length}`);
    }
  });
  if (usesDeno) {
    const specs = importSpecifiers(entry);
    const runtime = specs.findIndex((s) => RUNTIME_SPECIFIER.test(s.spec));
    if (runtime < 0) gaps.push("no-runtime-import");
    else if (runtime > 0) gaps.push(`runtime-not-first@${specs[runtime].line}`);
  }
  return gaps;
}

const SHIM_RUNTIME_PROBES = [
  // The state fix 13 left the files in: the shim, a Deno global, no runtime line.
  ['import { createClient } from "../../compat/supabase-sql/index.ts";\nconst u = Deno.env.get("SUPABASE_URL");\nDeno.serve(() => new Response("ok"));\n', "no-runtime-import"],
  // The runtime line present, but after another import whose module body may read Deno.env.
  ['import { Hono } from "hono";\nimport "../../compat/deno-on-bun.ts";\nimport { createClient } from "../../compat/supabase-sql/index.ts";\nDeno.serve(() => new Response("ok"));\n', "runtime-not-first@2"],
  // A member the polyfill does not provide, in three spellings.
  ['import "../../compat/deno-on-bun.ts";\nimport { createClient } from "../../compat/supabase-sql/index.ts";\nconst t = await Deno.readTextFile("x");\n', "deno-member:readTextFile@3"],
  ['import "../../compat/deno-on-bun.ts";\nimport { createClient } from "../../compat/supabase-sql/index.ts";\nif (!ok) Deno.exit(1);\n', "deno-member:exit@3"],
  ['import "../../compat/deno-on-bun.ts";\nimport { createClient } from "../../compat/supabase-sql/index.ts";\nconst all = Deno.env.toObject();\n', "deno-member:env.toObject@3"],
  // `Deno` reached around the member syntax: an alias, a bracket, a destructure — each a use the rule cannot follow.
  ['import "../../compat/deno-on-bun.ts";\nimport { createClient } from "../../compat/supabase-sql/index.ts";\nconst D = Deno;\nD.exit(1);\n', "deno-member:<bare>@3"],
  ['import "../../compat/deno-on-bun.ts";\nimport { createClient } from "../../compat/supabase-sql/index.ts";\nconst k = Deno["env"].get("X");\n', "deno-member:<bare>@3"],
  ['import "../../compat/deno-on-bun.ts";\nimport { createClient } from "../../compat/supabase-sql/index.ts";\nconst { readTextFile } = Deno;\n', "deno-member:<bare>@3"],
  // A dynamic import of a specifier Bun does not resolve.
  ['import "../../compat/deno-on-bun.ts";\nimport { createClient } from "../../compat/supabase-sql/index.ts";\nconst p = await import("jsr:@std/path");\nDeno.serve(() => new Response("ok"));\n', "specifier:jsr:@std/path@3"],
  // Specifiers Bun does not resolve: Deno's registries and a URL, in an import and an export-from.
  ['import "../../compat/deno-on-bun.ts";\nimport "jsr:@supabase/functions-js/edge-runtime.d.ts";\nimport { createClient } from "../../compat/supabase-sql/index.ts";\nDeno.serve(() => new Response("ok"));\n', "specifier:jsr:@supabase/functions-js/edge-runtime.d.ts@2"],
  ['import "../../compat/deno-on-bun.ts";\nimport { Hono } from "npm:hono@4.9.2";\nimport { createClient } from "../../compat/supabase-sql/index.ts";\nDeno.serve(() => new Response("ok"));\n', "specifier:npm:hono@4.9.2@2"],
  ['import "../../compat/deno-on-bun.ts";\nimport { createClient } from "../../compat/supabase-sql/index.ts";\nexport {\n  Pool,\n} from "https://deno.land/x/postgres@v0.17.0/mod.ts";\nDeno.serve(() => new Response("ok"));\n', "specifier:https://deno.land/x/postgres@v0.17.0/mod.ts@3"],
];
/** [entry, dep, gap]: the transitive cases — the entry itself reads no Deno member. */
const SHIM_RUNTIME_DEP_PROBES = [
  ['import { createClient } from "../../compat/supabase-sql/index.ts";\nimport { key } from "./_shared/helpers.ts";\nexport const c = createClient(key(), "");\n', 'export const key = () => Deno.env.get("SUPABASE_URL") ?? "";\n', "no-runtime-import"],
  ['import "../../compat/deno-on-bun.ts";\nimport { createClient } from "../../compat/supabase-sql/index.ts";\nimport { key } from "./_shared/helpers.ts";\n', 'export const key = () => Deno.args[0];\n', "dep0:deno-member:args@1"],
  ['import "../../compat/deno-on-bun.ts";\nimport { createClient } from "../../compat/supabase-sql/index.ts";\nimport { db } from "./_shared/db.ts";\n', 'import { Pool } from "npm:pg@8";\nexport const db = new Pool();\n', "dep0:specifier:npm:pg@8@1"],
];
const SHIM_RUNTIME_NON_PROBES = [
  // The state the codemod leaves: the runtime line first, node: fine, both members.
  '// MIGRATED OFF SUPABASE: imports compat/supabase-sql instead of @supabase/supabase-js.\nimport "../../compat/deno-on-bun.ts";\nimport { createClient } from "../../compat/supabase-sql/index.ts";\nimport { createHash } from "node:crypto";\nconst u = Deno.env.get("SUPABASE_URL")!;\nDeno.serve(app.fetch);\n',
  // The runtime line in the jsr: types import's place, the original recorded in a comment.
  'import "../../compat/deno-on-bun.ts"; // ob1-original-types: jsr:@supabase/functions-js/edge-runtime.d.ts\n\nimport { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";\nimport { createClient } from "../../compat/supabase-sql/index.ts";\nDeno.serve(app.fetch);\n',
  // A Node script on the shim: no Deno global, so no runtime line owed.
  '#!/usr/bin/env node\nimport { createClient } from "../../compat/supabase-sql/index.ts";\nconst url = process.env.SUPABASE_URL;\n',
  // Members and specifiers in comments and strings are prose.
  'import "../../compat/deno-on-bun.ts";\nimport { createClient } from "../../compat/supabase-sql/index.ts";\n// All env reads use Deno.env.get(); never Deno.readTextFile — see "jsr:@supabase/functions-js".\nconst note = "Deno.exit is not provided; import \\"npm:x\\" fails";\n/* Deno.args too */\nDeno.serve(app.fetch);\n',
  // A multi-line import after the runtime line; `Deno.serve({ port }, handler)`; `globalThis.Deno.env.get`; a dynamic import Bun resolves.
  'import "../../compat/deno-on-bun.ts";\nimport {\n  createClient,\n  type SupabaseClient,\n} from "../../compat/supabase-sql/index.ts";\nconst u = globalThis.Deno.env.get("X");\nconst m = await import("./tools.ts");\nDeno.serve({ port: 8000 }, (req) => new Response("ok"));\n',
  // Not on the shim at all: whatever it does with Deno is a Deno deployment's business.
  'import "jsr:@supabase/functions-js/edge-runtime.d.ts";\nimport { createClient } from "@supabase/supabase-js";\nconst t = await Deno.readTextFile("x");\nDeno.serve(app.fetch);\n',
];

function checkShimRuntime() {
  const SELF = "scripts/check-fork-consistency.mjs";
  for (const [probe, gap] of SHIM_RUNTIME_PROBES) {
    const got = shimRuntimeGapsIn(probe);
    if (got.length !== 1 || got[0] !== gap) fail(SELF, `shim-runtime rule no longer reports exactly "${gap}" for its probe (reported ${JSON.stringify(got)}): ${JSON.stringify(probe)}`);
  }
  for (const [entry, dep, gap] of SHIM_RUNTIME_DEP_PROBES) {
    const got = shimRuntimeGapsIn(entry, [dep]);
    if (got.length !== 1 || got[0] !== gap) fail(SELF, `shim-runtime rule no longer reports exactly "${gap}" through a dependency (reported ${JSON.stringify(got)}): ${JSON.stringify(entry)} + ${JSON.stringify(dep)}`);
  }
  for (const text of SHIM_RUNTIME_NON_PROBES) {
    const got = importsShim(text) ? shimRuntimeGapsIn(text) : [];
    if (got.length > 0) fail(SELF, `shim-runtime rule reports ${JSON.stringify(got)} on text it must not: ${JSON.stringify(text)}`);
  }

  const WHY = "imports compat/supabase-sql, which imports `bun`, and uses a Deno global";
  const code = textFilesUnder(SCANNED_ROOTS).filter((f) => /\.(ts|js|mjs)$/.test(f) && !f.includes(`${sep}node_modules${sep}`));
  for (const file of code) {
    const text = readFileSync(file, "utf8");
    if (!importsShim(text)) continue;
    const rel = relOf(file);
    // The files it evaluates: relative imports, transitively, that exist in the tree — not the shim or the polyfill themselves.
    const deps = [];
    const seen = new Set([file]);
    const queue = [file];
    while (queue.length) {
      const from = queue.shift();
      const src = from === file ? text : readFileSync(from, "utf8");
      for (const { spec } of importSpecifiers(src)) {
        if (!spec.startsWith("./") && !spec.startsWith("../")) continue;
        const p = join(dirname(from), spec);
        if (seen.has(p) || !existsSync(p) || !statSync(p).isFile() || relOf(p).startsWith("compat/")) continue;
        seen.add(p); queue.push(p); deps.push(p);
      }
    }
    for (const gap of shimRuntimeGapsIn(text, deps.map((d) => readFileSync(d, "utf8")))) {
      // The gap strings, above; a bare `Deno` reports as `<bare>`.
      const dep = /^dep(\d+):/.exec(gap);
      const where = dep ? relOf(deps[Number(dep[1])]) : rel;
      const g = dep ? gap.slice(dep[0].length) : gap;
      const line = /@(\d+)$/.exec(g)?.[1];
      const at = line ? `${where}:${line}` : where;
      if (g === "no-runtime-import") fail(rel, `${WHY} (itself or through ${deps.length ? "a file it imports" : "its own text"}) but does not import compat/deno-on-bun.ts — under Bun \`Deno\` is undefined at the first read, under Deno the shim's \`bun\` import fails, so the file runs nowhere; \`bun scripts/migrate-to-sql-shim.mjs --apply --all\` adds the line as the first import (SMD-1480, FORK.md change 74)`);
      else if (g.startsWith("runtime-not-first")) fail(at, `imports compat/deno-on-bun.ts after another import — a module evaluated before it may read \`Deno.env\` in its body and throw at startup; make it the first import statement (SMD-1480, FORK.md change 74)`);
      else if (g.startsWith("deno-member:")) {
        const member = g.slice("deno-member:".length).replace(/@\d+$/, "");
        fail(at, `uses ${member === "<bare>" ? "\`Deno\` other than as \`Deno.env.get\` or \`Deno.serve\` (aliased, bracketed or destructured — a use this rule cannot follow)" : `\`Deno.${member}\``} in a file that runs under Bun through compat/deno-on-bun.ts, which provides only \`Deno.env.get\` and \`Deno.serve\` — the call fails under Bun; use the Node API Bun and Deno both have (node:fs, process.argv, process.exit), or extend the polyfill deliberately and say so (SMD-1480, FORK.md change 74)`);
      }
      else if (g.startsWith("specifier:")) fail(at, `imports \`${g.slice("specifier:".length).replace(/@\d+$/, "")}\` in a file that runs under Bun, which does not resolve jsr:, npm: or URL specifiers — a bare package name resolves from extensions/node_modules (NODE_PATH, as the README says); a type-only jsr: import is what the codemod swaps for the polyfill line (SMD-1480, FORK.md change 74)`);
      else fail(at, `shim-runtime gap ${g}`);
    }
  }
}

// ── 12: schema SQL runs nothing that needs Supabase ──────────────────────────
//
// SMD-1796. Twelve of the seventeen SQL files under schemas/ ended with GRANTs
// TO service_role, RLS enabled with a policy FOR service_role, GRANTs and
// REVOKEs naming authenticated and anon, and (two) policies on auth.uid().
// Those are Supabase's roles and GoTrue's schema: on any Postgres that is not
// Supabase the first such statement stops the file (`role "service_role" does
// not exist`), and where an operator creates the role to get past it, RLS with
// no policy for the role they actually connect as denies that role every row.
// The statements were cut on that ticket (FORK.md change 93), each file left
// with a note pointing at `migrate.ts --grant`'s `community` group; this keeps
// the next rebase from bringing them back — and holds db/ to the same rule
// test-schema [10] has held the migrations to since the start, now one
// spelling: db/config.mjs's SUPABASE_SQL_RULES over stripSqlComments, which
// is literal-aware (a `--` inside a string no longer hides the rest of its
// line — SMD-1316's ask) and scans string literals, since `EXECUTE 'GRANT … TO
// service_role'` runs the grant as surely as the bare statement. Every .sql
// under schemas/ and db/ whole; no exceptions. The extension and recipe
// directories carry thirteen more such files, with per-user `auth.uid() =
// user_id` policies that need a design of their own — their ticket is the
// umbrella SMD-1795's.

function checkSupabaseIsms() {
  for (const dir of ["schemas", "db"]) {
    const base = join(ROOT, dir);
    if (!existsSync(base)) continue;
    for (const file of walk(base, [], /\.sql$/)) {
      const rel = relOf(file);
      for (const h of supabaseIsmsIn(readFileSync(file, "utf8"))) fail(`${rel}:${h.line}`, `${h.msg} (SMD-1796)`);
    }
  }
}

// ── 13: a compose file publishes a port on loopback, by a knob, or not at all ──
//
// SMD-1844. deploy/compose.yaml carried `"${POSTGRES_PORT:-5432}:5432"`,
// `"${SERVER_PORT:-8000}:8000"` and `"${OLLAMA_PORT:-11434}:11434"`: an
// address-less mapping, which compose binds to 0.0.0.0. On the first stack the
// fork ran (podman machine, macOS) `lsof` showed gvproxy on `*:5432` and
// `*:8010` — the postgres superuser on the whole brain behind its password, and
// the MCP server with its key in clear on every request, offered to every host
// on the LAN. The file's own comment said to drop the database port in
// production; the default was the exposed one and no README said to. Since the
// fix every published mapping is the short form `"${X_BIND:-127.0.0.1}:
// ${X_PORT:-n}:n"` — the literal 127.0.0.1 unless the operator names an
// address, in a knob deploy/.env.example documents — and the base file
// publishes the server alone; the database and Ollama reach the host only
// through compose.host-ports.yaml, a second -f an operator adds for a tool run
// from a checkout.
//
// The file is PARSED, not scanned. Three review passes each found a spelling
// the text walk before this did not read — an item at another indentation, a
// `ports:` block carried in through an anchor and `<<:` merge key, a quoted
// `"ports":` key — and each time compose rendered the mapping with no host_ip
// while the check passed; a walk over YAML text is not a YAML reader, and the
// fourth spelling would have been found by the next pass. Bun.YAML.parse
// (Bun 1.2+; CI and the Dockerfile pin 1.4.0) resolves anchors, aliases and
// merge keys (quoted or bare — a probe found no spelling it leaves unfolded),
// normalises key spellings, reads flow and block sequences alike and refuses
// tabs, so what this rule sees is what compose sees — with two exceptions it
// refuses by name, because they reach outside the file: a service's
// `extends:` and a top-level `include:`, each of which imports a service body
// from a file the rule does not open; and `network_mode:`, which with the
// value `host` puts a service on the host's interfaces with no `ports:` at
// all (the third pass's one hole in the definition). Under node, which has no
// Bun.YAML, the rule fails in words rather than passing. The fourth pass added
// the file operators copy: a live `X_BIND=` line in deploy/.env.example may
// say only 127.0.0.1, since that file, not compose.yaml's fallback, is the
// default of every stack brought up from it.
//
// Two rules. The first, per service: `ports` is a list whose every item is the
// short form — no host address (fewer than three fields), an address but not
// the form (a literal address or port, a `/tcp` suffix, a knob not named
// `_BIND`), a default other than the literal `127.0.0.1` (smoke.sh and the CI
// step dial it), a knob `.env.example` does not document, and the long form
// (an object) are each refused in their own words. The second is an
// inventory: PUBLISHES names which service publishes from which compose file,
// one mapping each, and a file's readable mappings must equal its entry — so
// a mapping that is gone, or refused above, fails as MISSING too, a new file
// or service that publishes fails as UNLISTED until named here deliberately
// (with its row in deploy/README.md), and the overlay must exist. Only files
// named as compose names them (`compose*.yaml`, `docker-compose*.yml`) are
// read: SMD-1849's collector configuration under deploy/ is not a stack.

/**
 * The knobs deploy/.env.example documents whose names match `pattern`: one
 * entry per knob line, live or commented out (most ship commented out
 * precisely because they have a default), with an optional trailing `#`
 * comment — so `# OB1_EMBEDDING_DIM=1536   # hosted` counts and the prose line
 * `# SERVER_BIND=0.0.0.0 is the one an operator sets…` does not. Null, after a
 * failure in words, when the file is missing; both readers stop there rather
 * than throw. Check 13 and the compose-forwards check read the file through
 * this, so what counts as a documented line is decided once.
 */
function envKnobsIn(text, pattern) {
  const knobs = [];
  // Same-line whitespace only: a `\s*` here once ate the newline and the next
  // knob line as this one's trailing comment, and POSTGRES_BIND went undocumented.
  for (const m of text.matchAll(/^(#?)[ \t]*([A-Z0-9_]+)=(\S*)[ \t]*(?:#.*)?$/gm)) {
    if (pattern.test(m[2])) knobs.push({ name: m[2], value: m[3], live: m[1] === "", line: text.slice(0, m.index).split("\n").length });
  }
  return knobs;
}
const ENV_KNOB_PROBES = [
  // [text, pattern, expected names]
  ["# A_BIND=127.0.0.1\n# B_BIND=127.0.0.1\n# C_BIND=127.0.0.1\n", /_BIND$/, ["A_BIND", "B_BIND", "C_BIND"]],
  ["# OB1_X=1536   # hosted; unmeasured\nOB1_Y=\n", /^OB1_/, ["OB1_X", "OB1_Y"]],
  ["# SERVER_BIND=0.0.0.0 is the one an operator sets\n# SERVER_BIND=127.0.0.1\n", /_BIND$/, ["SERVER_BIND"]],
];
function documentedEnvKnobs(pattern) {
  const SELF = "scripts/check-fork-consistency.mjs";
  for (const [text, pat, names] of ENV_KNOB_PROBES) {
    const got = envKnobsIn(text, pat).map((k) => k.name);
    if (JSON.stringify(got) !== JSON.stringify(names)) fail(SELF, `env-knob reader no longer reports exactly ${JSON.stringify(names)} for its probe (reported ${JSON.stringify(got)}): ${JSON.stringify(text)}`);
  }
  const path = join(ROOT, "deploy", ".env.example");
  if (!existsSync(path)) {
    if (!documentedEnvKnobs.reported) fail("deploy/.env.example", `missing — the documented knobs are read from it (check 13's _BIND knobs, check 14's OB1_* settings), and SETUP.md tells every operator to copy it`);
    documentedEnvKnobs.reported = true;
    return null;
  }
  return envKnobsIn(readFileSync(path, "utf8"), pattern);
}

/** compose file under deploy/ → the services that publish one mapping each from it. */
const PUBLISHES = {
  "compose.yaml": ["server"],
  "compose.host-ports.yaml": ["postgres", "ollama"],
};
const COMPOSE_FILE = /^(docker-)?compose.*\.ya?ml$/;

const PORT_ITEM = /^\$\{([A-Z0-9_]+)_BIND:-([^}]*)\}:\$\{[A-Z0-9_]+_PORT:-\d+\}:\d+$/;
/** Colon-separated fields of a short-form mapping, `${…}` contents not counted. */
function portFields(v) {
  let depth = 0, n = 1;
  for (const ch of v) { if (ch === "{") depth++; else if (ch === "}") depth--; else if (ch === ":" && depth === 0) n++; }
  return n;
}
/** 1-based line of the first non-comment line containing `needle`, for the report; 0 if none. */
function lineOf(text, needle) {
  const i = text.split("\n").findIndex((l) => !/^\s*#/.test(l) && l.replace(/\s+#.*$/, "").includes(needle));
  return i < 0 ? 0 : i + 1;
}

/**
 * One compose file's published ports: `{ gaps: [[kind, service, line, detail]],
 * published: [service, …] }` — `published` lists a service once per house-form
 * mapping, for the inventory.
 */
function publishedPortGapsIn(text, { documented }) {
  const gaps = [], published = [];
  if (typeof Bun === "undefined" || typeof Bun.YAML?.parse !== "function") return { gaps: [["no-parser", null, 0, ""]], published };
  let doc;
  try { doc = Bun.YAML.parse(text); } catch (e) { return { gaps: [["unparseable", null, 0, String(e.message ?? e)]], published }; }
  if (Array.isArray(doc)) return { gaps: [["not-a-mapping", null, 0, `a list of ${doc.length}`]], published };
  if (!doc || typeof doc !== "object" || !doc.services || typeof doc.services !== "object" || Array.isArray(doc.services)) {
    return { gaps: [["no-services", null, 0, ""]], published };
  }
  if ("include" in doc) gaps.push(["include", null, lineOf(text, "include"), ""]);
  for (const [service, def] of Object.entries(doc.services)) {
    const at = lineOf(text, `${service}:`) || lineOf(text, service);
    if (!def || typeof def !== "object" || Array.isArray(def)) { gaps.push(["unreadable", service, at, JSON.stringify(def)]); continue; }
    if ("extends" in def) gaps.push(["extends", service, lineOf(text, "extends"), JSON.stringify(def.extends)]);
    if ("network_mode" in def) gaps.push(["network-mode", service, lineOf(text, "network_mode"), String(def.network_mode)]);
    if (!("ports" in def)) continue;
    const ports = def.ports;
    if (!Array.isArray(ports)) { gaps.push(["ports-not-list", service, lineOf(text, "ports"), JSON.stringify(ports)]); continue; }
    if (ports.length === 0) gaps.push(["empty-ports", service, lineOf(text, "ports"), ""]);
    for (const item of ports) {
      if (item === null || typeof item === "object") { gaps.push(["long-form", service, lineOf(text, "target"), JSON.stringify(item)]); continue; }
      const v = String(item);
      const line = lineOf(text, v) || lineOf(text, "ports");
      if (portFields(v) < 3) { gaps.push(["no-address", service, line, v]); continue; }
      const m = PORT_ITEM.exec(v);
      if (!m) { gaps.push(["not-house-form", service, line, v]); continue; }
      if (m[2] !== "127.0.0.1") gaps.push(["default-not-loopback", service, line, `${m[1]}_BIND defaults to "${m[2]}"`]);
      else if (documented && !documented.has(`${m[1]}_BIND`)) gaps.push(["undocumented-knob", service, line, `${m[1]}_BIND`]);
      else published.push(service);
    }
  }
  return { gaps, published };
}

const GOOD = `"\${SERVER_BIND:-127.0.0.1}:\${SERVER_PORT:-8000}:8000"`;
const PORT_PROBES = [
  // [text, expected gap kinds, expected published services]
  [`services:\n  server:\n    ports:\n      - ${GOOD}\n`, [], ["server"]],
  // Spellings a parser makes one: quoting, indentation, a flow sequence, a quoted or spaced key, an alias, an anchored block merged in.
  [`services:\n  server:\n    ports:\n      - ${GOOD.replace(/"/g, "'")}\n`, [], ["server"]],
  [`services:\n  server:\n    ports:\n      - ${GOOD.replace(/"/g, "")}\n`, [], ["server"]],
  [`services:\n  server:\n    ports:\n        - ${GOOD}\n`, [], ["server"]],
  [`services:\n  server:\n    ports:\n    - ${GOOD}\n`, [], ["server"]],
  [`services:\n    server:\n        ports:\n            - ${GOOD}\n`, [], ["server"]],
  [`services:\n  server:\n    ports: [${GOOD}]\n`, [], ["server"]],
  [`services:\n  server:\n    "ports":\n      - ${GOOD}\n`, [], ["server"]],
  [`services:\n  server:\n    ports :\n      - ${GOOD}\n`, [], ["server"]],
  [`x-p: &p\n  - ${GOOD}\nservices:\n  server:\n    ports: *p\n`, [], ["server"]],
  [`x-open: &open\n  ports:\n    - ${GOOD}\nservices:\n  server:\n    <<: *open\n    image: x\n`, [], ["server"]],
  // …and the same spellings carrying a bare mapping are read, and refused.
  [`services:\n  server:\n    ports:\n        - "8000:8000"\n`, ["no-address"], []],
  [`services:\n  server:\n    "ports":\n      - "5432:5432"\n`, ["no-address"], []],
  [`x-open: &open\n  ports:\n    - "5432:5432"\nservices:\n  postgres:\n    <<: *open\n    image: x\n`, ["no-address"], []],
  [`services:\n  server:\n    ports: ["8000:8000"]\n`, ["no-address"], []],
  [`services:\n  server:\n    ports:\n      - "\${SERVER_PORT:-8000}:8000"\n`, ["no-address"], []],
  [`services:\n  server:\n    ports:\n      - 8000:8000\n`, ["no-address"], []],
  [`services:\n  server:\n    ports:\n      - "\${SERVER_BIND:-127.0.0.1}:8000:8000"\n`, ["not-house-form"], []],
  [`services:\n  server:\n    ports:\n      - "127.0.0.1:\${SERVER_PORT:-8000}:8000"\n`, ["not-house-form"], []],
  [`services:\n  server:\n    ports:\n      - ${GOOD.replace(/"$/, '/tcp"')}\n`, ["not-house-form"], []],
  [`services:\n  server:\n    ports:\n      - "\${SERVER_BIND:-0.0.0.0}:\${SERVER_PORT:-8000}:8000"\n`, ["default-not-loopback"], []],
  [`services:\n  server:\n    ports:\n      - "\${SERVER_BIND:-[::1]}:\${SERVER_PORT:-8000}:8000"\n`, ["default-not-loopback"], []],
  [`services:\n  server:\n    ports:\n      - target: 8000\n        published: 8000\n        host_ip: 127.0.0.1\n`, ["long-form"], []],
  [`services:\n  server:\n    ports: 8000\n`, ["ports-not-list"], []],
  [`services:\n  server:\n    ports: []\n`, ["empty-ports"], []],
  [`services:\n  server:\n    ports:\n      - "\${OTHER_BIND:-127.0.0.1}:\${SERVER_PORT:-8000}:8000"\n`, ["undocumented-knob"], []],
  // What reaches outside the file, or the host, without a ports: item.
  [`services:\n  postgres:\n    extends:\n      file: base/pg.yaml\n      service: pg\n`, ["extends"], []],
  [`include:\n  - other.yaml\nservices:\n  server:\n    ports:\n      - ${GOOD}\n`, ["include"], ["server"]],
  [`services:\n  postgres:\n    network_mode: host\n`, ["network-mode"], []],
  [`services:\n  server:\n    network_mode: host\n    ports:\n      - ${GOOD}\n`, ["network-mode"], ["server"]],
  // What is not a stack this rule can read.
  [`services:\n  server:\n\tports:\n`, ["unparseable"], []],
  [`services:\n  - server\n`, ["no-services"], []],
  [`services:\n  server: x\n`, ["unreadable"], []],
  [`version: "3"\n`, ["no-services"], []],
  [`a: 1\n---\nb: 2\n`, ["not-a-mapping"], []],
  [`- a\n- b\n`, ["not-a-mapping"], []],
  // Two items are two mappings; a second service is read after the first; comments are not mappings.
  [`services:\n  server:\n    ports:\n      - ${GOOD}\n      - "9000:9000"\n  postgres:\n    ports:\n      # - "5432:5432"\n      - "\${POSTGRES_BIND:-127.0.0.1}:\${POSTGRES_PORT:-5432}:5432"  # loopback\n`, ["no-address"], ["server", "postgres"]],
  // A ports: key under a top-level block nothing merges into publishes nothing.
  [`services:\n  server:\n    image: x\nvolumes:\n  ports:\n      - "8000:8000"\n`, [], []],
];

function checkPublishedPorts() {
  const SELF = "scripts/check-fork-consistency.mjs";
  const knobs = documentedEnvKnobs(/_BIND$/);
  if (knobs === null) return;
  const documented = new Set(knobs.map((k) => k.name));
  // The file every operator copies to deploy/.env: a LIVE knob line there is the
  // stack's default in practice, whatever compose.yaml's fallback says, and
  // neither the compose rule nor the CI step (which writes its own .env) reads
  // it — so a live line may only say the loopback address.
  for (const k of knobs) {
    if (k.live && k.value !== "127.0.0.1") {
      fail(`deploy/.env.example:${k.line}`, `\`${k.name}=${k.value}\` is a live line in the file operators copy to deploy/.env, so every stack brought up from it publishes on ${k.value || "an empty address"} — comment it out or set 127.0.0.1; the network is the operator's choice in deploy/.env, not the example's (SMD-1844)`);
    }
  }
  const probeDocs = new Set(["SERVER_BIND", "POSTGRES_BIND"]);
  for (const [text, kinds, services] of PORT_PROBES) {
    const got = publishedPortGapsIn(text, { documented: probeDocs });
    const gotKinds = got.gaps.map((g) => g[0]);
    if (gotKinds.length === 1 && gotKinds[0] === "no-parser") break; // reported once, below
    if (JSON.stringify(gotKinds) !== JSON.stringify(kinds) || JSON.stringify(got.published) !== JSON.stringify(services)) {
      fail(SELF, `published-port rule no longer reports exactly ${JSON.stringify(kinds)} / ${JSON.stringify(services)} for its probe (reported ${JSON.stringify(gotKinds)} / ${JSON.stringify(got.published)}): ${JSON.stringify(text)}`);
    }
  }

  const dir = join(ROOT, "deploy");
  const files = readdirSync(dir).filter((f) => COMPOSE_FILE.test(f) && statSync(join(dir, f)).isFile()).sort();
  for (const name of Object.keys(PUBLISHES)) {
    if (!files.includes(name)) fail(`deploy/${name}`, `missing — PUBLISHES in ${SELF} says ${PUBLISHES[name].map((s) => `\`${s}\``).join(" and ")} publish from it (SMD-1844)`);
  }
  const HOUSE = "`\"${X_BIND:-127.0.0.1}:${X_PORT:-n}:n\"`";
  for (const name of files) {
    const rel = `deploy/${name}`;
    const { gaps, published } = publishedPortGapsIn(readFileSync(join(dir, name), "utf8"), { documented });
    for (const [kind, service, line, detail] of gaps) {
      const at = line ? `${rel}:${line}` : rel;
      const svc = service ? `service \`${service}\`` : "the file";
      const knob = `${(service || "X").toUpperCase().replace(/-/g, "_")}_BIND`;
      switch (kind) {
        case "no-parser": fail(SELF, `check 13 parses compose files with Bun.YAML (Bun 1.2+) and this runtime has none — run \`bun ${SELF}\`, as CI does (SMD-1844)`); return;
        case "unparseable": fail(rel, `does not parse as YAML: ${detail} (SMD-1844)`); break;
        case "not-a-mapping": fail(rel, `parses to ${detail}, not a mapping — several documents, or a root sequence; a compose file is one mapping (SMD-1844)`); break;
        case "no-services": fail(rel, `has no top-level \`services:\` mapping — every compose*.yaml under deploy/ is a stack this rule reads (SMD-1844)`); break;
        case "include": fail(at, `a top-level \`include:\` imports services from a file this rule does not open — put the services in this file (SMD-1844)`); break;
        case "extends": fail(at, `${svc} \`extends\` ${detail} — a service body this rule does not follow (another file, or a sibling whose \`ports:\` the child would inherit uncounted); write the service out (SMD-1844)`); break;
        case "network-mode": fail(at, `${svc} sets \`network_mode: ${detail}\` — refused whatever the value: \`host\` puts the service on the host's interfaces with no \`ports:\` at all, and the stack needs no mode but the default network; remove it (SMD-1844)`); break;
        case "unreadable": fail(at, `${svc} is ${detail}, not a mapping (SMD-1844)`); break;
        case "ports-not-list": fail(at, `${svc} has \`ports: ${detail}\`, not a list (SMD-1844)`); break;
        case "empty-ports": fail(at, `${svc} has an empty \`ports:\` list (SMD-1844)`); break;
        case "long-form": fail(at, `${svc} publishes ${detail} in the long form — use the short form ${HOUSE}, the one shape this rule and the README teach (SMD-1844)`); break;
        case "no-address": fail(at, `${svc} publishes \`${detail}\` with no host address — compose binds that to 0.0.0.0, every interface; write ${HOUSE} with \`${knob}\` and document the knob in deploy/.env.example (SMD-1844)`); break;
        case "not-house-form": fail(at, `${svc} publishes \`${detail}\`, which names an address but is not the house form ${HOUSE} — the knob must end in _BIND, the host port must be a \`_PORT\` knob (smoke.sh and the CI step read SERVER_PORT), and no suffix (SMD-1844)`); break;
        case "default-not-loopback": fail(at, `${svc}: ${detail} — the default is the literal 127.0.0.1, which smoke.sh and the CI step dial; an operator who wants another address sets the knob (SMD-1844)`); break;
        case "undocumented-knob": fail(at, `${svc} reads \`${detail}\`, which deploy/.env.example does not document — an operator cannot find the knob that opens the port (SMD-1844)`); break;
        default: throw new Error(`check 13: no message for kind ${kind}`);
      }
    }
    const expected = PUBLISHES[name] ?? [];
    for (const service of expected) {
      if (!published.includes(service)) fail(rel, `publishes no house-form mapping for service \`${service}\`, and PUBLISHES in ${SELF} says it does — the port is gone, or refused above (SMD-1844)`);
    }
    for (const service of new Set(published)) {
      const n = published.filter((s) => s === service).length;
      if (!expected.includes(service) || n > 1) fail(rel, `service \`${service}\` publishes ${n} mapping${n === 1 ? "" : "s"} from this file and PUBLISHES in ${SELF} lists ${expected.includes(service) ? "one" : "none"} — ${name === "compose.yaml" ? "the base file publishes the server alone; the database and Ollama publish through compose.host-ports.yaml, a second -f, and " : ""}a new published port is named in PUBLISHES deliberately, with its row in deploy/README.md's "What is reachable from where" (SMD-1844)`);
    }
  }
}

// ── Run ──────────────────────────────────────────────────────────────────────

const dirs = contributionDirs();
for (const d of dirs) {
  const meta = checkMetadata(d);
  checkLinks(d);
  checkDeps(meta, d);
}
checkSqlGuards();
await checkMigrationNumbers();
checkShellHazards(dirs);
checkCoreFunctions();
checkCredentialCompares();
checkThoughtWritesAround();
checkShimRuntime();
checkSupabaseIsms();
checkPublishedPorts();

/**
 * The embedding default is stated in three places that must agree, and two of them
 * silently win over the third. Compose substitutes `${VAR:-fallback}` before the
 * process starts, so a stale fallback in compose.yaml overrides db/config.mjs
 * rather than deferring to it — the configuration would look right in the source
 * and be wrong in the container, which is the failure mode this whole fork keeps
 * trying to make loud.
 */
async function checkEmbeddingDefaults() {
  const cfg = await import("../db/config.mjs");
  const compose = readFileSync(join(ROOT, "deploy", "compose.yaml"), "utf8");

  const dims = [...compose.matchAll(/OB1_EMBEDDING_DIM:\s*\$\{OB1_EMBEDDING_DIM:-(\d+)\}/g)].map((m) => Number(m[1]));
  const models = [...compose.matchAll(/OB1_EMBEDDING_MODEL:\s*\$\{OB1_EMBEDDING_MODEL:-([^}]+)\}/g)].map((m) => m[1].trim());

  for (const d of dims) {
    if (d !== cfg.DEFAULT_EMBEDDING_DIM) {
      violations.push({
        where: "deploy/compose.yaml",
        msg: `OB1_EMBEDDING_DIM fallback ${d} does not match db/config.mjs DEFAULT_EMBEDDING_DIM ${cfg.DEFAULT_EMBEDDING_DIM}`,
      });
    }
  }
  for (const m of models) {
    if (m !== cfg.DEFAULT_EMBEDDING_MODEL) {
      violations.push({
        where: "deploy/compose.yaml",
        msg: `OB1_EMBEDDING_MODEL fallback "${m}" does not match db/config.mjs DEFAULT_EMBEDDING_MODEL "${cfg.DEFAULT_EMBEDDING_MODEL}"`,
      });
    }
  }

  const metas = [...compose.matchAll(/OB1_METADATA_MODEL:-([^}]+)\}/g)].map((m) => m[1].trim());
  for (const m of metas) {
    if (m !== cfg.DEFAULT_METADATA_MODEL) {
      violations.push({
        where: "deploy/compose.yaml",
        msg: `OB1_METADATA_MODEL fallback "${m}" does not match db/config.mjs DEFAULT_METADATA_MODEL "${cfg.DEFAULT_METADATA_MODEL}"`,
      });
    }
  }

  // The three provider-facing defaults move together or not at all. A local model
  // name sent to a hosted endpoint is a 404 per capture — fatal for the embedding
  // call, silent for the metadata one. Both halves of that have already shipped
  // here once.
  const hostedModel = (n) => n.includes("/");
  const localBase = /(^|\/\/)(127\.0\.0\.1|localhost|ollama|host\.(docker|containers)\.internal)/.test(
    cfg.DEFAULT_LLM_BASE_URL
  );
  if (hostedModel(cfg.DEFAULT_EMBEDDING_MODEL) !== hostedModel(cfg.DEFAULT_METADATA_MODEL)) {
    violations.push({
      where: "db/config.mjs",
      msg: `default embedding model "${cfg.DEFAULT_EMBEDDING_MODEL}" and metadata model ` +
           `"${cfg.DEFAULT_METADATA_MODEL}" target different providers; one is hosted and one is local`,
    });
  }
  if (hostedModel(cfg.DEFAULT_EMBEDDING_MODEL) === localBase) {
    violations.push({
      where: "db/config.mjs",
      msg: `DEFAULT_LLM_BASE_URL "${cfg.DEFAULT_LLM_BASE_URL}" does not match the model defaults ` +
           `("${cfg.DEFAULT_EMBEDDING_MODEL}"); a local model name sent to a hosted endpoint 404s on every capture`,
    });
  }

  // A default the schema cannot index would be caught at migrate time, but only
  // by whoever ran it. Catching it here means it never lands.
  const problems = cfg.validateEmbeddingConfig(cfg.DEFAULT_EMBEDDING_DIM, cfg.DEFAULT_EMBEDDING_MODEL, cfg.EMBEDDING_DIMENSIONS);
  for (const p of problems) violations.push({ where: "db/config.mjs", msg: `default configuration is not usable: ${p}` });
}
await checkEmbeddingDefaults();

/**
 * db/README.md's "Grants for a capturing role" names every table db/config.mjs's
 * ROLE_GRANTS requires — and, since SMD-1796, every view, sequence and function the
 * community group adds — the two are one spelling (SMD-1226). Preflight's `write
 * privileges` check and `migrate.ts --grant` both read ROLE_GRANTS; the README is
 * the human list. An object added to a group in config without a line in the
 * README would leave a self-hoster's role short a privilege the docs never
 * mention. Matched in backticks, the doc's convention for a name, so `thoughts`
 * is not satisfied by `thought_chunks` merely containing it; a function is
 * matched with its argument types, as the row spells them.
 */
async function checkCapturingGrants() {
  const cfg = await import("../db/config.mjs");
  const readme = readFileSync(join(ROOT, "db", "README.md"), "utf8");
  const heading = /^#+\s+Grants for a capturing role\s*$/m.exec(readme);
  if (!heading) {
    violations.push({ where: "db/README.md", msg: 'no "Grants for a capturing role" section — db/config.mjs ROLE_GRANTS has no documented home (SMD-1226)' });
    return;
  }
  // Bound at the next level-2 heading, not any `#`-led line: the section holds a
  // ```bash fence, and a future `# comment` inside it would otherwise read as the
  // next heading and truncate the section (SMD-1226 review, L3).
  const rest = readme.slice(heading.index + heading[0].length);
  const next = /^##\s/m.exec(rest);
  const section = next ? rest.slice(0, next.index) : rest;
  // Match within the markdown table rows (pipe-led lines), not the section's
  // prose: a table named only in a paragraph would otherwise satisfy the check
  // even if its privilege row were deleted. The rows are where the grant lives.
  const tableRows = section.split("\n").filter((l) => l.trimStart().startsWith("|")).join("\n");
  for (const { kind, name } of cfg.grantedObjects()) {
    if (!tableRows.includes("`" + name + "`")) {
      violations.push({
        where: "db/README.md",
        msg: `"Grants for a capturing role" does not name the ${kind} \`${name}\`, which db/config.mjs's ROLE_GRANTS requires — the list and the docs have drifted (SMD-1226${kind === "table" ? "" : ", SMD-1796"})`,
      });
    }
  }
}
await checkCapturingGrants();

/**
 * 14: every knob the server reads reaches the container (SMD-1843).
 *
 * The first dogfood stack set OB1_LLM_BASE_URL, OB1_METADATA_MODEL and
 * OB1_QUERY_LOG in deploy/.env and the container saw none of them: compose
 * forwards exactly what `environment:` names, and the server's block named
 * none of the three. The rule this replaces compared the knobs .env.example
 * documents against every `OB1_*` token in the compose file's TEXT — and the
 * file's comments named the first, ollama-pull's command line the second, so
 * both counted as forwarded; the third was not documented, so it was never
 * asked about. (That rule had itself found six unforwarded knobs when it was
 * written — OB1_CHUNK_TOKENS, OB1_CHUNK_OVERLAP, OB1_CHUNK_CONTEXT,
 * OB1_EMBEDDING_DIMENSIONS, OB1_LLM_API_KEY, OB1_AGENT_CACHE_TTL_MS — and was
 * one-directional on purpose: compose may set what the example does not
 * mention. This one is not: a forwarded knob the server does not declare is a
 * typo.) Measured: preflight took the code's default, 127.0.0.1:11434,
 * for a local endpoint (it is — the container's own loopback), wanted no
 * credential, dialled nothing without --deep and said OK; the first capture
 * failed in 7 ms with "Unable to connect" and the server logged nothing.
 *
 * So the universe is what the SERVER declares — the `OB1_*` and `OPEN_BRAIN_*`
 * names in server-portable/index.ts's `type Env` — held honest by a scan of
 * every non-test server source for a direct read (`process.env.OB1_X`,
 * `env.OB1_X`, `env["OB1_X"]`) of a name the block does not declare; and
 * "forwarded" is read from the parsed documents' `services.*.environment`,
 * mapping or list form. Each declared knob is forwarded by the base file's
 * server under its own name as `${NAME}` or `${NAME:-…}` (a literal pins the
 * operator out; another name is a miswire; a bare list item `- NAME` is
 * refused — compose fills it from its own environment, absent rather than ""
 * when nothing is set, and the runners differ in what "its environment" is)
 * or excused by name in NOT_FORWARDED with the reason, and documented in
 * .env.example so an operator can find it. A forwarded name the server does
 * not declare is a typo or a knob that died. A documented knob no service in
 * any compose file forwards is a dead switch. `env_file` is refused on any
 * service: it forwards a file this rule does not open. Every compose*.yaml
 * under deploy/ is held to the shape and to the server's names, since an
 * overlay's `server:` lands in the same container; the base file alone holds
 * the universe. And OB1_LLM_BASE_URL's compose fallback, if it has one, is
 * `http://<service>:11434/v1` for a service the base file defines and
 * db/config.mjs's LOCAL_PROVIDER_SERVICES names — what preflight calls local.
 *
 * The decision is one pure function over parsed inputs, serverEnvGapsIn, so
 * DECISION_PROBES run it on in-memory documents every run — the third review
 * pass found the readers and the messages probed and the decision itself not,
 * so a dropped branch stayed invisible while the real file complied.
 */
const SERVER_ENV_SOURCE = "server-portable/index.ts";
const KNOB = /^(OB1_|OPEN_BRAIN_)[A-Z0-9_]+$/;
/** Knobs the server declares that compose.yaml must NOT forward, with the reason its own comment gives. */
const NOT_FORWARDED = {
  OB1_STORE: "the SQL store is the server's default (FORK.md change 97) and this stack is the deployment that proves it — forwarding it would let the default drift back to PostgREST with nothing in CI noticing",
};

/** The names `type Env = { … }` declares in a server source, in order; null when the block is not there. */
function declaredEnvIn(source) {
  const m = /type Env = \{([\s\S]*?)\n\};/.exec(source);
  if (!m) return null;
  return [...m[1].matchAll(/^[ \t]*([A-Z][A-Z0-9_]*)\??:/gm)].map((x) => x[1]);
}

/**
 * The knob names a source reads straight from an environment object —
 * `process.env.OB1_X`, `env.OB1_X`, `env?.OB1_X`, `env["OB1_X"]`, `ENV.OB1_X`,
 * `bindings.OB1_X`, index.ts's accessor `env().OB1_X` — as `[name, index]`
 * pairs, deduplicated, in order of first read, the index that of the read
 * itself (a docblock naming the knob above it is not the read). A name a
 * module reads this way without declaring it in `type Env` is the class the
 * rule's first run found twice (OB1_PG_POOL in store-sql.ts, and
 * OB1_TRGM_INDEX, which db/config.mjs reads for preflight); a read through a
 * variable (`env[QUERY_LOG.flag]`) or a destructuring is invisible here, and
 * declared by hand.
 */
function envReadsIn(source) {
  const reads = [];
  for (const m of source.matchAll(/\b(?:process\.env|env\(\)|env|ENV|bindings)(?:\?\.|\.|\??\[["'])((?:OB1_|OPEN_BRAIN_)[A-Z0-9_]+)\b/g)) {
    if (!reads.some(([n]) => n === m[1])) reads.push([m[1], m.index]);
  }
  return reads;
}

/**
 * One parsed compose document's environment: `forwarded` maps each service to
 * a Map of name → value (null for a list item with no `=`); `gaps` lists
 * `[kind, service, detail]` for what the rule refuses or cannot read.
 */
function forwardedEnvIn(doc) {
  const gaps = [], forwarded = new Map();
  if (!doc || typeof doc !== "object" || Array.isArray(doc) || !doc.services || typeof doc.services !== "object" || Array.isArray(doc.services)) {
    gaps.push(["no-services", null, ""]);
    return { gaps, forwarded };
  }
  for (const [service, def] of Object.entries(doc.services)) {
    const env = new Map();
    forwarded.set(service, env);
    if (!def || typeof def !== "object" || Array.isArray(def)) { gaps.push(["unreadable", service, JSON.stringify(def)]); continue; }
    if ("env_file" in def) gaps.push(["env-file", service, JSON.stringify(def.env_file)]);
    if (!("environment" in def)) continue;
    const e = def.environment;
    if (Array.isArray(e)) {
      for (const item of e) {
        // A list item is a string: `NAME=value` or a bare `NAME`. A mapping or
        // a list in its place (`- OB1_A: 1`, a common slip compose rejects)
        // would stringify to "[object Object]" and vanish from the count.
        if (typeof item !== "string") { gaps.push(["environment-item-not-string", service, JSON.stringify(item)]); continue; }
        const i = item.indexOf("=");
        env.set(i < 0 ? item : item.slice(0, i), i < 0 ? null : item.slice(i + 1));
      }
    } else if (e && typeof e === "object") {
      for (const [k, v] of Object.entries(e)) env.set(k, v === null ? null : String(v));
    } else {
      gaps.push(["environment-not-mapping", service, JSON.stringify(e)]);
    }
  }
  return { gaps, forwarded };
}

/**
 * 1-based line of the KEY `needle` inside one service's block — the first
 * non-comment line after the service's own key (at the indentation the first
 * key under `services:` has) and before the next key at that indentation or
 * the next top-level key, spelled `needle`, `"needle"` or `'needle'`, as a
 * mapping key or a list item. 0 when not found (a flow mapping on one line).
 * lineOf() searches the whole file, and the first review pass found a
 * server-side fault reported at migrate's line for every knob both forward;
 * the second found a substring match handing the pointer to
 * `OB1_QUERY_LOG_RETENTION_DAYS` for `OB1_QUERY_LOG`, and to a `command:`
 * line that named the knob — so keys only, regex-escaped.
 */
function lineIn(text, service, needle) {
  const lines = text.split("\n");
  const comment = (l) => /^\s*#/.test(l) || !l.trim();
  const esc = (n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const isKey = (l, name) => new RegExp(`^\\s*(?:-\\s*)?["']?${esc(name)}["']?\\s*(?:[:=]|$)`).test(l);
  const top = lines.findIndex((l) => /^["']?services["']?\s*:/.test(l));
  if (top < 0) return 0;
  const firstKey = lines.findIndex((l, i) => i > top && !comment(l));
  if (firstKey < 0) return 0;
  const indent = /^\s*/.exec(lines[firstKey])[0].length;
  const atIndent = (l) => !comment(l) && /^\s*/.exec(l)[0].length === indent;
  const start = lines.findIndex((l, i) => i > top && atIndent(l) && isKey(l, service));
  if (start < 0) return 0;
  // The block ends at the next service, or the next top-level key — not at a
  // column-0 comment inside it (the third pass: one dropped the pointer).
  let stop = lines.findIndex((l, i) => i > start && (atIndent(l) || (!comment(l) && /^\S/.test(l))));
  if (stop < 0) stop = lines.length;
  const i = lines.findIndex((l, i) => i > start && i < stop && !comment(l) && isKey(l, needle));
  return i < 0 ? 0 : i + 1;
}
const LINE_PROBES = [
  // [yaml, service, needle, expected line]
  ["services:\n  migrate:\n    environment:\n      OB1_A: ${OB1_A:-}\n  server:\n    environment:\n      OB1_A: ${OB1_A:-}\n", "server", "OB1_A", 7],
  ["services:\n  migrate:\n    environment:\n      OB1_A: ${OB1_A:-}\n  server:\n    environment:\n      OB1_A: ${OB1_A:-}\n", "migrate", "OB1_A", 4],
  ["services:\n  server:\n    # OB1_A: in a comment\n    environment:\n      \"OB1_A\": ${OB1_A:-}\n", "server", "OB1_A", 5],
  ["services:\n  server:\n    environment:\n      OB1_A : ${OB1_A:-}\n", "server", "OB1_A", 4],
  ["services:\n  server:\n    environment:\n      OB1_B: 1\n  ollama:\n    environment:\n      OB1_A: 1\n", "server", "OB1_A", 0],
  ["services:\n    server:\n        environment:\n            OB1_A: 1\n", "server", "OB1_A", 4],
  // A longer name sharing the prefix, and a value that names the knob, come first — neither is the key.
  ["services:\n  server:\n    environment:\n      OB1_A_B: 1\n      OB1_AB: 1\n      OB1_A: 1\n", "server", "OB1_A", 6],
  ["services:\n  server:\n    command: [\"x\", \"$OB1_A\"]\n    environment:\n      OB1_B: ${OB1_A:-}\n      OB1_A: 1\n", "server", "OB1_A", 6],
  ["services:\n  'server':\n    environment:\n      OB1_A: 1\n", "server", "OB1_A", 4],
  ["services:\n  server:\n    environment:\n      - OB1_B=1\n      - OB1_A\n", "server", "OB1_A", 5],
  ["services:\n  a-b:\n    environment:\n      OB1_A: 1\n  a.b:\n    environment:\n      OB1_A: 1\n", "a.b", "OB1_A", 7],
  // A column-0 comment inside the block does not end it; the next top-level key does.
  ["services:\n  server:\n    image: x\n# a column-zero comment\n    environment:\n      OB1_A: 1\nvolumes:\n  OB1_A: 1\n", "server", "OB1_A", 6],
];

/** What a value that is not `${NAME}` / `${NAME:-…}` is, for the message. */
function forwardForm(v, name) {
  if (new RegExp(`^\\$\\{${name}-`).test(v)) return "`${X-…}`, a single dash, keeps an EMPTY value from deploy/.env instead of the default";
  if (new RegExp(`^\\$\\{${name}:\\?`).test(v)) return "`${X:?…}` aborts compose on an unset knob that has a default in the code";
  if (new RegExp(`^\\$${name}$`).test(v)) return "a bare `$X` is the form this rule does not read";
  if (/\$\{[^}]*\$\{/.test(v)) return "a nested `${…${…}}` is the form this rule does not read";
  if (new RegExp(`\\$\\{${name}(:|-|\\})`).test(v)) return "the knob's own name with something the rule does not read around or inside it — text before or after the expansion, a second expansion, `:+`, or a `$` in the default";
  if (/^\$\{/.test(v)) return "another variable's name is a miswire";
  return "a literal pins the operator out";
}
const FORM_PROBES = [
  // [value, name, a phrase the message must carry]
  ["${X-a}", "X", "single dash"], ["${X:?a}", "X", "aborts compose"], ["$X", "X", "bare"], ["${X:-${Y}}", "X", "nested"],
  ["on", "X", "literal"], ["${Y:-}", "X", "miswire"],
  ["${X:-}x", "X", "own name"], ["x${X:-}", "X", "own name"], ["${X:+on}", "X", "own name"], ["${X:-$$id}", "X", "own name"], ["${X:-a}${X:-b}", "X", "own name"],
];

const ENV_SOURCE_PROBES = [
  // [source, expected names]
  ["type Env = {\n  A?: string;\n  /** doc with a colon: here */\n  OB1_B: string;\n  lower?: string;\n};\n", ["A", "OB1_B"]],
  ["type Env = {\n  A?: string;\n  B?: string;\n};\nconst x: { C?: string } = {};\n", ["A", "B"]],
  ["const Env = { A: 1 };\n", null],
];
const ENV_READ_PROBES = [
  // [source, expected names]
  ["const a = process.env.OB1_A; const b = env.OB1_B || 1; const c = env?.OB1_C; const d = env[\"OB1_D\"]; const e = ENV.OPEN_BRAIN_E; f(bindings.OB1_F); const g = env().OB1_G;", ["OB1_A", "OB1_B", "OB1_C", "OB1_D", "OPEN_BRAIN_E", "OB1_F", "OB1_G"]],
  // Prose, a string naming the knob, a read through a variable, and a lowercase object are not reads.
  ["// set OB1_A in deploy/.env\nconst m = `OB1_B=${x}`; const v = env[QUERY_LOG.flag]; const w = cfg.OB1_C; const z = process.env.OB1_A;", ["OB1_A"]],
];
// The index is the read's, not the first mention's: the comment comes first here.
const ENV_READ_INDEX_PROBE = ["// OB1_A is read below\nconst a = process.env.OB1_A;", "OB1_A", 23 + 10]; // the read expression starts after the comment line (23) and `const a = ` (10)
/**
 * Knobs db/config.mjs reads that are the migrator's alone — the server's process
 * loads the file but never reaches the read — with the reason.
 */
const READ_FOR_MIGRATOR = {
  OB1_BACKFILL_LIMIT: "migration 023's batch size, read inside the substitutions db/migrate.ts asks for; the server never calls that",
};
const FORWARD_PROBES = [
  // [yaml, expected gap kinds, expected server names → values]
  ["services:\n  server:\n    environment:\n      OB1_A: ${OB1_A:-}\n      OB1_B: ${OB1_B:-x}\n", [], { OB1_A: "${OB1_A:-}", OB1_B: "${OB1_B:-x}" }],
  ["services:\n  server:\n    environment:\n      - OB1_A=${OB1_A:-}\n      - OB1_B\n", [], { OB1_A: "${OB1_A:-}", OB1_B: null }],
  ["x-e: &e\n  environment:\n    OB1_A: ${OB1_A:-}\nservices:\n  server:\n    <<: *e\n    image: x\n", [], { OB1_A: "${OB1_A:-}" }],
  ["services:\n  server:\n    env_file: .env\n    environment:\n      OB1_A: ${OB1_A:-}\n", ["env-file"], { OB1_A: "${OB1_A:-}" }],
  ["services:\n  server:\n    environment: OB1_A=1\n", ["environment-not-mapping"], {}],
  ["services:\n  server:\n    environment:\n      - OB1_A: 1\n      - OB1_B=2\n", ["environment-item-not-string"], { OB1_B: "2" }],
  // A comment and a command line are not forwards.
  ["services:\n  server:\n    # OB1_A: ${OB1_A:-}\n    command: [\"sh\", \"-c\", \"echo ${OB1_B:-}\"]\n    environment:\n      OB1_C: \"1\"\n", [], { OB1_C: "1" }],
  ["- a\n", ["no-services"], {}],
];

/**
 * The decision, pure: `declared` (type Env's names), `documented` (a Set of the
 * example's knob names), `files` = [{ name, doc }] with "compose.yaml" among
 * them; `excused` is NOT_FORWARDED, or a probe's own map. Returns gaps
 * `[kind, file, service, name, detail]`, in the order the
 * rules run: per file — the reader's gaps, then each knob's shape and, under
 * the server, its declaration and excuse; then the base file's universe;
 * stale excuses; dead switches; the fallback.
 */
function serverEnvGapsIn(declared, documented, files, excused = NOT_FORWARDED) {
  const gaps = [];
  const anywhere = new Set();
  let server = null, baseDoc = null, baseSeen = false;
  for (const { name, doc } of files) {
    const { gaps: read, forwarded } = forwardedEnvIn(doc);
    for (const [kind, service, detail] of read) {
      if (kind !== "no-services" && kind !== "unreadable") gaps.push([kind, name, service, null, detail]); // check 13 reports those two
    }
    for (const [service, env] of forwarded) {
      for (const [k, v] of env) {
        if (!KNOB.test(k)) continue;
        anywhere.add(k);
        if (v === null) gaps.push(["bare-item", name, service, k, ""]);
        else if (!new RegExp(`^\\$\\{${k}(:-[^$}]*)?\\}$`).test(v)) gaps.push(["not-house-form", name, service, k, v]);
        if (service === "server") {
          if (!declared.includes(k)) gaps.push(["undeclared", name, "server", k, v]);
          else if (k in excused) gaps.push(["excused-forwarded", name, "server", k, excused[k]]);
        }
      }
    }
    if (name === "compose.yaml") {
      baseSeen = true;
      baseDoc = doc;
      server = forwarded.get("server") ?? null;
      if (!server && !read.some(([kind]) => kind === "no-services")) gaps.push(["no-server", name, null, null, ""]);
    }
  }
  if (!baseSeen) gaps.push(["no-base", "compose.yaml", null, null, ""]);
  if (!server) return gaps;
  for (const k of declared.filter((n) => KNOB.test(n))) {
    if (k in excused) continue; // forwarding it is refused above
    if (!server.has(k)) gaps.push(["unforwarded", "compose.yaml", "server", k, ""]);
    if (!documented.has(k)) gaps.push(["undocumented", ".env.example", null, k, ""]);
  }
  for (const k of Object.keys(excused)) {
    if (!declared.includes(k)) gaps.push(["excuse-stale", null, null, k, ""]);
  }
  for (const k of documented) {
    if (!anywhere.has(k)) gaps.push(["dead-switch", ".env.example", null, k, ""]);
  }
  const fb = /^\$\{OB1_LLM_BASE_URL:-(.+)\}$/.exec(server.get("OB1_LLM_BASE_URL") ?? "");
  if (fb) {
    // Names compare as DNS and preflight's isLocalHostname do: case-insensitively.
    const m = /^http:\/\/([A-Za-z0-9][A-Za-z0-9_.-]*):11434\/v1$/.exec(fb[1]);
    const host = m ? m[1].toLowerCase() : null;
    const ok = host && LOCAL_PROVIDER_SERVICES.includes(host) && Object.keys(baseDoc.services).some((s) => s.toLowerCase() === host);
    if (!ok) gaps.push(["bad-fallback", "compose.yaml", "server", "OB1_LLM_BASE_URL", fb[1]]);
  }
  return gaps;
}
const BASE = (yaml) => ({ name: "compose.yaml", doc: Bun.YAML.parse(yaml) });
const OVERLAY = (yaml) => ({ name: "compose.x.yaml", doc: Bun.YAML.parse(yaml) });
const SRV = (env) => `services:\n  server:\n    environment:\n${env}`;
const DECISION_PROBES = [
  // [declared, documented, files, expected "kind:name" list, excused (none unless given)]
  [["OB1_A", "OB1_B", "OB1_STORE"], ["OB1_A", "OB1_B"], [BASE(SRV("      OB1_A: ${OB1_A:-}\n      OB1_B: ${OB1_B:-x}\n"))], [], { OB1_STORE: "why" }],
  [["OB1_A", "OB1_B"], ["OB1_A", "OB1_B"], [BASE(SRV("      OB1_A: ${OB1_A:-}\n"))], ["unforwarded:OB1_B", "dead-switch:OB1_B"]],
  [["OB1_A"], ["OB1_A", "OB1_C"], [BASE(SRV("      OB1_A: ${OB1_A:-}\n"))], ["dead-switch:OB1_C"]],
  [["OB1_A"], ["OB1_A"], [BASE(SRV("      OB1_A: ${OB1_A:-}\n      OB1_Z: ${OB1_Z:-}\n"))], ["undeclared:OB1_Z"]],
  [["OB1_A", "OB1_B"], ["OB1_A"], [BASE(SRV("      OB1_A: ${OB1_A:-}\n      OB1_B: ${OB1_B:-}\n"))], ["undocumented:OB1_B"]],
  [["OB1_A", "OB1_STORE"], ["OB1_A"], [BASE(SRV("      OB1_A: ${OB1_A:-}\n      OB1_STORE: ${OB1_STORE:-}\n"))], ["excused-forwarded:OB1_STORE"], { OB1_STORE: "why" }],
  [["OB1_A"], ["OB1_A"], [BASE(SRV("      OB1_A: ${OB1_B:-}\n"))], ["not-house-form:OB1_A"]],
  [["OB1_A"], ["OB1_A"], [BASE(SRV("      OB1_A: on\n"))], ["not-house-form:OB1_A"]],
  [["OB1_A"], ["OB1_A"], [BASE(SRV("      - OB1_A\n"))], ["bare-item:OB1_A"]],
  [["OB1_A"], ["OB1_A"], [BASE(SRV("      OB1_A:\n"))], ["bare-item:OB1_A"]],
  // The shape's tail: the knob's own name with a refused tail is not the house form.
  [["OB1_A"], ["OB1_A"], [BASE(SRV("      OB1_A: ${OB1_A:-}x\n"))], ["not-house-form:OB1_A"]],
  [["OB1_A"], ["OB1_A"], [BASE(SRV("      OB1_A: ${OB1_A-}\n"))], ["not-house-form:OB1_A"]],
  [["OB1_A"], ["OB1_A"], [BASE(SRV("      OB1_A: ${OB1_A:?x}\n"))], ["not-house-form:OB1_A"]],
  [["OB1_A"], ["OB1_A"], [BASE(SRV("      OB1_A: ${OB1_A}\n"))], []],
  [["OB1_A"], ["OB1_A"], [BASE(SRV("      - OB1_A=${OB1_A:-}\n"))], []],
  [["OB1_A"], ["OB1_A"], [BASE("services:\n  server:\n    env_file: .env\n    environment:\n      OB1_A: ${OB1_A:-}\n")], ["env-file:"]],
  [["OB1_A"], ["OB1_A"], [BASE("services:\n  migrate:\n    environment:\n      OB1_A: ${OB1_A:-}\n")], ["no-server:"]],
  [["OB1_A"], ["OB1_A"], [OVERLAY(SRV("      OB1_A: ${OB1_A:-}\n"))], ["no-base:"]],
  // A knob not declared by the server is excused in NOT_FORWARDED: the entry is stale.
  [["OB1_A"], ["OB1_A"], [BASE(SRV("      OB1_A: ${OB1_A:-}\n"))], ["excuse-stale:OB1_STORE"], { OB1_STORE: "why" }],
  // The fallback: the stack's own model service passes; another service, or a name the list lacks, does not.
  [["OB1_LLM_BASE_URL"], ["OB1_LLM_BASE_URL"], [BASE("services:\n  server:\n    environment:\n      OB1_LLM_BASE_URL: ${OB1_LLM_BASE_URL:-http://ollama:11434/v1}\n  ollama:\n    image: x\n")], []],
  [["OB1_LLM_BASE_URL"], ["OB1_LLM_BASE_URL"], [BASE("services:\n  server:\n    environment:\n      OB1_LLM_BASE_URL: ${OB1_LLM_BASE_URL:-http://postgres:11434/v1}\n  postgres:\n    image: x\n")], ["bad-fallback:OB1_LLM_BASE_URL"]],
  [["OB1_LLM_BASE_URL"], ["OB1_LLM_BASE_URL"], [BASE("services:\n  server:\n    environment:\n      OB1_LLM_BASE_URL: ${OB1_LLM_BASE_URL:-http://ollama:11434/v1}\n")], ["bad-fallback:OB1_LLM_BASE_URL"]],
  // Names compare as DNS does: a service spelled Ollama, a fallback spelled OLLAMA.
  [["OB1_LLM_BASE_URL"], ["OB1_LLM_BASE_URL"], [BASE("services:\n  server:\n    environment:\n      OB1_LLM_BASE_URL: ${OB1_LLM_BASE_URL:-http://OLLAMA:11434/v1}\n  Ollama:\n    image: x\n")], []],
  // Overlays: the server's names are held there too; a knob forwarded only in an overlay is not a dead switch.
  [["OB1_A"], ["OB1_A"], [BASE(SRV("      OB1_A: ${OB1_A:-}\n")), OVERLAY(SRV("      OB1_Z: ${OB1_Z:-}\n"))], ["undeclared:OB1_Z"]],
  [["OB1_A"], ["OB1_A", "OB1_C"], [BASE(SRV("      OB1_A: ${OB1_A:-}\n")), OVERLAY("services:\n  migrate:\n    environment:\n      OB1_C: ${OB1_C:-}\n")], []],
];

function checkServerEnvForwarded() {
  const SELF = "scripts/check-fork-consistency.mjs";
  const rel = "deploy/compose.yaml";
  if (typeof Bun === "undefined" || typeof Bun.YAML?.parse !== "function") {
    fail(SELF, `check 14 parses deploy/compose*.yaml with Bun.YAML (Bun 1.2+) and this runtime has none — run \`bun ${SELF}\`, as CI does (SMD-1843)`);
    return;
  }
  for (const [source, names] of ENV_SOURCE_PROBES) {
    const got = declaredEnvIn(source);
    if (JSON.stringify(got) !== JSON.stringify(names)) fail(SELF, `env-declaration reader no longer reports ${JSON.stringify(names)} for its probe (reported ${JSON.stringify(got)}): ${JSON.stringify(source)}`);
  }
  for (const [source, names] of ENV_READ_PROBES) {
    const got = envReadsIn(source).map(([n]) => n);
    if (JSON.stringify(got) !== JSON.stringify(names)) fail(SELF, `env-read reader no longer reports ${JSON.stringify(names)} for its probe (reported ${JSON.stringify(got)}): ${JSON.stringify(source)}`);
  }
  {
    const [source, name, index] = ENV_READ_INDEX_PROBE;
    const got = envReadsIn(source).find(([n]) => n === name)?.[1];
    if (got !== index) fail(SELF, `env-read reader no longer reports the read's own index ${index} for \`${name}\` (reported ${got}) — a mention in a comment above the read must not take the pointer: ${JSON.stringify(source)}`);
  }
  for (const [yaml, service, needle, line] of LINE_PROBES) {
    const got = lineIn(yaml, service, needle);
    if (got !== line) fail(SELF, `service-line reader no longer reports line ${line} for \`${needle}\` under \`${service}\` (reported ${got}): ${JSON.stringify(yaml)}`);
  }
  for (const [value, name, phrase] of FORM_PROBES) {
    if (!forwardForm(value, name).includes(phrase)) fail(SELF, `forward-form message for ${JSON.stringify(value)} no longer says "${phrase}": ${JSON.stringify(forwardForm(value, name))}`);
  }
  for (const [yaml, kinds, server] of FORWARD_PROBES) {
    const got = forwardedEnvIn(Bun.YAML.parse(yaml));
    const gotKinds = got.gaps.map((g) => g[0]);
    const gotServer = Object.fromEntries(got.forwarded.get("server") ?? []);
    if (JSON.stringify(gotKinds) !== JSON.stringify(kinds) || JSON.stringify(gotServer) !== JSON.stringify(server)) {
      fail(SELF, `forwarded-env reader no longer reports ${JSON.stringify(kinds)} / ${JSON.stringify(server)} for its probe (reported ${JSON.stringify(gotKinds)} / ${JSON.stringify(gotServer)}): ${JSON.stringify(yaml)}`);
    }
  }
  for (const [declared, documented, files, expected, excused] of DECISION_PROBES) {
    const got = serverEnvGapsIn(declared, new Set(documented), files, excused ?? {}).map(([kind, , , name]) => `${kind}:${name ?? ""}`);
    if (JSON.stringify(got) !== JSON.stringify(expected)) fail(SELF, `check 14's decision no longer reports ${JSON.stringify(expected)} for its probe (reported ${JSON.stringify(got)}): declared ${JSON.stringify(declared)}, documented ${JSON.stringify(documented)}, ${files.map((f) => f.name).join(" + ")}`);
  }

  const knobs = documentedEnvKnobs(KNOB);
  if (knobs === null) return;
  const documented = new Set(knobs.map((k) => k.name));
  const exampleLine = (name) => knobs.find((k) => k.name === name)?.line;

  const sourcePath = join(ROOT, SERVER_ENV_SOURCE);
  if (!existsSync(sourcePath)) { fail(SERVER_ENV_SOURCE, `missing — check 14 reads the knobs the server declares from its \`type Env\` block (SMD-1843)`); return; }
  const declared = declaredEnvIn(readFileSync(sourcePath, "utf8"));
  if (declared === null) { fail(SERVER_ENV_SOURCE, `has no \`type Env = { … };\` block — check 14 reads the knobs the server declares from it; if the declaration moved, move the reader (SMD-1843)`); return; }
  if (!declared.some((n) => KNOB.test(n))) { fail(SERVER_ENV_SOURCE, `\`type Env\` declares no OB1_* or OPEN_BRAIN_* name — check 14 has nothing to hold the compose file to, which cannot be right (SMD-1843)`); return; }

  // The declaration is held honest: a source the container's process loads —
  // every non-test server-portable/*.ts, index.ts included (its typed reads
  // yield nothing; a `process.env.OB1_X` there would), and db/config.mjs,
  // which the server imports and which reads eight knobs through its ENV
  // proxy — that reads a knob straight from the environment declares it, or
  // the universe is short of what runs. The migrator's own knob is excused.
  const srcDir = join(ROOT, "server-portable");
  const sources = readdirSync(srcDir).filter((f) => /\.ts$/.test(f) && !/^test-/.test(f)).sort().map((f) => `server-portable/${f}`);
  sources.push("db/config.mjs");
  const readSomewhere = new Set();
  for (const rel of sources) {
    const source = readFileSync(join(ROOT, rel), "utf8");
    for (const [name, index] of envReadsIn(source)) {
      readSomewhere.add(name);
      if (declared.includes(name) || (rel === "db/config.mjs" && name in READ_FOR_MIGRATOR)) continue;
      fail(`${rel}:${source.slice(0, index).split("\n").length}`, `reads \`${name}\` from the environment, and ${SERVER_ENV_SOURCE}'s \`type Env\` — the one list of what the container's process reads, which check 14 holds deploy/compose.yaml to — does not declare it, so nothing forwards it: declare it there with what it does${rel === "db/config.mjs" ? `, or, when only db/migrate.ts reaches the read, excuse it in READ_FOR_MIGRATOR in ${SELF}` : ""} (SMD-1843)`);
    }
  }
  for (const name of Object.keys(READ_FOR_MIGRATOR)) {
    if (!readSomewhere.has(name)) fail(SELF, `READ_FOR_MIGRATOR excuses \`${name}\`, which db/config.mjs no longer reads — drop the entry (SMD-1843)`);
    if (declared.includes(name)) fail(SELF, `READ_FOR_MIGRATOR excuses \`${name}\` as the migrator's alone, and ${SERVER_ENV_SOURCE}'s \`type Env\` declares it — one of the two is wrong (SMD-1843)`);
  }

  const dir = join(ROOT, "deploy");
  const files = [], texts = new Map();
  for (const name of readdirSync(dir).filter((f) => COMPOSE_FILE.test(f) && statSync(join(dir, f)).isFile()).sort()) {
    const text = readFileSync(join(dir, name), "utf8");
    let doc;
    try { doc = Bun.YAML.parse(text); } catch { if (name === "compose.yaml") return; continue; } // check 13 reports the parse failure; nothing to hold without the base
    files.push({ name, doc });
    texts.set(name, text);
  }
  const at = (file, service, needle) => {
    const frel = `deploy/${file}`;
    const l = texts.has(file) && service && needle ? lineIn(texts.get(file), service, needle) : 0;
    return l ? `${frel}:${l}` : frel;
  };
  const HOUSE = (k) => `\`\${${k}}\` or \`\${${k}:-…}\``;
  for (const [kind, file, service, name, detail] of serverEnvGapsIn(declared, documented, files)) {
    switch (kind) {
      case "env-file": fail(at(file, service, "env_file"), `service \`${service}\` has \`env_file: ${detail}\` — a file this rule does not open, forwarding whatever it holds; name each knob in \`environment:\` instead (SMD-1843)`); break;
      case "environment-not-mapping": fail(at(file, service, "environment"), `service \`${service}\` has \`environment: ${detail}\`, neither a mapping nor a list (SMD-1843)`); break;
      case "environment-item-not-string": fail(at(file, service, "environment"), `service \`${service}\` has ${detail} as an \`environment:\` list item — an item is \`NAME=value\`; a mapping there is the slip compose rejects, and this rule would otherwise count its knob as missing (SMD-1843)`); break;
      case "bare-item": fail(at(file, service, name), `\`${name}\` under \`${service}\` has no value — a bare \`- ${name}\` item, or \`${name}:\` with nothing after it — which compose fills from its own environment: absent in the container when nothing is set, where every other knob here is "", and the runners differ in what that environment is (docker-compose reads deploy/.env for it; measured) — write \`${name}: \${${name}:-}\` (in a list, \`- ${name}=\${${name}:-}\`) (SMD-1843)`); break;
      case "not-house-form": fail(at(file, service, name), `\`${name}: ${detail}\` under \`${service}\` — ${forwardForm(detail, name)}; a knob is forwarded as ${HOUSE(name)}, the operator's value under its own name (SMD-1843)`); break;
      case "undeclared": fail(at(file, "server", name), `\`server.environment\` forwards \`${name}\`, which ${SERVER_ENV_SOURCE} does not declare — \`type Env\` there is the one list of what the container's process reads, so this is a typo, a knob that died, or a knob a module reads without declaring (two were, when this rule first ran): declare it there with what it does, or drop it here (SMD-1843)`); break;
      case "excused-forwarded": fail(at(file, "server", name), `forwards \`${name}\`, which NOT_FORWARDED in ${SELF} says the stack must not: ${detail} (SMD-1843)`); break;
      case "no-server": fail(`deploy/${file}`, `has no \`server\` service — check 14 reads what it forwards to the server (SMD-1843)`); break;
      case "no-base": fail(rel, `missing — check 14 reads the server's environment from it, and SETUP.md brings the stack up with it (SMD-1843)`); break;
      case "unforwarded": fail(at(file, "server", "environment"), `the server reads \`${name}\` (${SERVER_ENV_SOURCE}, type Env) and \`server.environment\` never forwards it, so a value in deploy/.env does nothing and says nothing — add \`${name}: \${${name}:-}\` (or, when the stack must not forward it, the name and the reason to NOT_FORWARDED in ${SELF}) (SMD-1843)`); break;
      case "undocumented": fail("deploy/.env.example", `does not document \`${name}\`, which the server reads and compose forwards — an operator cannot find the knob; add a \`# ${name}=\` line with what it does (SMD-1843)`); break;
      case "excuse-stale": fail(SELF, `NOT_FORWARDED excuses \`${name}\`, which ${SERVER_ENV_SOURCE} no longer declares — drop the entry (SMD-1843)`); break;
      case "dead-switch": fail(`deploy/.env.example${exampleLine(name) ? `:${exampleLine(name)}` : ""}`, `documents \`${name}\`, and no service's \`environment:\` in any deploy/compose*.yaml forwards it, so setting it in deploy/.env does nothing and says nothing — a mention in a comment or on a command line is not a forward (SMD-1843)`); break;
      case "bad-fallback": fail(at(file, "server", name), `OB1_LLM_BASE_URL falls back to \`${detail}\` — the fallback is \`http://<service>:11434/v1\` for a service this file defines and db/config.mjs's LOCAL_PROVIDER_SERVICES names (${LOCAL_PROVIDER_SERVICES.map((n) => `\`${n}\``).join(", ")}: what preflight calls local), the one address that means something inside the compose network; any other default belongs in db/config.mjs or the operator's deploy/.env (SMD-1843)`); break;
      default: throw new Error(`check 14: no message for kind ${kind}`);
    }
  }
}
checkServerEnvForwarded();

/**
 * 9: committed fixtures carry NO thought content (SMD-1295).
 *
 * export-queries.ts redacts a real brain's log to query text and ids, and the
 * replay fixture is ids and vectors, so a fixture can be committed without the
 * corpus. This guards that promise. A committed fixture has a tiny, known shape,
 * so the rule is an ALLOWLIST, not a denylist of field names: every STRING value
 * anywhere in the tree — including array elements and nested objects — must be
 * one of a thought id (a uuid), or text under a key the fixture format defines
 * as free text (`query` — what the caller typed; `note`/`origin`/`generated` —
 * tool-authored labels, deliberately NOT content-adjacent names like `source`).
 * Object KEYS are checked too — a legitimate key is a plain field name or an id,
 * so a thought body smuggled as a key (prose, spaces) fails closed like any value.
 * Any other string is a possible leak — a thought body under `content`, an array
 * of `chunks`, a `title` derived from content, or any newly-added key that is not
 * one of the four free-text ones — and fails closed. The only way to hide content
 * is to put it under those four keys; the fixture format never does, so a future
 * export must not either. A self-test on every run keeps it honest both ways.
 *
 * Note this guards THOUGHT content, not query text: the export fixture's `query`
 * strings are the searcher's own words — personal data — and are allowed here
 * because a replay needs them. Committing an export fixture from a real brain
 * therefore commits real queries; that is a privacy call for the maintainer, and
 * SETUP.md/FORK.md say so. Only the synthetic replay-fixture is truly content-free.
 */
function checkFixtureRedaction() {
  const SELF = "scripts/check-fork-consistency.mjs";
  const FREE_TEXT_KEYS = new Set(["query", "note", "origin", "generated"]);
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  // A structural field name — the only shape an object key legitimately takes in
  // a fixture. A thought body smuggled AS a key (prose, spaces) is not one, so
  // keys are checked too, not just values.
  const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
  // Recurse carrying the nearest object key that governs a value; an array's
  // elements are governed by the array's own key, so `relevant: [uuid]` passes
  // and `chunks: ["body"]` does not.
  const scan = (node, key, path, hits) => {
    if (typeof node === "string") {
      if (node.trim() !== "" && !FREE_TEXT_KEYS.has(key) && !UUID.test(node.trim())) hits.push(`${path} (value under "${key}")`);
      return;
    }
    if (Array.isArray(node)) { node.forEach((v, i) => scan(v, key, `${path}[${i}]`, hits)); return; }
    if (node && typeof node === "object") for (const [k, v] of Object.entries(node)) {
      // A key that is neither a plain field name nor an id is content-shaped.
      if (!IDENT.test(k) && !UUID.test(k)) hits.push(`${path}.${JSON.stringify(k.slice(0, 40))} (object key)`);
      scan(v, k, `${path}.${k}`, hits);
    }
  };
  // Self-test: thought content must be caught however it hides — a plain field,
  // an array of strings, or an off-list key; a query/ids/vectors fixture must not.
  for (const [probe, why] of [
    [{ queries: [{ query: "q", content: "a leaked thought body" }] }, "a `content` field"],
    [{ thoughts: [{ id: "x", chunks: ["a leaked chunk body"] }] }, "content in an array of strings"],
    [{ title: "a leaked title derived from content" }, "content under an off-list key (`title`)"],
    [{ thoughts: { "a leaked thought body used as a key": 1 } }, "content used as an object key"],
  ]) {
    const bad = []; scan(probe, "$", "$", bad);
    if (bad.length === 0) fail(SELF, `fixture redaction check no longer catches ${why} (its own probe)`);
  }
  const good = []; scan(
    { generated: "2026-01-01T00:00:00Z", origin: "query_log", note: "a description",
      queries: [{ query: "how many projects have I led", relevant: ["10000000-0000-4000-8000-000000000001"], baseline: ["10000000-0000-4000-8000-000000000002"] }],
      thoughts: [{ id: "10000000-0000-4000-8000-000000000003", embedding: [0.1, -0.2] }] }, "$", "$", good);
  if (good.length) fail(SELF, `fixture redaction check false-positives on a query/ids/vectors fixture (${good.join(", ")})`);

  const dir = join(ROOT, "evals", "fixtures");
  if (!existsSync(dir)) return;
  for (const file of walk(dir, [], /\.json$/)) {
    let data;
    try { data = JSON.parse(readFileSync(file, "utf8")); }
    catch { fail(relOf(file), "committed fixture is not valid JSON"); continue; }
    const hits = [];
    scan(data, "$", "$", hits);
    for (const h of hits) fail(relOf(file), `committed fixture carries a non-id, non-query string at ${h} — thought content must not be committed (SMD-1295)`);
  }
}
checkFixtureRedaction();

// No display-time filter. One excused `_template` violations, for a placeholder
// link that contributionDirs() has skipped since the filter was written — so
// its only live effect was to hide a check-5 hit in a _template SQL file that
// every contributor copies.
console.log(`Checked ${dirs.length} contributions across ${CATEGORIES.length} categories.`);

if (violations.length === 0) {
  console.log("PASS — no consistency violations.\n");
  process.exit(0);
}

console.error(`\nFAIL — ${violations.length} violation(s):\n`);
for (const v of violations) console.error(`  ${v.where}\n    ${v.msg}`);
console.error("");
process.exit(1);
