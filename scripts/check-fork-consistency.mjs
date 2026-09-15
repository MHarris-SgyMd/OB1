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
 *   7. vendored SQL never redefines or drops a function the core migrations
 *      own — no CREATE [OR REPLACE] FUNCTION, DROP FUNCTION, ALTER FUNCTION or
 *      COMMENT ON FUNCTION naming one, and no COMMENT ON COLUMN of a thoughts
 *      column whose comment a migration writes — in every non-binary file
 *      under the seven category directories whole and docs/, the owned sets
 *      read from db/migrations/, with counted per-(file, function) exceptions
 *      for the files that create a brain rather than add to one
 *
 * Run: bun scripts/check-fork-consistency.mjs   (plain ESM; node runs it too)
 * Exits non-zero on any violation.
 */

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { coreColumnCommentStatement, coreFunctionStatement, ownedColumnCommentsIn, ownedFunctionsIn } from "../db/config.mjs";

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
      if (name === "_template") continue;
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
const BINARY_FILES = /\.(png|jpe?g|gif|webp|svg|ico|woff2?|ttf|otf|pdf|zip|gz|tgz|lock)$|(?:^|\/)(?:package-lock\.json|bun\.lockb?)$/i;

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

/** Every non-binary, non-ignored file under these directories — what checks 6 and 7 read. */
function textFilesUnder(dirs) {
  const ignored = gitIgnoredFiles(dirs);
  return dirs.flatMap((d) => walk(d.dir, [], /./))
    .filter((f) => !BINARY_FILES.test(f) && !ignored.has(relOf(f)));
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
const CORE_FUNCTION_EXCEPTIONS = new Map([
  // Files that create a brain from the getting-started shape, not sidecars
  // that add to one. Exactly this many lines, for exactly these functions.
  ["docs/01-getting-started.md", {
    update_updated_at: { why: "the guide migrations 001-003 were extracted from, creating the brain; SETUP.md sends this fork's readers past it", lines: 1 },
    match_thoughts: { why: "the guide migrations 001-003 were extracted from, creating the brain; SETUP.md sends this fork's readers past it", lines: 1 },
    upsert_thought: { why: "the guide migrations 001-003 were extracted from, creating the brain; SETUP.md sends this fork's readers past it", lines: 1 },
  }],
  ["recipes/content-fingerprint-dedup/README.md", {
    upsert_thought: { why: "the recipe migration 003 was extracted from, kept as its record; the note above its Step 2 says a migrated brain must not paste it", lines: 1 },
  }],
  ["recipes/vercel-neon-telegram/sql/001-create-thoughts.sql", {
    update_updated_at: { why: "creates the recipe's own Neon database from the guide's shape; never run against a migrated brain", lines: 1 },
  }],
  ["recipes/vercel-neon-telegram/sql/002-match-thoughts.sql", {
    match_thoughts: { why: "creates the recipe's own Neon database from the guide's shape; never run against a migrated brain", lines: 1 },
  }],
  ["integrations/kubernetes-deployment/k8s/init.sql", {
    match_thoughts: { why: "the init script of the deployment's own Postgres, run once on an empty database", lines: 1 },
  }],
  ["integrations/kubernetes-deployment/k8s/openbrain.yml", {
    match_thoughts: { why: "the ConfigMap carrying k8s/init.sql, the deployment's own Postgres init, run once on an empty database", lines: 1 },
  }],
  ["recipes/local-brain-no-mcp/volumes/db/init/01-thoughts-schema.sh", {
    update_updated_at: { why: "the init script of the recipe's own Postgres container, run once on an empty database", lines: 1 },
  }],
  ["recipes/local-brain-no-mcp/volumes/db/init/02-match-thoughts-fn.sh", {
    match_thoughts: { why: "the init script of the recipe's own Postgres container, run once on an empty database", lines: 1 },
    upsert_thought: { why: "the init script of the recipe's own Postgres container, run once on an empty database (a third signature, text/vector/jsonb)", lines: 1 },
  }],
]);

/** Which owned functions a text redefines or drops, by the rule the scan applies to the whole text. */
function coreStatementsIn(text) {
  const names = new Set();
  for (const fn of OWNED_FUNCTIONS.keys()) if (coreFunctionStatement(fn).test(text)) names.add(fn);
  return names;
}
/** Which owned column comments a text rewrites. */
function columnCommentsIn(text) {
  const names = new Set();
  for (const col of OWNED_COLUMN_COMMENTS.keys()) if (coreColumnCommentStatement(col).test(text)) names.add(col);
  return names;
}

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
  const scanned = [...CATEGORIES, "docs"].map((c) => ({ dir: join(ROOT, c), rel: c }));
  const before = violations.length;
  const counts = scanLines(textFilesUnder(scanned), [
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

// ── Run ──────────────────────────────────────────────────────────────────────

const dirs = contributionDirs();
for (const d of dirs) {
  const meta = checkMetadata(d);
  checkLinks(d);
  checkDeps(meta, d);
}
checkSqlGuards();
checkShellHazards(dirs);
checkCoreFunctions();

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
 * A setting documented in deploy/.env.example that deploy/compose.yaml never
 * forwards.
 *
 * Compose passes an explicit whitelist, not the whole environment, so a variable
 * present in .env and absent from the `environment:` block reaches nothing. The
 * operator sets it, restarts, and the stack behaves exactly as before — with no
 * error, no warning, and a .env file that documents the setting as real. Six
 * variables were in that state when this check was written, including one added
 * the same day: OB1_CHUNK_TOKENS, OB1_CHUNK_OVERLAP, OB1_CHUNK_CONTEXT,
 * OB1_EMBEDDING_DIMENSIONS, OB1_LLM_API_KEY and OB1_AGENT_CACHE_TTL_MS.
 *
 * Deliberately one-directional: compose may legitimately set variables the
 * example does not mention (OB1_STORE, OB1_PG_POOL, PORT), because those are
 * properties of the stack rather than choices the operator makes in .env.
 */
function checkComposeForwardsDocumentedEnv() {
  const example = readFileSync(join(ROOT, "deploy", ".env.example"), "utf8");
  const compose = readFileSync(join(ROOT, "deploy", "compose.yaml"), "utf8");

  // Both a live `OB1_X=` line and a commented `# OB1_X=` one count as documented:
  // most of these ship commented out precisely because they have a default.
  const documented = new Set(
    [...example.matchAll(/^#?\s*(OB1_[A-Z0-9_]+)=/gm)].map((m) => m[1])
  );
  const forwarded = new Set([...compose.matchAll(/\b(OB1_[A-Z0-9_]+)\b/g)].map((m) => m[1]));

  for (const name of [...documented].sort()) {
    if (!forwarded.has(name)) {
      violations.push({
        where: "deploy/compose.yaml",
        msg: `${name} is documented in deploy/.env.example but never forwarded to a service, ` +
             `so setting it in deploy/.env does nothing and says nothing`,
      });
    }
  }
}
checkComposeForwardsDocumentedEnv();

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
