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
 *      or skip-permissions flag, no wildcard Bash allow, no shell spawn
 *
 * Run: node scripts/check-fork-consistency.mjs
 * Exits non-zero on any violation.
 */

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

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

// ── 5: ADD COLUMN on thoughts must be re-runnable ────────────────────────────

function walk(dir, out = [], match = /\.(sql|md)$/) {
  for (const name of readdirSync(dir)) {
    if (name === ".git" || name === "node_modules") continue;
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, out, match);
    else if (match.test(name)) out.push(p);
  }
  return out;
}

function checkSqlGuards() {
  const re = /alter\s+table\s+(?:public\.)?thoughts\s+add\s+column\s+(?!if\s+not\s+exists)/gi;
  for (const file of walk(ROOT)) {
    const text = readFileSync(file, "utf8");
    const lines = text.split("\n");
    lines.forEach((line, i) => {
      re.lastIndex = 0;
      if (re.test(line)) {
        fail(`${file.slice(ROOT.length + 1)}:${i + 1}`, "ADD COLUMN on thoughts without IF NOT EXISTS");
      }
    });
  }
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
// repo's name does not run an agent with its sandbox off, does not recommend a
// wildcard shell allow, and does not spawn a CLI through a shell. A file that
// must name one of these strings in order to say it was removed is listed as
// an exception, with the reason, so the exception is reviewed rather than
// silent.
const SHELL_HAZARDS = [
  { re: /--dangerously-bypass-approvals-and-sandbox/, what: "Codex's sandbox-bypass flag" },
  { re: /--dangerously-skip-permissions/, what: "Claude Code's skip-permissions flag" },
  { re: /Bash\(\*\)/, what: "a wildcard Bash allow" },
  { re: /\bshell:\s*true\b/, what: "a shell spawn (spawn an argv array without a shell)" },
];
const SHELL_HAZARD_EXCEPTIONS = new Map([
  // Prose that names the deleted flag in order to say it was deleted.
  ["recipes/atomizer/README.md", "the warning that documents the codex provider's removal"],
  ["recipes/atomizer/lib/atomize-text.mjs", "the header note that documents the same removal"],
]);
const SHELL_HAZARD_FILES = /\.(mjs|cjs|js|ts|tsx|md|json|sh|toml|ya?ml)$/;

function checkShellHazards() {
  for (const cat of CATEGORIES) {
    const base = join(ROOT, cat);
    if (!existsSync(base)) continue;
    for (const file of walk(base, [], SHELL_HAZARD_FILES)) {
      const rel = file.slice(ROOT.length + 1);
      if (SHELL_HAZARD_EXCEPTIONS.has(rel)) continue;
      readFileSync(file, "utf8").split("\n").forEach((line, i) => {
        for (const { re, what } of SHELL_HAZARDS) {
          if (re.test(line)) {
            fail(`${rel}:${i + 1}`, `${what} — shipped content must not hand untrusted input a shell (SMD-1251)`);
          }
        }
      });
    }
  }
  // An exception that no longer matches anything is a stale exception: say so,
  // so the list shrinks when the prose it excuses is rewritten.
  for (const [rel, why] of SHELL_HAZARD_EXCEPTIONS) {
    const file = join(ROOT, rel);
    const hit = existsSync(file) && SHELL_HAZARDS.some(({ re }) => re.test(readFileSync(file, "utf8")));
    if (!hit) fail(rel, `listed as a shell-hazard exception (${why}) but matches nothing — remove it from SHELL_HAZARD_EXCEPTIONS`);
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
checkShellHazards();

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

// The upstream _template placeholder link is intentional.
const filtered = violations.filter((v) => !v.where.includes("_template"));

console.log(`Checked ${dirs.length} contributions across ${CATEGORIES.length} categories.`);

if (filtered.length === 0) {
  console.log("PASS — no consistency violations.\n");
  process.exit(0);
}

console.error(`\nFAIL — ${filtered.length} violation(s):\n`);
for (const v of filtered) console.error(`  ${v.where}\n    ${v.msg}`);
console.error("");
process.exit(1);
