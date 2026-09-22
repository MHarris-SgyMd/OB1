#!/usr/bin/env bun
/**
 * check-fork-consistency.ts
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
 *   5. ALTER TABLE thoughts ADD COLUMN is guarded with IF NOT EXISTS, and a
 *      vendored .sql never DROPs or ALTERs a core thoughts column (SMD-1924)
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
 *      (the block's other names — DATABASE_URL, the key material, SUPABASE_*,
 *      the legacy MCP_ACCESS_KEY — are the stack's own wiring or another
 *      target's, outside this rule) — and a server source reading one
 *      straight from the environment declares it there — is forwarded by deploy/compose.yaml's
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
 *  15. FORK.md is the front door and changes/ holds the record: every numbered
 *      change from 18 on is one file changes/NNN-<slug>.md whose first line is
 *      `# N. <title>` with the name's number, the numbers contiguous with no
 *      duplicate (two branches taking one number fail on the tree that holds
 *      both); a file is at most CHANGE_CAP_LINES lines, the files over it at
 *      the split listed in OVERSIZE_AT_SPLIT with a ceiling they may only
 *      shrink under (held stale two ways); FORK.md is under FORK_CEILING_BYTES,
 *      carries no `### N.` section, and its index block equals what
 *      scripts/fork-index.ts renders from the directory (a numbered section
 *      at any heading level is refused in FORK.md); and every "FORK.md change
 *      N" / "FORK change N" / "changes/NNN" / "NNN change M" citation in a file
 *      git tracks or would track (untracked, not ignored), and every bare
 *      "change N" in the record itself, names a number that has a file or a
 *      row of the 1–17 table — lists and wrapped lines included, a thousands
 *      group, a decimal, a date or a number before a unit word excluded, and a
 *      slugged path (or a relative link inside the record) naming the file as
 *      it is. A changes/smd-NNNN.md fragment (16) is held to the name and the
 *      cap here, and listed in the index by ticket until the release step
 *      numbers it (SMD-1917)
 *  16. every changes/smd-NNNN.md fragment is well-formed — one of Keep a
 *      Changelog's six types, a bump the migrations it lists allow (a `patch`
 *      that ships a migration fails), an SMD-#### ticket list; exactly one
 *      `## Changelog` (one to three plain lines naming every listed ticket and
 *      no other — 17b reads a version's tickets from CHANGELOG.md) followed
 *      by exactly one `## FORK`, nothing between them, the FORK body running
 *      to the end of the file with its first line the plain title (no heading
 *      mark, nothing on the second line, ending in every listed ticket — 17b
 *      reads a released ticket from that title) and no numbered heading of its
 *      own — the release step assigns the number and writes the heading
 *      (SMD-1804, SMD-1917); the rules are scripts/fragments.ts's
 *      fragmentProblems, which the release step runs too; the file's name and
 *      line cap are check 15's
 *  17. CHANGELOG.md follows Keep a Changelog 1.1.0 (Unreleased first, versions
 *      dated and descending, only the six headings, compare links resolve); each
 *      released version pairs both ways with releases.json and the numbered
 *      change files' titles (prose, which names pending tickets, is not a
 *      source); a migration inside a released range keeps the sha the release
 *      froze; and
 *      migration 044's schema_version equals db/version.mjs's FORK_VERSION
 *      (SMD-1804)
 *  18. the type-checked directories — server-portable/, compat/supabase-sql/,
 *      db/, evals/ and scripts/ — share one type surface and CI checks each: every one
 *      pins @types/bun, typescript and @types/node in devDependencies at the
 *      value server-portable pins (TypeScript dedupes a package by name and
 *      version, so one directory bumping alone loads two bun-types into the
 *      db and evals programs, whose ../server-portable imports pull the
 *      server's copy), its tsconfig compilerOptions equal the server's, and
 *      .github/workflows/fork-checks.yml runs `bunx tsc --noEmit` under it
 *      exactly once; a tsc step under a directory the list does not name is
 *      refused. The workflow is parsed with Bun.YAML (SMD-1932); no exceptions
 *  19. docs/connector-registry.json — the connector taxonomy's one source — is
 *      sound and complete: the four closed/near-closed facet sets and the
 *      fetcher set equal the ones scripts/connector-registry.ts pins (a
 *      different set is a spec change and edits both); every family declares
 *      its schema and a reserved family is used by no capability; every
 *      artifact is a directory that exists, listed once, its capabilities
 *      naming exactly the five facets and a fetcher from the sets and a
 *      declared family; the connectors are exactly the vendors used, each
 *      with the direction its capabilities derive; the declaration — a
 *      registered artifact's metadata.json `connectors` equals the vendors its
 *      capabilities name, a contribution declaring one is registered, an
 *      excused one declares none; and coverage, the net under it — every
 *      contribution whose metadata.json names a service no not-a-connector
 *      pattern matches at the start of its first word, or of its second after
 *      a qualifier such as "Any" or "Optional:" (a provider first and
 *      qualified after is covered; a vendor first with a provider anywhere
 *      after it is not; a pattern covering a classified vendor's own service
 *      is too broad), carries a connector-shaped tag or
 *      a declared connector's name as a tag (lower-cased), or sits in a
 *      fold-in **SMD-1867** row of docs/vendored-disposition.md whose
 *      directory exists (a row whose directory is gone is a finding) is
 *      classified or excused by name with a reason, never both or neither,
 *      a stale excuse or pattern is refused; and
 *      docs/connector-taxonomy.md's generated tables equal what the registry
 *      renders. The rules are registryProblems, one pure function the
 *      renderer runs too (SMD-1933); no exceptions beyond the registry's own
 *      named excuses
 *  20. main's ruleset is a record in the tree — .github/rulesets/main.json, the
 *      body `gh api -X PUT repos/MHarris-SgyMd/OB1/rulesets/22189960 --input`
 *      applies — and the record names every job: each job's display name in
 *      .github/workflows/fork-checks.yml is a required check, nothing is
 *      required that is not a job, every check is pinned to the Actions app
 *      (integration_id 15368), strict up-to-date is on and enforced on
 *      create, the four rules — deletion, non-fast-forward, pull-request with
 *      no required review and none of the four review flags, required-status-
 *      checks with its parameters — are present once each and no other type
 *      is, the target is the default branch and nothing else, the bypass list
 *      is empty and enforcement is active; and the workflow names its jobs so
 *      the record can — no matrix, no expression in a name, no two jobs
 *      sharing one. The rules are rulesetProblems and workflowJobs, pure
 *      functions their probes run on in-memory records (twenty mutants, eight
 *      non-probes, three workflow mutants); the workflow is parsed with
 *      Bun.YAML (SMD-1856); no exceptions
 *  21. a .sql file never destroys rows a brain already holds — CLAUDE.md's
 *      SQL-safety guard rail read as statements, not words: no DROP TABLE, no
 *      DROP DATABASE or DROP SCHEMA, no TRUNCATE with a table after it (a
 *      trigger event `BEFORE TRUNCATE ON t`, a privilege `GRANT TRUNCATE ON` and
 *      the bare value `TG_OP = 'TRUNCATE'` are not it), no DROP OWNED, no
 *      DELETE FROM whose statement — to its `;` or the `)` closing its CTE,
 *      a literal's parentheses not counted — has no WHERE of its own at the
 *      top level (one in a USING subquery qualifies nothing); comments
 *      excepted by the literal-aware strip, string literals and dollar-quoted
 *      bodies read (an EXECUTE string runs; a statement quoted in prose is a
 *      hit too, and belongs in a `--` comment) — in every .sql git tracks or
 *      would track, db/migrations/ included (the fork's migrations DROP
 *      FUNCTION and DROP TRIGGER, which destroy no row, and none drops a
 *      table); the rules are db/config.mjs's
 *      DESTRUCTIVE_SQL_RULES through destructiveSqlIn, with counted
 *      per-(file, rule) exceptions as 7's (none today) (SMD-1936)
 *  22. no vendored file imports @supabase/supabase-js at runtime — a
 *      specifier-shaped string naming the package (bare, `npm:`, `jsr:`, an
 *      esm.sh URL, a subpath), comments blanked, in any code file under the
 *      seven category directories and docs/: every vendored server reaches the
 *      brain through compat/supabase-sql, and supabase-js stays only as the
 *      parity oracle in compat/ and extensions/package.json and in
 *      server-portable's Workers store; counted per-file exceptions as 7's —
 *      the codemod's KEEP client (local-brain-no-mcp, SMD-1800's) and the
 *      dashboard's type-only import (SMD-1801's) (SMD-1798)
 *
 * Run: bun scripts/check-fork-consistency.ts   (a Bun script — TypeScript, type-checked in CI
 * beside its run (SMD-1870); checks 13, 14, 18 and 20 parse YAML with Bun.YAML)
 * Exits non-zero on any violation.
 */

import { readFileSync, existsSync, readdirSync, statSync, lstatSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { coreColumnCommentStatement, coreFunctionStatement, DESTRUCTIVE_SQL_RULES, destructiveSqlIn, LOCAL_PROVIDER_SERVICES, ownedColumnCommentsIn, ownedFunctionsIn, supabaseIsmsIn } from "../db/config.mjs";
import { CHANGES_DIR, END as INDEX_END, START as INDEX_START, FIRST_FILED, classifyChanges, indexSpan, pad3, readChangeEntries, renderIndex, ticketsOf } from "./fork-index.ts";
import { FORK_VERSION, migrationSha, readReleases, semverCompare } from "../db/version.mjs";
import { fragmentProblems } from "./fragments.ts";
import type { ChangeEntry, ClassifiedChanges, NumberedChange } from "./fork-index.ts";
import { DISPOSITION_PATH, FACET_SETS, FETCHERS, REGISTRY_PATH, SPEC_PATH, VENDOR_PATTERN, dispositionPaths, readMetadata, readRegistry, registryProblems, renderClassification, tablesSpan } from "./connector-registry.ts";
import type { Family, Problem, Registry, Tree } from "./connector-registry.ts";
import { CATEGORIES, contributionDirs } from "./contributions.ts";
import type { ContribDir } from "./contributions.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** One finding: where in the tree, and what. */
type Violation = { where: string; msg: string };
const violations: Violation[] = [];
const fail: (where: string, msg: string) => void = (where, msg) => violations.push({ where, msg });
/** This script, as the `where` of a violation in its own probes and inventories. */
const SELF = "scripts/check-fork-consistency.ts";

/** The slice of .github/metadata.schema.json this check reads: the required names, four fields' enums and sub-properties, and the `connectors` block (SMD-1933) when the schema carries it. */
type MetadataSchema = {
  required: string[];
  properties: Record<string, unknown> & {
    difficulty: { enum: unknown[] };
    category: { enum: unknown[] };
    author: { properties: Record<string, unknown> };
    requires: { properties: Record<string, unknown> };
    connectors?: { items?: { pattern?: string; [k: string]: unknown }; uniqueItems?: boolean; [k: string]: unknown };
  };
};
const schema: MetadataSchema = JSON.parse(readFileSync(join(ROOT, ".github/metadata.schema.json"), "utf8"));
const props = schema.properties;

// The walk of the contribution directories is scripts/contributions.ts's
// contributionDirs — one definition, shared with connector-registry.ts (SMD-1933).

// ── 1 + 2: metadata validity and category/directory agreement ────────────────

/** metadata.json as this check reads it: the fields it inspects by name, everything else by key (the schema decides what is allowed). */
type Metadata = {
  version?: unknown;
  difficulty?: unknown;
  category?: unknown;
  tags?: unknown;
  author?: { name?: unknown; [k: string]: unknown };
  requires?: { open_brain?: unknown; [k: string]: unknown };
  requires_primitives?: string[]; // as the schema requires; check 1 never reads this field, so a scalar reaches checkDeps, which walks its characters as it always did — the schema is the contract
  requires_skills?: string[];
  [k: string]: unknown;
};
function checkMetadata({ cat, dir, rel }: ContribDir) {
  const file = join(dir, "metadata.json");
  if (!existsSync(file)) { fail(rel, "missing metadata.json"); return; }

  let d: Metadata;
  try {
    d = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    fail(`${rel}/metadata.json`, `invalid JSON: ${(e as Error).message}`);
    return;
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
  // The schema's shape for `connectors` (SMD-1933), applied here since no ajv gate runs: a list of
  // distinct kebab-case registry keys. A malformed declaration would read as "declares nothing".
  if ("connectors" in d) {
    if (!Array.isArray(d.connectors)) fail(at, `connectors must be an array of registry keys, got ${JSON.stringify(d.connectors)}`);
    else if (props.connectors?.items?.pattern) { // a schema without the block is check 19's finding, once, not a throw here
      const keyRe = new RegExp(props.connectors.items.pattern); // the schema's pattern, read, not restated
      for (const c of d.connectors) if (typeof c !== "string" || !keyRe.test(c)) fail(at, `connectors entry ${JSON.stringify(c)} is not a key (${props.connectors.items.pattern})`);
      if (props.connectors.uniqueItems && new Set(d.connectors).size !== d.connectors.length) fail(at, "connectors lists a key twice");
    }
  }
  for (const k of ["created", "updated"]) {
    if (k in d && !/^\d{4}-\d{2}-\d{2}$/.test(String(d[k]))) fail(at, `${k} '${d[k]}' is not YYYY-MM-DD`);
  }

  return d;
}

// ── 3: relative links resolve ────────────────────────────────────────────────

function checkLinks({ dir, rel }: ContribDir) {
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

function checkDeps(meta: Metadata | undefined, { rel }: ContribDir) {
  if (!meta) return;
  for (const [field, folder] of [
    ["requires_primitives", "primitives"],
    ["requires_skills", "skills"],
  ] as const) {
    for (const slug of meta[field] ?? []) {
      if (!existsSync(join(ROOT, folder, slug))) {
        fail(`${rel}/metadata.json`, `${field} references '${slug}' but ${folder}/${slug}/ does not exist`);
      }
    }
  }
}

// ── Line scanning, shared by checks 5 and 6 ──────────────────────────────────

/** Repo-relative path with `/` separators on every OS, so it can be a key. */
const relOf = (file: string) => relative(ROOT, file).split(sep).join("/");

function walk(dir: string, out: string[] = [], match = /\.(sql|md)$/) {
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

/** One rule scanLines applies: `re` per line or `fileRe` whole-text (one of the two is set), `only` a path filter, `suppress` the counted-exception hook — see the docblock below. */
type ScanRule = { name?: string; msg: string; re?: RegExp; fileRe?: RegExp; only?: RegExp; suppress?: (rel: string) => boolean };
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
function scanLines(files: string[], rules: ScanRule[]) {
  const counts = new Map<string, number>();
  const hit = (rel: string, rule: ScanRule, line: number, quiet: boolean) => {
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
        lines.forEach((line, i) => { if (rule.re!.test(line)) hit(rel, rule, i + 1, quiet); }); // a rule without fileRe carries re (ScanRule)
      }
    }
  }
  return counts;
}

// ── 5: column ops on core thoughts — ADD is re-runnable, DROP/ALTER is refused ─

function checkSqlGuards() {
  scanLines(walk(ROOT), [{
    name: "add-column-guard",
    re: /alter\s+table\s+(?:public\.)?thoughts\s+add\s+column\s+(?!if\s+not\s+exists)/i,
    msg: "ADD COLUMN on thoughts without IF NOT EXISTS",
  }, {
    // SMD-1924. Adding a column to thoughts is fine (guarded above); dropping
    // or retyping one mutates a structure db/migrations owns, and a vendored
    // file applied to a fork brain must not do it. The hazard was
    // recipes/email-history-import/rollback-chunking-columns.sql (DROP COLUMN
    // parent_id/chunk_index/full_text, the abandoned upstream chunking),
    // removed in SMD-1924. Scoped to vendored .sql: a core migration may own
    // the schema, and a README's rollback-of-its-own-added-columns or an
    // annotated do-not-run example is prose, not an applied file.
    name: "thoughts-column-mutation",
    only: /(?:^|\/)(?:schemas|recipes|integrations)\/.+\.sql$/i,
    fileRe: /alter\s+table\s+(?:public\.)?thoughts\s+(?:drop|alter)\s+column\b/gi,
    msg: "DROP COLUMN / ALTER COLUMN on core thoughts in a vendored file — additive ADD COLUMN … IF NOT EXISTS only; a column drop or retype belongs in a db/ migration",
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
/** A check-6 hazard: its name, the shape it catches (`re` per line or `fileRe` whole-text), an `only` path filter, and the phrase its message opens with. */
type ShellHazard = { name: string; what: string; re?: RegExp; fileRe?: RegExp; only?: RegExp };
const SHELL_HAZARDS: ShellHazard[] = [
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
const SHELL_HAZARD_PROBES: [string, string][] = [
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
/** A counted exception: why the file may match, and for exactly how many lines. */
type CountedException = { why: string; lines: number };
const SHELL_HAZARD_EXCEPTIONS = new Map<string, Record<string, CountedException>>([
  // Prose that names the deleted flag in order to say it was deleted: exactly
  // this many lines, for exactly this hazard.
  ["recipes/atomizer/README.md", { "codex-bypass": { why: "the warning that documents the codex provider's removal", lines: 1 } }],
  ["recipes/atomizer/lib/atomize-text.mjs", { "codex-bypass": { why: "the header note that documents the same removal", lines: 1 } }],
]);
// Text is scanned by construction (checks 6 and 7): only known binary shapes
// and lockfiles are skipped, so an extensionless Dockerfile, Procfile or CNAME
// is read like everything else.
const BINARY_FILES = /\.(png|jpe?g|gif|webp|svg|ico|woff2?|ttf|otf|pdf|zip|gz|tgz|lock|mp3|mp4|mov|m4a|wav|webm|xlsx|docx|pptx|db|sqlite|parquet|bin)$|(?:^|\/)(?:package-lock\.json|bun\.lockb?)$/i;

/**
 * Files git ignores under ROOT — recipe run output (email packs, OAuth state),
 * node_modules, .env — as repo-relative `/` paths. Untrusted text a recipe
 * pulled onto a maintainer's machine must not decide whether the tree passes,
 * and CI on a clean checkout has none of it. Empty when git is unavailable, in
 * which case everything is scanned.
 */
function gitIgnoredFiles(dirs: { rel: string }[]): Set<string> {
  try {
    // Scoped to the directories scanned and unbounded, so a node_modules or a
    // build output elsewhere in the tree cannot overflow the default 1 MiB
    // buffer and turn the skip off silently.
    const out = execFileSync("git", ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--", ...dirs.map((d) => d.rel)],
      { cwd: ROOT, encoding: "utf8", maxBuffer: Infinity });
    return new Set(out.split("\0").filter(Boolean));
  } catch (e) {
    console.warn(`  (git ls-files failed — ${(e as Error).message.split("\n")[0]} — scanning ignored files too)`);
    return new Set();
  }
}

/** Which hazards a text trips, by the same rules scanLines applies (line rules per line, file rules whole). */
function hazardsIn(text: string, rel = "probe.md") {
  const names = new Set<string>();
  for (const h of SHELL_HAZARDS) {
    if (h.only && !h.only.test(rel)) continue;
    const found = h.fileRe ? new RegExp(h.fileRe.source, h.fileRe.flags.replace("g", "")).test(text)
      : text.split("\n").some((line) => h.re!.test(line)); // a hazard without fileRe carries re (ShellHazard)
    if (found) names.add(h.name);
  }
  return names;
}

function checkShellHazards(dirs: ContribDir[]) {
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
    suppress: (rel: string) => Boolean(SHELL_HAZARD_EXCEPTIONS.get(rel)?.[name]),
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
let ignoredFiles: Set<string> | undefined;
function textFilesUnder(dirs: { dir: string; rel: string }[]) {
  ignoredFiles ??= gitIgnoredFiles(SCANNED_ROOTS);
  return dirs.flatMap((d) => walk(d.dir, [], /./))
    .filter((f) => !BINARY_FILES.test(f) && !ignoredFiles!.has(relOf(f))); // assigned by the ??= above; the closure does not see that narrowing
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
  .map((f): [string, string] => [f, readFileSync(join(ROOT, "db", "migrations", f), "utf8")]);
const OWNED_FUNCTIONS = ownedFunctionsIn(MIGRATION_TEXTS);
const OWNED_COLUMN_COMMENTS = ownedColumnCommentsIn(MIGRATION_TEXTS);
/** The whole-text rule as scanLines's `fileRe` (the g flag added; the line reported is the match's first). */
const asFileRe = (re: RegExp) => new RegExp(re.source, re.flags + "g");
/** Strings the rule must catch — the check's own negative tests, run through the scan's machinery every time. */
const CORE_FUNCTION_PROBES: [string, string][] = [
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
const COLUMN_COMMENT_PROBES: [string, string][] = [
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
const one = (why: string): CountedException => ({ why, lines: 1 });
const CORE_FUNCTION_EXCEPTIONS = new Map<string, Record<string, CountedException>>([
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
const namedIn = (owned: Map<string, string>, ruleFor: (name: string) => RegExp, text: string) => new Set([...owned.keys()].filter((name) => ruleFor(name).test(text)));
const coreStatementsIn = (text: string) => namedIn(OWNED_FUNCTIONS, coreFunctionStatement, text);
const columnCommentsIn = (text: string) => namedIn(OWNED_COLUMN_COMMENTS, coreColumnCommentStatement, text);

function checkCoreFunctions() {
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
      suppress: (rel: string) => Boolean(CORE_FUNCTION_EXCEPTIONS.get(rel)?.[fn]),
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
const bound = (N: string) => String.raw`(?:String\(\s*${N}\s*\)|\(\s*${N}\s*(?:\?\?|\|\|)\s*(?:""|'')\s*\)|${N}(?:\?\.|\.)trim\(\)|${N}\b(?!\s*(?:[.(\[]|\?\.)))`;
const envNameOf = (groups: (string | undefined)[]) => groups.find((g) => g !== undefined) ?? "";

/**
 * The 1-based lines of `text` that compare an environment credential with an
 * equality operator, by the rule above. Bindings are collected over the whole
 * text first, so a compare may sit above or below the read it compares.
 */
function credentialComparesIn(text: string) {
  const names = new Set<string>();
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
  const objects = new Set<string>();
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
  const lines = new Set<number>();
  const lineOf = (i: number) => text.slice(0, i).split("\n").length;
  const flag = (re: RegExp, keep: (m: RegExpMatchArray) => boolean = () => true) => {
    for (const m of text.matchAll(re)) if (keep(m)) lines.add(lineOf(m.index));
  };
  const credential = (m: RegExpMatchArray) => CREDENTIAL_ENV_NAME.test(envNameOf(m.slice(1)));
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
    const cred = (m: RegExpMatchArray) => CREDENTIAL_ENV_NAME.test(m[1] ?? m[2] ?? "");
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
const CREDENTIAL_COMPARE_EXCEPTIONS = new Map<string, CountedException>([]);

function checkCredentialCompares() {
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
  const counts = new Map<string, number>();
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
function walkChars(text: string, open: number, visit: (ch: string, i: number, inString: boolean) => boolean | void) {
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
function blockAt(text: string, open: number) {
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
function topLevel(block: string, depth = 1) {
  let d = 0, out = "", last = "";
  const nests: boolean[] = [];
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
function sqlUncommented(sqlText: string) {
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
const sqlFrom = (text: string, from: number) => sqlUncommented(text.slice(from, from + 4000));
/** Whether a literal opening at `text[open]` — `{…}` or `[{…}, …]` — carries either key at the level a table verb reads. */
const literalCarries = (text: string, open: number) => {
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
function thoughtWritesAroundIn(text: string) {
  const lineOf = (i: number) => text.slice(0, i).split("\n").length;
  const lines = new Set<number>();
  // Identifiers bound to a payload with either key: `x = { … content … }` or
  // `x = [{ … }]` (the block walked), `Object.assign(x, { … })`, `x.push({ … })`,
  // `x.content = …`, `x.embedding ??= …`, `x.content += …`, `x["embedding"] = …`.
  const payloads = new Set<string>();
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
    const list = /^([\s\S]*?)(?=\bWHERE\b|\bRETURNING\b|;|$)/.exec(sqlFrom(text, m.index + m[0].length))![1]; // the lookahead's `$` alternative makes this match every string
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
const OWN_DATABASE = (what: string): CountedException => ({ why: `${what} — the fork's functions are not in it, so the capture is a raw row with no fingerprint, no label and no audit actor; the README says so`, lines: 1 });
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
  const counts = new Map<string, number>();
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
function blanked(text: string, stringsToo: boolean) {
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
function importSpecifiers(text: string) {
  const code = blanked(text, false);
  const out: { spec: string; line: number }[] = [];
  for (const m of code.matchAll(/^[ \t]*(?:import|export)\b[^;]*;/gm)) {
    const spec = /\bfrom\s*(["'])([^"'\n]+)\1\s*;$/.exec(m[0]) ?? /^[ \t]*import\s*(["'])([^"'\n]+)\1\s*;$/.exec(m[0]);
    if (spec) out.push({ spec: spec[2], line: code.slice(0, m.index).split("\n").length });
  }
  return out;
}

/** Whether `text` imports the SQL shim by a relative specifier. */
const importsShim = (text: string) => importSpecifiers(text).some((s) => SHIM_SPECIFIER.test(s.spec));

/**
 * The gaps between a shim-importing entry file and running under Bun, as
 * strings: `no-runtime-import` / `runtime-not-first` (the entry, given that it
 * or a dependency uses `Deno`), `deno-member:<m>@<line>` for a member the
 * polyfill does not provide, `specifier:<s>@<line>` for one Bun does not
 * resolve. `deps` are the texts of the files the entry imports, relatively and
 * transitively; their own gaps come back prefixed with their index (`dep0:`).
 * Pure over texts so the probes below need no files.
 */
function shimRuntimeGapsIn(entry: string, deps: string[] = []) {
  const gaps: string[] = [];
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

const SHIM_RUNTIME_PROBES: [string, string][] = [
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
const SHIM_RUNTIME_DEP_PROBES: [string, string, string][] = [
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
    const deps: string[] = [];
    const seen = new Set([file]);
    const queue = [file];
    while (queue.length) {
      const from = queue.shift()!; // the loop runs while queue.length
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
      if (g === "no-runtime-import") fail(rel, `${WHY} (itself or through ${deps.length ? "a file it imports" : "its own text"}) but does not import compat/deno-on-bun.ts — under Bun \`Deno\` is undefined at the first read, under Deno the shim's \`bun\` import fails, so the file runs nowhere; \`bun scripts/migrate-to-sql-shim.ts --apply --all\` adds the line as the first import (SMD-1480, FORK.md change 74)`);
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

/** One knob line of deploy/.env.example: the name, the value after `=`, whether the line is live (not commented out), and its line. */
type EnvKnob = { name: string; value: string; live: boolean; line: number };
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
function envKnobsIn(text: string, pattern: RegExp) {
  const knobs: EnvKnob[] = [];
  // Same-line whitespace only: a `\s*` here once ate the newline and the next
  // knob line as this one's trailing comment, and POSTGRES_BIND went undocumented.
  for (const m of text.matchAll(/^(#?)[ \t]*([A-Z0-9_]+)=(\S*)[ \t]*(?:#.*)?$/gm)) {
    if (pattern.test(m[2])) knobs.push({ name: m[2], value: m[3], live: m[1] === "", line: text.slice(0, m.index).split("\n").length });
  }
  return knobs;
}
const ENV_KNOB_PROBES: [string, RegExp, string[]][] = [
  // [text, pattern, expected names]
  ["# A_BIND=127.0.0.1\n# B_BIND=127.0.0.1\n# C_BIND=127.0.0.1\n", /_BIND$/, ["A_BIND", "B_BIND", "C_BIND"]],
  ["# OB1_X=1536   # hosted; unmeasured\nOB1_Y=\n", /^OB1_/, ["OB1_X", "OB1_Y"]],
  ["# SERVER_BIND=0.0.0.0 is the one an operator sets\n# SERVER_BIND=127.0.0.1\n", /_BIND$/, ["SERVER_BIND"]],
];
let envExampleMissingReported = false; // documentedEnvKnobs reports the missing file once, for its two callers
function documentedEnvKnobs(pattern: RegExp) {
  for (const [text, pat, names] of ENV_KNOB_PROBES) {
    const got = envKnobsIn(text, pat).map((k) => k.name);
    if (JSON.stringify(got) !== JSON.stringify(names)) fail(SELF, `env-knob reader no longer reports exactly ${JSON.stringify(names)} for its probe (reported ${JSON.stringify(got)}): ${JSON.stringify(text)}`);
  }
  const path = join(ROOT, "deploy", ".env.example");
  if (!existsSync(path)) {
    if (!envExampleMissingReported) fail("deploy/.env.example", `missing — the documented knobs are read from it (check 13's _BIND knobs, check 14's OB1_* settings), and SETUP.md tells every operator to copy it`);
    envExampleMissingReported = true;
    return null;
  }
  return envKnobsIn(readFileSync(path, "utf8"), pattern);
}

/** compose file under deploy/ → the services that publish one mapping each from it. */
const PUBLISHES: Record<string, string[]> = {
  "compose.yaml": ["server"],
  "compose.host-ports.yaml": ["postgres", "ollama"],
};
const COMPOSE_FILE = /^(docker-)?compose.*\.ya?ml$/;

const PORT_ITEM = /^\$\{([A-Z0-9_]+)_BIND:-([^}]*)\}:\$\{[A-Z0-9_]+_PORT:-\d+\}:\d+$/;
/** Colon-separated fields of a short-form mapping, `${…}` contents not counted. */
function portFields(v: string) {
  let depth = 0, n = 1;
  for (const ch of v) { if (ch === "{") depth++; else if (ch === "}") depth--; else if (ch === ":" && depth === 0) n++; }
  return n;
}
/** 1-based line of the first non-comment line containing `needle`, for the report; 0 if none. */
function lineOf(text: string, needle: string) {
  const i = text.split("\n").findIndex((l) => !/^\s*#/.test(l) && l.replace(/\s+#.*$/, "").includes(needle));
  return i < 0 ? 0 : i + 1;
}

/** What Bun.YAML.parse yields, spelled out: a mapping is a record of unknowns, a sequence an array, anything else a scalar or null — the readers narrow it by typeof / Array.isArray, as they always did. */
type YamlValue = Record<string, unknown> | unknown[] | string | number | boolean | null;
/** One check-13 gap: `[kind, service, line, detail]` — service null when the file as a whole is at fault, line 0 when none applies. */
type PortGap = [kind: string, service: string | null, line: number, detail: string];
/**
 * One compose file's published ports: `{ gaps: [[kind, service, line, detail]],
 * published: [service, …] }` — `published` lists a service once per house-form
 * mapping, for the inventory.
 */
function publishedPortGapsIn(text: string, { documented }: { documented: Set<string> | null }): { gaps: PortGap[]; published: string[] } {
  const gaps: PortGap[] = [], published: string[] = [];
  if (typeof Bun === "undefined" || typeof Bun.YAML?.parse !== "function") return { gaps: [["no-parser", null, 0, ""]], published };
  let doc: YamlValue;
  try { doc = Bun.YAML.parse(text) as YamlValue; } catch (e) { return { gaps: [["unparseable", null, 0, String((e as Error).message ?? e)]], published }; }
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
const PORT_PROBES: [string, string[], string[]][] = [
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

const dirs = contributionDirs(ROOT);
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
  const hostedModel = (n: string) => n.includes("/");
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
  // SMD-1471: the section names every object (above); it must also spell each
  // object's PRIVILEGES to match ROLE_GRANTS, per group. The README lists a row
  // per (group, object), and an object can carry a different set in two groups
  // (`ob1_config`, `thought_audit`), so a name-only check would miss a
  // privilege that drifted. Read the table rows in order, tracking the group
  // from the bold cell that leads each group's first row (`**capture**`, …),
  // and for every ROLE_GRANTS row compare its (group, object) privileges.
  const rowLines = section.split("\n").filter((l) => l.trimStart().startsWith("|"));
  const documentedPrivs = new Map<string, Set<string>>(); // `${group}\t${name}` -> Set(privileges)
  let group: string | null = null;
  for (const line of rowLines) {
    // A pipe-led, pipe-tailed row splits to ['', groupCell, objectCell, privCell, '']
    // — the leading `**word**` names a group and carries to the rows below it.
    const cells = line.split("|").map((c) => c.trim());
    const gm = /\*\*(\w+)\*\*/.exec(cells[1] ?? "");
    if (gm) group = gm[1];
    if (!group || cells.length < 4) continue; // the header and its `---` separator
    // The privileges are one backticked, comma-separated span at the head of
    // the cell; prose may follow after an em-dash, so read only that span.
    const pm = /`([^`]+)`/.exec(cells[3] ?? "");
    const privs = new Set(pm ? pm[1].split(",").map((p) => p.trim()).filter(Boolean) : []);
    // Every backticked object name in the object cell shares this row's
    // privileges (a community row lists several tables at once). Stray
    // backticked prose (`BIGSERIAL`) becomes a key nothing looks up.
    for (const m of (cells[2] ?? "").matchAll(/`([^`]+)`/g)) {
      documentedPrivs.set(`${group}\t${m[1]}`, privs);
    }
  }
  for (const { group: g, kind, name, privileges } of cfg.grantRows()) {
    const documented = documentedPrivs.get(`${g}\t${name}`);
    if (!documented) {
      // The name check above fires when the object is absent everywhere; this
      // fires when it is present but not in this group's row.
      violations.push({
        where: "db/README.md",
        msg: `"Grants for a capturing role" has no **${g}** row for the ${kind} \`${name}\` that db/config.mjs's ROLE_GRANTS grants in that group — the table and ROLE_GRANTS have drifted (SMD-1471)`,
      });
      continue;
    }
    const missing = privileges.filter((p) => !documented.has(p));
    const extra = [...documented].filter((p) => !privileges.includes(p));
    if (missing.length || extra.length) {
      violations.push({
        where: "db/README.md",
        msg: `the **${g}** row for \`${name}\` lists [${[...documented].join(", ")}] but ROLE_GRANTS grants [${privileges.join(", ")}]${missing.length ? `; the README is missing ${missing.join(", ")}` : ""}${extra.length ? `; the README has extra ${extra.join(", ")}` : ""} — a role would be short or over a privilege the docs claim (SMD-1471)`,
      });
    }
  }
}
await checkCapturingGrants();

/**
 * db/README.md documents every migration: 001–023 as rows in "## The
 * migrations", 024 onward as a "NNN change M" map pointing at FORK.md. Both were
 * kept by hand and drifted (SMD-1696 found the intro count off by one; a map
 * lags a new migration). This holds the two together: every file under
 * db/migrations/ is named exactly once across the table and the map, no
 * documented number lacks a file, and the "N migrations applied" count is the
 * file count. Distinct from check 5b (checkMigrationNumbers), which only forbids
 * two files sharing a number (SMD-1805).
 */
function checkMigrationDoc() {
  const files = readdirSync(join(ROOT, "db", "migrations")).filter((f) => /^\d{3}_.*\.sql$/.test(f));
  const fileNums = files.map((f) => Number(f.slice(0, 3)));
  const readme = readFileSync(join(ROOT, "db", "README.md"), "utf8");
  const tableStart = readme.indexOf("## The migrations");
  const mapStart = readme.indexOf("Migrations 024 onward");
  if (tableStart < 0 || mapStart < 0 || mapStart < tableStart) {
    return fail("db/README.md", 'the migration documentation ("## The migrations" table and the "Migrations 024 onward" map) is not where the coverage check expects it (SMD-1805)');
  }
  const tableText = readme.slice(tableStart, mapStart);
  const mapEnd = readme.indexOf("\n\n", mapStart);
  const mapText = readme.slice(mapStart, mapEnd < 0 ? readme.length : mapEnd);
  const documented = new Set<number>();
  const dup = new Set<number>();
  const note = (n: number) => (documented.has(n) ? dup.add(n) : documented.add(n));
  for (const m of tableText.matchAll(/`(\d{3})_[a-z0-9_]+\.sql`/g)) note(Number(m[1]));
  // "NNN change M" for a hand-numbered change, or "NNN SMD-####" for a migration
  // a fragment introduced — its change number is assigned at release, so it is
  // documented by its stable ticket until then (SMD-1804).
  for (const m of mapText.matchAll(/\b(\d{3}) (?:change \d+|SMD-\d+)/g)) note(Number(m[1]));
  const pad = (n: number) => String(n).padStart(3, "0");
  const missing = fileNums.filter((n) => !documented.has(n)).sort((a, b) => a - b);
  const extra = [...documented].filter((n) => !fileNums.includes(n)).sort((a, b) => a - b);
  if (missing.length) fail("db/README.md", `migration(s) ${missing.map(pad).join(", ")} have a file under db/migrations/ but appear in neither "## The migrations" nor the "024 onward" map — document each (a table row for 001–023, a "NNN change M" map entry otherwise) (SMD-1805)`);
  if (extra.length) fail("db/README.md", `the migration table or map names ${extra.map(pad).join(", ")}, which has no file under db/migrations/ — a renamed or removed migration left a stale entry (SMD-1805)`);
  if (dup.size) fail("db/README.md", `migration(s) ${[...dup].sort((a, b) => a - b).map(pad).join(", ")} are documented more than once across the table and the map (SMD-1805)`);
  const cm = /(\d+)\)?\s+migrations applied/.exec(readme);
  if (!cm) fail("db/README.md", `no "(N) migrations applied" count to check against the ${fileNums.length} files — state it as a digit so it cannot drift (SMD-1805)`);
  else if (Number(cm[1]) !== fileNums.length) fail("db/README.md", `states ${cm[1]} migrations applied but db/migrations/ holds ${fileNums.length} (SMD-1805)`);
}
checkMigrationDoc();

/**
 * server-portable/tools.json is generated from the typed source tools.ts
 * (SMD-1805) — the one place the MCP tool surface is written, so it can carry a
 * `ToolName` union JSON cannot. deploy/smoke.sh (bash) reads the JSON; this
 * holds it to exactly what tools.ts produces, the round-trip the codemod check
 * does for the shim. Bun-only — it imports the TS source through the generator —
 * so a node run skips it in words, as check 13 does.
 */
async function checkToolsManifest() {
  let renderToolsJson: () => string;
  try {
    ({ renderToolsJson } = await import("./gen-tools.ts"));
  } catch (e) {
    console.warn(`  (tools.json round-trip skipped — ${(e as Error).message.split("\n")[0]} — run under bun)`);
    return;
  }
  const have = readFileSync(join(ROOT, "server-portable", "tools.json"), "utf8");
  if (have !== renderToolsJson()) {
    fail("server-portable/tools.json", "does not match its source — the MCP tool surface's typed source is server-portable/tools.ts; run `bun scripts/gen-tools.ts` to regenerate (SMD-1805)");
  }
}
await checkToolsManifest();

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
 * names in server-portable/index.ts's `type Env`; the block's other names
 * (DATABASE_URL, the key material, SUPABASE_*, the legacy MCP_ACCESS_KEY) are
 * the stack's own wiring or another target's, and outside this rule — held
 * honest by a scan of
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
 * `http://<service>:11434/v1` for a service the file or the base defines and
 * db/config.mjs's LOCAL_PROVIDER_SERVICES names — what preflight calls local;
 * held in every file's server, since an overlay's lands in the same container.
 *
 * The decision is one pure function over parsed inputs, serverEnvGapsIn, so
 * DECISION_PROBES run it on in-memory documents every run — the third review
 * pass found the readers and the messages probed and the decision itself not,
 * so a dropped branch stayed invisible while the real file complied.
 */
const SERVER_ENV_SOURCE = "server-portable/index.ts";
const KNOB = /^(OB1_|OPEN_BRAIN_)[A-Z0-9_]+$/;
/** The one shape a knob is forwarded in — `${NAME}` or `${NAME:-default}` — with the default captured; the fallback rule reads the capture. */
const HOUSE_FORM = (k: string) => new RegExp(`^\\$\\{${k}(?::-([^$}]*))?\\}$`);
/** Knobs the server declares that compose.yaml must NOT forward, with the reason its own comment gives. */
const NOT_FORWARDED: Record<string, string> = {
  OB1_STORE: "the SQL store is the server's default (FORK.md change 97) and this stack is the deployment that proves it — forwarding it would let the default drift back to PostgREST with nothing in CI noticing",
};

/** The names `type Env = { … }` declares in a server source, in order; null when the block is not there. */
function declaredEnvIn(source: string): string[] | null {
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
function envReadsIn(source: string) {
  const reads: [string, number][] = [];
  for (const m of source.matchAll(/\b(?:process\.env|env\(\)|env|ENV|bindings)(?:\?\.|\.|\??\[["'])((?:OB1_|OPEN_BRAIN_)[A-Z0-9_]+)\b/g)) {
    if (!reads.some(([n]) => n === m[1])) reads.push([m[1], m.index]);
  }
  return reads;
}

/** A check-14 reader gap: `[kind, service, detail]` — `no-services` alone names no service. */
type EnvGap =
  | [kind: "no-services", service: null, detail: string]
  | [kind: "unreadable" | "env-file" | "environment-item-not-string" | "environment-not-mapping", service: string, detail: string];
/** One service's forwarded environment: name → value, null for a list item with no `=`. */
type ServiceEnv = Map<string, string | null>;
/**
 * One parsed compose document's environment: `forwarded` maps each service to
 * a Map of name → value (null for a list item with no `=`); `gaps` lists
 * `[kind, service, detail]` for what the rule refuses or cannot read.
 */
function forwardedEnvIn(doc: YamlValue) {
  const gaps: EnvGap[] = [], forwarded = new Map<string, ServiceEnv>();
  if (!doc || typeof doc !== "object" || Array.isArray(doc) || !doc.services || typeof doc.services !== "object" || Array.isArray(doc.services)) {
    gaps.push(["no-services", null, ""]);
    return { gaps, forwarded };
  }
  for (const [service, def] of Object.entries(doc.services)) {
    // An unreadable service registers no environment — registering an empty
    // one first made `server: x` cascade into one "never forwards" report per
    // declared knob beside check 13's (the eighth review pass).
    if (!def || typeof def !== "object" || Array.isArray(def)) { gaps.push(["unreadable", service, JSON.stringify(def)]); continue; }
    const env: ServiceEnv = new Map();
    forwarded.set(service, env);
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
function lineIn(text: string, service: string, needle: string) {
  const lines = text.split("\n");
  const comment = (l: string) => /^\s*#/.test(l) || !l.trim();
  const esc = (n: string) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const isKey = (l: string, name: string) => new RegExp(`^\\s*(?:-\\s*)?["']?${esc(name)}["']?\\s*(?:[:=]|$)`).test(l);
  const top = lines.findIndex((l) => /^["']?services["']?\s*:/.test(l));
  if (top < 0) return 0;
  const firstKey = lines.findIndex((l, i) => i > top && !comment(l));
  if (firstKey < 0) return 0;
  const indent = /^\s*/.exec(lines[firstKey])![0].length; // `^\s*` matches every string
  const atIndent = (l: string) => !comment(l) && /^\s*/.exec(l)![0].length === indent; // as above
  const start = lines.findIndex((l, i) => i > top && atIndent(l) && isKey(l, service));
  if (start < 0) return 0;
  // The block ends at the next service, or the next top-level key — not at a
  // column-0 comment inside it (the third pass: one dropped the pointer).
  let stop = lines.findIndex((l, i) => i > start && (atIndent(l) || (!comment(l) && /^\S/.test(l))));
  if (stop < 0) stop = lines.length;
  const i = lines.findIndex((l, i) => i > start && i < stop && !comment(l) && isKey(l, needle));
  return i < 0 ? 0 : i + 1;
}
const LINE_PROBES: [string, string, string, number][] = [
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
function forwardForm(v: string, name: string) {
  if (new RegExp(`^\\$\\{${name}-`).test(v)) return "`${X-…}`, a single dash, keeps an EMPTY value from deploy/.env instead of the default";
  if (new RegExp(`^\\$\\{${name}:\\?`).test(v)) return "`${X:?…}` aborts compose on an unset knob that has a default in the code";
  if (new RegExp(`^\\$${name}$`).test(v)) return "a bare `$X` is the form this rule does not read";
  if (/\$\{[^}]*\$\{/.test(v)) return "a nested `${…${…}}` is the form this rule does not read";
  if (new RegExp(`\\$\\{${name}(:|-|\\})`).test(v)) return "the knob's own name with something the rule does not read around or inside it — text before or after the expansion, a second expansion, `:+`, or a `$` in the default";
  if (/^\$\{/.test(v)) return "another variable's name is a miswire";
  return "a literal pins the operator out";
}
const FORM_PROBES: [string, string, string][] = [
  // [value, name, a phrase the message must carry]
  ["${X-a}", "X", "single dash"], ["${X:?a}", "X", "aborts compose"], ["$X", "X", "bare"], ["${X:-${Y}}", "X", "nested"],
  ["on", "X", "literal"], ["${Y:-}", "X", "miswire"],
  ["${X:-}x", "X", "own name"], ["x${X:-}", "X", "own name"], ["${X:+on}", "X", "own name"], ["${X:-$$id}", "X", "own name"], ["${X:-a}${X:-b}", "X", "own name"],
];

const ENV_SOURCE_PROBES: [string, string[] | null][] = [
  // [source, expected names]
  ["type Env = {\n  A?: string;\n  /** doc with a colon: here */\n  OB1_B: string;\n  lower?: string;\n};\n", ["A", "OB1_B"]],
  ["type Env = {\n  A?: string;\n  B?: string;\n};\nconst x: { C?: string } = {};\n", ["A", "B"]],
  ["const Env = { A: 1 };\n", null],
];
const ENV_READ_PROBES: [string, string[]][] = [
  // [source, expected names]
  ["const a = process.env.OB1_A; const b = env.OB1_B || 1; const c = env?.OB1_C; const d = env[\"OB1_D\"]; const e = ENV.OPEN_BRAIN_E; f(bindings.OB1_F); const g = env().OB1_G;", ["OB1_A", "OB1_B", "OB1_C", "OB1_D", "OPEN_BRAIN_E", "OB1_F", "OB1_G"]],
  // Prose, a string naming the knob, a read through a variable, and a lowercase object are not reads.
  ["// set OB1_A in deploy/.env\nconst m = `OB1_B=${x}`; const v = env[QUERY_LOG.flag]; const w = cfg.OB1_C; const z = process.env.OB1_A;", ["OB1_A"]],
];
// The index is the read's, not the first mention's: the comment comes first here.
const ENV_READ_INDEX_PROBE: [string, string, number] = ["// OB1_A is read below\nconst a = process.env.OB1_A;", "OB1_A", 23 + 10]; // the read expression starts after the comment line (23) and `const a = ` (10)
/**
 * Knobs db/config.mjs reads that are the migrator's alone — the server's process
 * loads the file but never reaches the read — with the reason.
 */
const READ_FOR_MIGRATOR: Record<string, string> = {
  OB1_BACKFILL_LIMIT: "migration 023's batch size, read inside the substitutions db/migrate.ts asks for; the server never calls that",
};
const FORWARD_PROBES: [string, string[], Record<string, string | null>][] = [
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
  ["services:\n  server: x\n", ["unreadable"], {}],
];

/** One compose file, parsed: its name under deploy/ and its document. */
type ComposeFile = { name: string; doc: YamlValue };
/**
 * One check-14 gap: `[kind, file, service, name, detail]` — the slots a kind fills are the ones
 * its message reads, so the `switch` in checkServerEnvForwarded narrows them by kind.
 */
type ServerEnvGap =
  | [kind: "env-file" | "environment-not-mapping" | "environment-item-not-string", file: string, service: string, name: null, detail: string]
  | [kind: "bare-item" | "not-house-form" | "excused-forwarded" | "unforwarded" | "bad-fallback", file: string, service: string, name: string, detail: string]
  | [kind: "undeclared", file: string, service: string, name: string, detail: string | null]
  | [kind: "no-server" | "no-base", file: string, service: null, name: null, detail: string]
  | [kind: "undocumented" | "dead-switch", file: string, service: null, name: string, detail: string]
  | [kind: "excuse-stale", file: null, service: null, name: string, detail: string];
/**
 * The decision, pure: `declared` (type Env's names), `documented` (a Set of the
 * example's knob names), `files` = [{ name, doc }] with "compose.yaml" among
 * them; `excused` is NOT_FORWARDED, or a probe's own map. Returns gaps
 * `[kind, file, service, name, detail]`, in the order the
 * rules run: per file — the reader's gaps, then each knob's shape and, under
 * the server, its declaration and excuse; then the base file's universe;
 * stale excuses; dead switches; the fallback.
 */
function serverEnvGapsIn(declared: string[], documented: Set<string>, files: ComposeFile[], excused: Record<string, string> = NOT_FORWARDED) {
  const gaps: ServerEnvGap[] = [];
  const anywhere = new Set<string>();
  const forwardedBy = new Map<string, Map<string, ServiceEnv>>(); // file name → its services' environments, read once
  let server: ServiceEnv | null = null, baseDoc: YamlValue | null = null, baseSeen = false;
  for (const { name, doc } of files) {
    const { gaps: read, forwarded } = forwardedEnvIn(doc);
    forwardedBy.set(name, forwarded);
    for (const [kind, service, detail] of read) {
      if (kind !== "no-services" && kind !== "unreadable") gaps.push([kind, name, service, null, detail]); // check 13 reports those two
    }
    for (const [service, env] of forwarded) {
      for (const [k, v] of env) {
        if (!KNOB.test(k)) continue;
        anywhere.add(k);
        if (v === null) gaps.push(["bare-item", name, service, k, ""]);
        else if (!HOUSE_FORM(k).test(v)) gaps.push(["not-house-form", name, service, k, v]);
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
      if (!server && !read.some(([kind, service]) => kind === "no-services" || (kind === "unreadable" && service === "server"))) gaps.push(["no-server", name, null, null, ""]);
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
  // The fallback is held wherever a file's server sets it — an overlay's
  // `OB1_LLM_BASE_URL: ${OB1_LLM_BASE_URL:-https://…}` lands in the same
  // container (the fifth pass found only the base file's read) — and the
  // service may be defined in that file or the base.
  for (const { name, doc } of files) {
    const env = forwardedBy.get(name)!.get("server"); // set for every file by the first loop
    // The captured default of a house-form value; a value the shape rule refused was reported above and draws no second report here.
    const fb = HOUSE_FORM("OB1_LLM_BASE_URL").exec(env?.get("OB1_LLM_BASE_URL") ?? "");
    if (!fb?.[1]) continue;
    // Names compare as DNS and preflight's isLocalHostname do: case-insensitively.
    const m = /^http:\/\/([A-Za-z0-9][A-Za-z0-9_.-]*):11434\/v1$/.exec(fb[1]);
    const host = m ? m[1].toLowerCase() : null;
    const defined = (d: YamlValue | null) => Object.keys((d as Record<string, unknown> | null)?.services ?? {}).some((s) => s.toLowerCase() === host); // `?.services` on a non-mapping is undefined, which the `?? {}` answers; the cast says only that
    const ok = host && LOCAL_PROVIDER_SERVICES.includes(host) && (defined(baseDoc) || defined(doc));
    if (!ok) gaps.push(["bad-fallback", name, "server", "OB1_LLM_BASE_URL", fb[1]]);
  }
  return gaps;
}
// Text, not documents: the probes are parsed inside the check, after its
// Bun.YAML guard — parsing here at module scope made the whole script throw
// under node before any check reported (the seventh review pass).
const BASE = (yaml: string) => ({ name: "compose.yaml", yaml });
const OVERLAY = (yaml: string) => ({ name: "compose.x.yaml", yaml });
const SRV = (env: string) => `services:\n  server:\n    environment:\n${env}`;
const DECISION_PROBES: [string[], string[], { name: string; yaml: string }[], string[], Record<string, string>?][] = [
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
  // An unreadable server is check 13's one report, not a cascade of "never forwards" here.
  [["OB1_A"], ["OB1_A"], [BASE("services:\n  server: x\n")], []],
  [["OB1_A"], ["OB1_A"], [OVERLAY(SRV("      OB1_A: ${OB1_A:-}\n"))], ["no-base:"]],
  // A knob not declared by the server is excused in NOT_FORWARDED: the entry is stale.
  [["OB1_A"], ["OB1_A"], [BASE(SRV("      OB1_A: ${OB1_A:-}\n"))], ["excuse-stale:OB1_STORE"], { OB1_STORE: "why" }],
  // The fallback: the stack's own model service passes; another service, or a name the list lacks, does not.
  [["OB1_LLM_BASE_URL"], ["OB1_LLM_BASE_URL"], [BASE("services:\n  server:\n    environment:\n      OB1_LLM_BASE_URL: ${OB1_LLM_BASE_URL:-http://ollama:11434/v1}\n  ollama:\n    image: x\n")], []],
  [["OB1_LLM_BASE_URL"], ["OB1_LLM_BASE_URL"], [BASE("services:\n  server:\n    environment:\n      OB1_LLM_BASE_URL: ${OB1_LLM_BASE_URL:-http://postgres:11434/v1}\n  postgres:\n    image: x\n")], ["bad-fallback:OB1_LLM_BASE_URL"]],
  [["OB1_LLM_BASE_URL"], ["OB1_LLM_BASE_URL"], [BASE("services:\n  server:\n    environment:\n      OB1_LLM_BASE_URL: ${OB1_LLM_BASE_URL:-http://ollama:11434/v1}\n")], ["bad-fallback:OB1_LLM_BASE_URL"]],
  // An overlay's fallback is held too: a hosted one is refused; the stack's own service, defined in the overlay, passes.
  [["OB1_LLM_BASE_URL"], ["OB1_LLM_BASE_URL"], [BASE("services:\n  server:\n    environment:\n      OB1_LLM_BASE_URL: ${OB1_LLM_BASE_URL:-http://ollama:11434/v1}\n  ollama:\n    image: x\n"), OVERLAY(SRV("      OB1_LLM_BASE_URL: ${OB1_LLM_BASE_URL:-https://openrouter.ai/api/v1}\n"))], ["bad-fallback:OB1_LLM_BASE_URL"]],
  [["OB1_LLM_BASE_URL"], ["OB1_LLM_BASE_URL"], [BASE(SRV("      OB1_LLM_BASE_URL: ${OB1_LLM_BASE_URL:-}\n")), OVERLAY("services:\n  server:\n    environment:\n      OB1_LLM_BASE_URL: ${OB1_LLM_BASE_URL:-http://ollama:11434/v1}\n  ollama:\n    image: x\n")], []],
  // Names compare as DNS does: a service spelled Ollama, a fallback spelled OLLAMA.
  [["OB1_LLM_BASE_URL"], ["OB1_LLM_BASE_URL"], [BASE("services:\n  server:\n    environment:\n      OB1_LLM_BASE_URL: ${OB1_LLM_BASE_URL:-http://OLLAMA:11434/v1}\n  Ollama:\n    image: x\n")], []],
  // Overlays: the server's names are held there too; a knob forwarded only in an overlay is not a dead switch.
  [["OB1_A"], ["OB1_A"], [BASE(SRV("      OB1_A: ${OB1_A:-}\n")), OVERLAY(SRV("      OB1_Z: ${OB1_Z:-}\n"))], ["undeclared:OB1_Z"]],
  [["OB1_A"], ["OB1_A", "OB1_C"], [BASE(SRV("      OB1_A: ${OB1_A:-}\n")), OVERLAY("services:\n  migrate:\n    environment:\n      OB1_C: ${OB1_C:-}\n")], []],
];

function checkServerEnvForwarded() {
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
    const got = forwardedEnvIn(Bun.YAML.parse(yaml) as YamlValue);
    const gotKinds = got.gaps.map((g) => g[0]);
    const gotServer = Object.fromEntries(got.forwarded.get("server") ?? []);
    if (JSON.stringify(gotKinds) !== JSON.stringify(kinds) || JSON.stringify(gotServer) !== JSON.stringify(server)) {
      fail(SELF, `forwarded-env reader no longer reports ${JSON.stringify(kinds)} / ${JSON.stringify(server)} for its probe (reported ${JSON.stringify(gotKinds)} / ${JSON.stringify(gotServer)}): ${JSON.stringify(yaml)}`);
    }
  }
  for (const [declared, documented, probeFiles, expected, excused] of DECISION_PROBES) {
    const files = probeFiles.map(({ name, yaml }) => ({ name, doc: Bun.YAML.parse(yaml) as YamlValue }));
    const got = serverEnvGapsIn(declared, new Set(documented), files, excused ?? {}).map(([kind, , , name]) => `${kind}:${name ?? ""}`);
    if (JSON.stringify(got) !== JSON.stringify(expected)) fail(SELF, `check 14's decision no longer reports ${JSON.stringify(expected)} for its probe (reported ${JSON.stringify(got)}): declared ${JSON.stringify(declared)}, documented ${JSON.stringify(documented)}, ${probeFiles.map((f) => f.name).join(" + ")}`);
  }

  const knobs = documentedEnvKnobs(KNOB);
  if (knobs === null) return;
  const documented = new Set(knobs.map((k) => k.name));
  const exampleLine = (name: string) => knobs.find((k) => k.name === name)?.line;

  const sourcePath = join(ROOT, SERVER_ENV_SOURCE);
  if (!existsSync(sourcePath)) { fail(SERVER_ENV_SOURCE, `missing — check 14 reads the knobs the server declares from its \`type Env\` block (SMD-1843)`); return; }
  const indexSource = readFileSync(sourcePath, "utf8"); // read once: the declaration here, the read scan below
  const declared = declaredEnvIn(indexSource);
  if (declared === null) { fail(SERVER_ENV_SOURCE, `has no \`type Env = { … };\` block — check 14 reads the knobs the server declares from it; if the declaration moved, move the reader (SMD-1843)`); return; }
  if (!declared.some((n) => KNOB.test(n))) { fail(SERVER_ENV_SOURCE, `\`type Env\` declares no OB1_* or OPEN_BRAIN_* name — check 14 has nothing to hold the compose file to, which cannot be right (SMD-1843)`); return; }

  // The declaration is held honest: a source the container's process loads —
  // every non-test server-portable/*.ts, index.ts included (its `env().X`
  // reads are matched and declared by construction, since env() returns Env;
  // a `process.env.OB1_X` there would not be), and db/config.mjs,
  // which the server imports and which reads eight knobs through its ENV
  // proxy — that reads a knob straight from the environment declares it, or
  // the universe is short of what runs. The migrator's own knob is excused.
  const sources: string[] = [];
  const walk = (dir: string) => {
    for (const f of readdirSync(join(ROOT, dir)).sort()) {
      const srcRel = `${dir}/${f}`;
      if (statSync(join(ROOT, srcRel)).isDirectory()) { if (f !== "node_modules") walk(srcRel); }
      else if (/\.ts$/.test(f) && !/^test-/.test(f)) sources.push(srcRel);
    }
  };
  walk("server-portable"); // subdirectories too (shims/) — the fifth pass found the walk flat
  if (!sources.includes("server-portable/shims/bun-unavailable.ts")) fail(SELF, `check 14's read scan no longer reaches server-portable/shims/ (bun-unavailable.ts is not in its list) — a knob read in a subdirectory would go undeclared unseen (SMD-1843)`);
  sources.push("db/config.mjs");
  const readSomewhere = new Set();
  for (const srcRel of sources) {
    const source = srcRel === SERVER_ENV_SOURCE ? indexSource : readFileSync(join(ROOT, srcRel), "utf8");
    for (const [name, index] of envReadsIn(source)) {
      readSomewhere.add(name);
      if (declared.includes(name) || (srcRel === "db/config.mjs" && name in READ_FOR_MIGRATOR)) continue;
      fail(`${srcRel}:${source.slice(0, index).split("\n").length}`, `reads \`${name}\` from the environment, and ${SERVER_ENV_SOURCE}'s \`type Env\` — the one list of what the container's process reads, which check 14 holds deploy/compose.yaml to — does not declare it, so nothing forwards it: declare it there with what it does${srcRel === "db/config.mjs" ? `, or, when only db/migrate.ts reaches the read, excuse it in READ_FOR_MIGRATOR in ${SELF}` : ""} (SMD-1843)`);
    }
  }
  for (const name of Object.keys(READ_FOR_MIGRATOR)) {
    if (!readSomewhere.has(name)) fail(SELF, `READ_FOR_MIGRATOR excuses \`${name}\`, which db/config.mjs no longer reads — drop the entry (SMD-1843)`);
    if (declared.includes(name)) fail(SELF, `READ_FOR_MIGRATOR excuses \`${name}\` as the migrator's alone, and ${SERVER_ENV_SOURCE}'s \`type Env\` declares it — one of the two is wrong (SMD-1843)`);
  }

  const dir = join(ROOT, "deploy");
  const files: ComposeFile[] = [], texts = new Map<string, string>();
  for (const name of readdirSync(dir).filter((f) => COMPOSE_FILE.test(f) && statSync(join(dir, f)).isFile()).sort()) {
    const text = readFileSync(join(dir, name), "utf8");
    let doc: YamlValue;
    try { doc = Bun.YAML.parse(text) as YamlValue; } catch { if (name === "compose.yaml") return; continue; } // check 13 reports the parse failure; nothing to hold without the base
    files.push({ name, doc });
    texts.set(name, text);
  }
  const at = (file: string, service: string | null, needle: string | null) => {
    const frel = `deploy/${file}`;
    const l = texts.has(file) && service && needle ? lineIn(texts.get(file)!, service, needle) : 0; // has() just tested
    return l ? `${frel}:${l}` : frel;
  };
  const HOUSE = (k: string) => `\`\${${k}}\` or \`\${${k}:-…}\``;
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
      case "bad-fallback": fail(at(file, "server", name), `OB1_LLM_BASE_URL falls back to \`${detail}\` — the fallback is \`http://<service>:11434/v1\` for a service this file or compose.yaml defines and db/config.mjs's LOCAL_PROVIDER_SERVICES names (${LOCAL_PROVIDER_SERVICES.map((n) => `\`${n}\``).join(", ")}: what preflight calls local), the one address that means something inside the compose network; any other default belongs in db/config.mjs or the operator's deploy/.env (SMD-1843)`); break;
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
  const FREE_TEXT_KEYS = new Set(["query", "note", "origin", "generated"]);
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  // A structural field name — the only shape an object key legitimately takes in
  // a fixture. A thought body smuggled AS a key (prose, spaces) is not one, so
  // keys are checked too, not just values.
  const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
  // Recurse carrying the nearest object key that governs a value; an array's
  // elements are governed by the array's own key, so `relevant: [uuid]` passes
  // and `chunks: ["body"]` does not.
  const scan = (node: unknown, key: string, path: string, hits: string[]): void => {
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
    const bad: string[] = []; scan(probe, "$", "$", bad);
    if (bad.length === 0) fail(SELF, `fixture redaction check no longer catches ${why} (its own probe)`);
  }
  const good: string[] = []; scan(
    { generated: "2026-01-01T00:00:00Z", origin: "query_log", note: "a description",
      queries: [{ query: "how many projects have I led", relevant: ["10000000-0000-4000-8000-000000000001"], baseline: ["10000000-0000-4000-8000-000000000002"] }],
      thoughts: [{ id: "10000000-0000-4000-8000-000000000003", embedding: [0.1, -0.2] }] }, "$", "$", good);
  if (good.length) fail(SELF, `fixture redaction check false-positives on a query/ids/vectors fixture (${good.join(", ")})`);

  const dir = join(ROOT, "evals", "fixtures");
  if (!existsSync(dir)) return;
  for (const file of walk(dir, [], /\.json$/)) {
    let data: unknown;
    try { data = JSON.parse(readFileSync(file, "utf8")); }
    catch { fail(relOf(file), "committed fixture is not valid JSON"); continue; }
    const hits: string[] = [];
    scan(data, "$", "$", hits);
    for (const h of hits) fail(relOf(file), `committed fixture carries a non-id, non-query string at ${h} — thought content must not be committed (SMD-1295)`);
  }
}
checkFixtureRedaction();

// ── 15: FORK.md is the front door; changes/ holds the record (SMD-1917) ──────
//
// FORK.md reached 1.23 MB and 17,700 lines — larger than any context window, so
// every reader took a slice by grep — and its `### N.` sections were numbered by
// hand in one file, so every merge of main renumbered a section and left the
// code comments citing the old number silently wrong. Every change from 18 on is
// one file under changes/ now, and this holds the layout: the names and the
// numbers, the line cap, FORK.md's own size, the generated index, and every
// citation of a change number in the tree.

/** FORK.md's byte ceiling, measured outside the generated index — the front door's prose, not the record (~16k tokens; 50 KB at the split). */
const FORK_CEILING_BYTES = 64 * 1024;
/** A change file's line cap. The shape is in changes/README.md. */
const CHANGE_CAP_LINES = 150;
/**
 * The files over the cap when the split landed, with the ceiling each may only
 * shrink under (its line count then, rounded up to ten). Held stale two ways: an
 * entry for a file that now fits under the cap, or for a number with no file,
 * fails until it is dropped. The sizes are the files' at the merge that landed the
 * split (main's PR #95 had added two lines to 69). 102 was cut to the shape and is absent;
 * 103 (SMD-1541) landed on main as a hand-numbered section while the split was in
 * review — the last one the transition allowed — and joins the list.
 */
const OVERSIZE_AT_SPLIT: Record<number, number> = {
  24: 160, 28: 710, 30: 200, 32: 230, 33: 160, 34: 190, 35: 160, 36: 180, 37: 210, 38: 340, 39: 280,
  40: 250, 41: 270, 51: 240, 52: 220, 56: 380, 57: 160, 58: 210, 60: 170, 61: 350, 63: 250, 64: 420, 66: 210,
  67: 430, 69: 310, 70: 380, 71: 340, 72: 410, 73: 220, 74: 330, 75: 240, 76: 310, 77: 450, 78: 200, 79: 230, 80: 430,
  81: 300, 84: 210, 90: 290, 91: 470, 93: 250, 94: 340, 95: 360, 97: 240, 98: 270, 99: 290,
  103: 320, // landed hand-numbered on main (PR #95) during SMD-1804's transition, after the split
};

/**
 * Change numbers a text cites by the explicit shapes every file may use:
 * "FORK.md change N" — also "FORK change N", "FORK.md's change N", "changes N
 * and M", "changes N, M, and O", "FORK.md, change N", "FORK.md §N", "FORK.md
 * section N" — a `changes/NNN` path, and db/README.md's migration map row
 * "NNN change M". `record` adds the bare "change N" / "Change N" (and the same
 * lists) the record itself uses (FORK.md and the change files, where "change"
 * means nothing else). A number followed by `-NN-` is a date, not a change;
 * "18-20" with a plain hyphen is still a range.
 * Returns [{ n, index }].
 */
// A number is not a thousands group ("changes 1,536 rows" is a count) nor a date
// ("change 2026-09-21"). A list continues after "and", a dash or a slash, or
// after a comma when another item or "and" follows — so "(FORK.md change 90,
// 250 ms)" and "change 90, 2 of them" cite 90 alone while "changes 31, 53, and
// 89" cites all three. A continuation number is three digits at most: change
// 1000, should the fork get there, is read in the leading position only.
// A number is a change number unless it is a thousands group ("1,536 rows"), a
// date ("2026-09-21"), a decimal ("0.51 R@10") or is followed by a unit or count
// word ("no behaviour change 250 ms", "a schema change 200 lines long") — the
// record measures in the same sentences it cites in. The unit list is the
// record's vocabulary, a heuristic held by its probes: a false report is fixed
// by rewording, a miss by adding the word here.
const UNIT_WORDS = String.raw`ms|[µμ]s|s|sec(?:ond)?s?|min(?:ute)?s?|h|hours?|rows?|lines?|files?|bytes?|[KMGT]i?B|%|dims?|dimensions?|tokens?|passes?|times|commits?|queries|thoughts?|vectors?|sections?|entries|items?|chars?|characters|words?|columns?|tables?|calls?|runs?`;
const LINE_WRAP = String.raw`[ \t]*(?:\r?\n[ \t]*)?`; // the same line or a wrap onto the next, never across a blank line
const UNIT = String.raw`(?!${LINE_WRAP}(?:${UNIT_WORDS})(?!\w))`;
const NUM = String.raw`\b(?!-\d\d-)(?!,\d{3}\b)(?!\.\d)${UNIT}`;
// "18–20, 22" and "3, 4, 5." read whole, across a wrapped line: a bare comma item
// continues before another item, before "and", or at the end of the clause;
// ", change N" always continues. The one cost is a unit-less number in
// parentheses — "(change 90, 250)" cites 250 — a shape no site writes.
const SEP = String.raw`,${LINE_WRAP}`; // a comma item may wrap onto an indented continuation line; a blank line still stops
const CITED_LIST = String.raw`(\d+)${NUM}((?:(?:,?\s+and|–|—|-|\/)\s?(?:change )?\d{1,3}${NUM}|${SEP}change \d{1,3}${NUM}|${SEP}\d{1,3}${NUM}(?=${SEP}(?:change )?\d|,?\s+and\s|\s+(?:of|per)\b|\s*(?:[.;:)\]]|$)))*)`;
// A slugged path names a file as it is — a mis-cased or underscored slug is read
// so that check 15 can report the dead link, not skipped as "not a path".
const CHANGE_PATH = String.raw`(?<![\w/.-])(?:\.\.?\/)*changes\/(\d{3})([-_][\w-]+\.md)?(?![\w-])(?!\.[\w-])`; // ./ and ../ allowed; not docs/changes/…, not …md.bak; a sentence may end after it
// Inside the record a link may be relative: `(079-the-store.md)` beside the file.
const RECORD_PATH = String.raw`\((?:\.\/)?(\d{3})([-_][\w-]+\.md)(?:#[\w-]*)?(?: "[^"\n]*")?\)`;
// The file name may sit in a code span (\`FORK.md\` change N) or behind ../ .
// Code comments cite as "SMD-1541 (change 103)" or "(SMD-1541; change 103)": a
// bare "change N" within a few words of a ticket is a citation anywhere; and
// "(FORK 79)" — the file's name and a number — is one too (the NUM guard keeps
// "FORK.md 61,543 bytes" and "FORK.md 828 lines" out).
const TICKETED = String.raw`\bSMD-\d+[^\n]{0,40}?\(?[Cc]hanges?\s${CITED_LIST}`;
const EXPLICIT_CITATION = new RegExp(String.raw`\b(?:\.\.\/)?FORK(?:\.md)?\x60?(?:'s)?,?\s(?:(?:[Cc]hange|section|§) ?s?\s?)?${CITED_LIST}|${CHANGE_PATH}|\b\d{3} change (\d+)\b|${TICKETED}`, "gm");
const BARE_CITATION = new RegExp(String.raw`\b[Cc]hanges?\s${CITED_LIST}|${RECORD_PATH}`, "gm");
/** A change number a text cites, at the offset of its citation; `name` when it was cited as a `changes/NNN-<slug>.md` path. */
type Citation = { n: number; index: number; name?: string };
/** [{ n, index, name? }] — `name` when the citation is a `changes/NNN-<slug>.md` path, which must exist as such. */
function citedChangesIn(text: string, { record = false }: { record?: boolean } = {}) {
  const out: Citation[] = [];
  const list = (m: RegExpMatchArray, index: number = m.index!) => { // the default is taken for a real match alone, whose index is set
    out.push({ n: Number(m[1]), index });
    for (const t of m[2].matchAll(/\d+/g)) out.push({ n: Number(t[0]), index });
  };
  let rest = text; // the record's bare reader runs over the text with the explicit spans blanked: one report per site
  for (const m of text.matchAll(EXPLICIT_CITATION)) {
    if (m[3] !== undefined) out.push({ n: Number(m[3]), index: m.index, ...(m[4] ? { name: `${m[3]}${m[4]}` } : {}) });
    else if (m[5] !== undefined) out.push({ n: Number(m[5]), index: m.index });
    else if (m[6] !== undefined) list([m[0], m[6], m[7]], m.index);
    else list(m);
    rest = rest.slice(0, m.index) + " ".repeat(m[0].length) + rest.slice(m.index + m[0].length);
  }
  if (record) for (const m of rest.matchAll(BARE_CITATION)) {
    if (m[3] !== undefined) out.push({ n: Number(m[3]), index: m.index, name: `${m[3]}${m[4]}` });
    else list(m);
  }
  return out;
}
const CITATION_PROBES: [string, boolean, number[]][] = [
  ["see FORK.md change 58: the statements", false, [58]],
  ["named in FORK.md changes 38 and 40 updated a", false, [38, 40]],
  ["(FORK.md, change 64) and FORK.md §50 and FORK.md section 12", false, [64, 50, 12]],
  ["[the file](changes/102-every-knob-the-server-reads-reaches.md) and changes/018-long-captures-stay-searchable.md and changes/044", false, [102, 18, 44]],
  ["changes/README.md and change 42 in prose", false, []],
  ["change 42 in prose, Changes 3 and 4, changed 5 times", true, [42, 3, 4]],
  ["FORK.md changes 18-20 and 22", false, [18, 20, 22]],
  ["(FORK.md change 90, 1536 dims) and FORK.md change 90 and 1,536 vectors", false, [90, 90]],
  ["FORK.md Change 42 and FORK.md change\n43", false, [42, 43]],
  ["FORK.md change 42 once, once only", true, [42]],
  ["which changes 1,536 rows and change 42; FORK.md change 1,000", true, [42]],
  ["(FORK.md change 90, 250 ms) and FORK.md change 90, 2 of them", false, [90, 90, 2]], // "2 of them" reads as a list item: a miss on "changes 31, 53 of the record" would be silent, a false report here is bounded to a number above the highest change
  ["Ten (changes 31, 53, 55, 59, and 89) ship; changes 31, 53", true, [31, 53, 55, 59, 89, 31, 53]],
  ["FORK.md changes 3, 4, 5. Then FORK.md changes 18–20, 22; FORK.md change 90, change 91, change 92", false, [3, 4, 5, 18, 20, 22, 90, 91, 92]],
  ["`FORK.md` change 43 and `FORK.md` §50 and `../FORK.md` §48", false, [43, 50, 48]],
  ["(FORK.md change 31, 0.51 R@10) and FORK.md change 31, 12.3 ms.", false, [31, 31]],
  ["no behaviour change 250 ms after; a schema change 200 lines long; changes 3, 4 and 500 rows; change 5 of 6", true, [3, 4, 5]],
  ["Like FORK.md changes 31, 53\nand 999; FORK.md changes 5, 6,\n7 and 8; changes 31,\n53. And changes 31,\n53 then", true, [31, 53, 999, 5, 6, 7, 8, 31, 53, 31]],
  ["- FORK.md changes 5, 6,\n  7 and 8; changes 31,\n\n53", true, [5, 6, 7, 8, 31]],
  ["change 42% of them, change 5 seconds later, change 6 minutes, change 7 hours, change 8 μs", true, []],
  ["FORK.md changes 31 and 53 of the record; changes 3, 4 and 500 rows; see FORK.md change 999\n\nlines later", true, [31, 53, 999, 3, 4]], // explicit citations first, then the record's bare ones
  ["changes 31, 53 of the record; FORK.md change 42 of this fork; change 5 of 6", true, [42, 31, 53, 5]],
  ["SMD-1541 (change 103): the key; (SMD-1541; change 103 has the why); SMD-1228 changes 38 and 40; SMD-1 is not change-free", false, [103, 103, 38, 40]],
  ["SMD-1037 (FORK 79), (FORK 82) and FORK.md 61,543 bytes, FORK.md 828 lines", false, [79, 82]],
  ["see changes/104-x.md. And ../changes/020-x.md and ./changes/021-y.md and changes/022-z.md.bak", false, [104, 20, 21]],
  ["docs/changes/104-x.md and changes/105-y.md.bak and changes/106-z.md", false, [106]],
  ["since FORK.md change 90, one per id a capture names", false, [90]],
  ["024 change 45\n025 change 46\n044 SMD-1804", false, [45, 46]],
  ["033's header and FORK change 62 state it; FORK §79; FORK.md's change 12", false, [62, 79, 12]],
  ["Ten (changes 31, 53, 55, and 89) ship nothing", true, [31, 53, 55, 89]],
  ["measured on change 2026-09-21 and change 42", true, [42]],
  ["FORK.md change 2026-09-21 is a date", false, []],
];

/** A citation as the layout decision sees it: where in the tree, the number, and the file name when it was cited as a path. */
type LayoutCitation = { where: string; n: number; name?: string };
/** forkLayoutProblems' inputs; the constants default to the shipped values, a probe passes its own. */
type LayoutArgs = { entries: ChangeEntry[]; forkText: string; citations?: LayoutCitation[]; ceilings?: Record<number, number>; cap?: number; forkCeiling?: number };
/**
 * The layout decision, pure: what changes/ holds (as `{ name, text }` entries),
 * FORK.md's text, the citations found in the tree, and the constants. Returns
 * [{ where, kind, msg }]; the caller turns them into failures.
 */
function forkLayoutProblems({ entries, forkText, citations = [], ceilings = OVERSIZE_AT_SPLIT, cap = CHANGE_CAP_LINES, forkCeiling = FORK_CEILING_BYTES }: LayoutArgs) {
  const problems: { where: string; kind: string; msg: string }[] = [];
  const at = (where: string, kind: string, msg: string) => problems.push({ where, kind, msg });
  const changes = classifyChanges(entries);
  const { numbered, other } = changes;
  for (const o of other) at(`${CHANGES_DIR}/${o.name}`, "bad-name", o.text === null
    ? "is not a regular file (a directory, a symlink, a pipe) — changes/ holds change files and fragments alone"
    : "is neither a numbered change (NNN-<slug>.md: three digits, a dash, lower-case ASCII words) nor a release fragment (smd-NNNN.md) — the index cannot list it");
  const byTicket = new Map<string, string>();
  for (const f of changes.fragments) {
    if (byTicket.has(f.ticket)) at(`${CHANGES_DIR}/${f.name}`, "duplicate-fragment", `is a second fragment for ${f.ticket} beside ${CHANGES_DIR}/${byTicket.get(f.ticket)} — one PR, one fragment; the release step would number both`);
    else byTicket.set(f.ticket, f.name);
  }
  if (numbered.length === 0) { at(CHANGES_DIR, "no-files", `holds no numbered change file — every change from ${FIRST_FILED} on is one`); }
  const byN = new Map<number, NumberedChange>();
  for (const c of numbered) {
    if (c.n < FIRST_FILED) at(`${CHANGES_DIR}/${c.name}`, "below-first", `carries change number ${c.n}; changes 1–${FIRST_FILED - 1} are FORK.md's table and have no file`);
    if (byN.has(c.n)) at(`${CHANGES_DIR}/${c.name}`, "duplicate", `carries change number ${c.n}, which ${CHANGES_DIR}/${byN.get(c.n)!.name} already carries — two branches took one number; the later one takes the next free number and its citations move with it`);
    else byN.set(c.n, c);
  }
  const hi = numbered.length ? numbered[numbered.length - 1].n : FIRST_FILED - 1;
  for (let n = FIRST_FILED; n <= hi; n++) if (!byN.has(n)) at(CHANGES_DIR, "gap", `has no file for change ${n} — the numbers run contiguously from ${FIRST_FILED} to the highest (${hi})`);
  for (const c of numbered) {
    if (!c.heading) at(`${CHANGES_DIR}/${c.name}`, "heading", "does not open with `# N. <title>` on its first line — the index reads the title from it");
    else if (c.heading.n !== c.n) at(`${CHANGES_DIR}/${c.name}`, "heading", `opens with \`# ${c.heading.n}.\` but its name says ${c.n} — the citations follow the name`);
    const ceiling = ceilings[c.n];
    if (c.lines > cap) {
      if (ceiling === undefined) at(`${CHANGES_DIR}/${c.name}`, "oversize", `is ${c.lines} lines; a change file is at most ${cap} — a review pass is a table row, a finding worth more is a follow-up ticket (changes/README.md)`);
      else if (c.lines > ceiling) at(`${CHANGES_DIR}/${c.name}`, "oversize", `is ${c.lines} lines; it was over the cap at the split and may only shrink — its ceiling in OVERSIZE_AT_SPLIT is ${ceiling}`);
    } else if (ceiling !== undefined) at(SELF, "excuse-stale", `OVERSIZE_AT_SPLIT lists change ${c.n} (ceiling ${ceiling}) but ${CHANGES_DIR}/${c.name} is ${c.lines} lines, under the cap — drop the entry`);
  }
  for (const n of Object.keys(ceilings).map(Number)) if (!byN.has(n)) at(SELF, "excuse-stale", `OVERSIZE_AT_SPLIT lists change ${n}, which has no file — drop the entry`);
  for (const f of changes.fragments) if (f.lines > cap) at(`${CHANGES_DIR}/${f.name}`, "oversize", `is ${f.lines} lines; a fragment becomes a change file and is held to the same ${cap} — a review pass is a table row (changes/README.md)`);
  const sec = /^(#{1,6}) (\d+)\. /m.exec(forkText.replace(/^```[\s\S]*?^```/gm, "")); // a `# 1. fetch` comment in a fenced snippet is not a section
  if (sec) at("FORK.md", "section-in-fork", `carries a \`${sec[1]} ${sec[2]}.\` section — a numbered change is a file, ${CHANGES_DIR}/${String(sec[2]).padStart(3, "0")}-<slug>.md, and this file lists it`);
  let span: { s: number; e: number } | null = null;
  try { span = indexSpan(forkText); } catch (e) { at("FORK.md", "index-missing", `${(e as Error).message} — the generated index lives between them`); }
  // The ceiling is the front door's prose: the generated index between the
  // markers grows a row per release and is not what the ceiling is for.
  const prose = span ? forkText.slice(0, span.s) + forkText.slice(span.e) : forkText;
  const bytes = Buffer.byteLength(prose, "utf8");
  if (bytes > forkCeiling) at("FORK.md", "fork-oversize", `is ${bytes} bytes outside the generated index; the front door stays under ${forkCeiling} — a change's record belongs in its file under ${CHANGES_DIR}/, not here`);
  if (span && forkText.slice(span.s, span.e) !== "\n" + renderIndex(changes)) at("FORK.md", "index-stale", `the index between the markers is not what ${CHANGES_DIR}/ renders to — run \`bun scripts/fork-index.ts\``);
  for (const c of citations) {
    if (c.n < 1 || (c.n >= FIRST_FILED && !byN.has(c.n)) || (c.name && c.n < FIRST_FILED)) at(c.where, "dangling", `cites change ${c.n}${c.name ? ` as ${CHANGES_DIR}/${c.name}` : ""}, which has no file under ${CHANGES_DIR}/ (1–${FIRST_FILED - 1} are FORK.md's table; the highest with a file is ${hi}) — a renumber left this behind, or the file is missing`);
    else if (c.name && byN.get(c.n)!.name !== c.name) at(c.where, "dangling", `cites ${CHANGES_DIR}/${c.name}, and change ${c.n}'s file is ${CHANGES_DIR}/${byN.get(c.n)!.name} — the file was renamed under the link`); // has(c.n) held by the branch above
  }
  return problems;
}

const LAYOUT_ENTRIES = (...files: [string, string | null][]): ChangeEntry[] => files.map(([name, text]) => ({ name, text }));
const CH = (n: number, title = "A thing — a consequence (SMD-1)", body = "Body.\n"): [string, string] => [`${String(n).padStart(3, "0")}-a-thing.md`, `# ${n}. ${title}\n\n${body}`];
const FORK_FOR = (entries: ChangeEntry[], extra = "") => `# FORK\n\nintro\n\n${INDEX_START}\n${renderIndex(classifyChanges(entries))}${INDEX_END}\n\ntail\n${extra}`;
const LONG = "line\n".repeat(200);
const LAYOUT_PROBES: [string, () => LayoutArgs, string[]][] = [
  // [label, args, expected kinds]
  ["a consistent layout", () => { const en = LAYOUT_ENTRIES(CH(18), CH(19), ["README.md", "x"], ["smd-1804.md", "---\n"]); return { entries: en, forkText: FORK_FOR(en), ceilings: {}, citations: [{ where: "a.ts:1", n: 19 }, { where: "b.md:2", n: 3 }] }; }, []],
  ["a stray name", () => { const en = LAYOUT_ENTRIES(CH(18), ["notes.md", "x"]); return { entries: en, forkText: FORK_FOR(en), ceilings: {} }; }, ["bad-name"]],
  ["a fragment over the cap", () => { const en = LAYOUT_ENTRIES(CH(18), ["smd-9.md", "---\n" + LONG]); return { entries: en, forkText: FORK_FOR(en), ceilings: {} }; }, ["oversize"]],
  ["two files with one number", () => { const en = LAYOUT_ENTRIES(CH(18), ["018-other.md", "# 18. Other\n"]); return { entries: en, forkText: FORK_FOR(en), ceilings: {} }; }, ["duplicate"]],
  ["a gap", () => { const en = LAYOUT_ENTRIES(CH(18), CH(20)); return { entries: en, forkText: FORK_FOR(en), ceilings: {} }; }, ["gap"]],
  ["a missing 18", () => { const en = LAYOUT_ENTRIES(CH(19)); return { entries: en, forkText: FORK_FOR(en), ceilings: {} }; }, ["gap"]],
  ["no files at all", () => { const en = LAYOUT_ENTRIES(); return { entries: en, forkText: FORK_FOR(en), ceilings: {} }; }, ["no-files"]],
  ["a heading with the wrong number", () => { const en = LAYOUT_ENTRIES(["018-a-thing.md", "# 19. A thing\n"]); return { entries: en, forkText: FORK_FOR(en), ceilings: {} }; }, ["heading"]],
  ["no heading", () => { const en = LAYOUT_ENTRIES(["018-a-thing.md", "A thing\n"]); return { entries: en, forkText: FORK_FOR(en), ceilings: {} }; }, ["heading"]],
  ["an unlisted file over the cap", () => { const en = LAYOUT_ENTRIES(CH(18, undefined, LONG)); return { entries: en, forkText: FORK_FOR(en), ceilings: {} }; }, ["oversize"]],
  ["a listed file over its ceiling", () => { const en = LAYOUT_ENTRIES(CH(18, undefined, LONG)); return { entries: en, forkText: FORK_FOR(en), ceilings: { 18: 190 } }; }, ["oversize"]],
  ["a listed file under its ceiling", () => { const en = LAYOUT_ENTRIES(CH(18, undefined, LONG)); return { entries: en, forkText: FORK_FOR(en), ceilings: { 18: 210 } }; }, []],
  ["a listed file that now fits", () => { const en = LAYOUT_ENTRIES(CH(18)); return { entries: en, forkText: FORK_FOR(en), ceilings: { 18: 210 } }; }, ["excuse-stale"]],
  ["a listing with no file", () => { const en = LAYOUT_ENTRIES(CH(18)); return { entries: en, forkText: FORK_FOR(en), ceilings: { 44: 210 } }; }, ["excuse-stale"]],
  ["FORK.md over its ceiling", () => { const en = LAYOUT_ENTRIES(CH(18)); return { entries: en, forkText: FORK_FOR(en, "x".repeat(100)), ceilings: {}, forkCeiling: 150 }; }, ["fork-oversize"]],
  ["a numbered section left in FORK.md", () => { const en = LAYOUT_ENTRIES(CH(18)); return { entries: en, forkText: FORK_FOR(en, "\n### 19. Left behind\n"), ceilings: {} }; }, ["section-in-fork"]],
  ["no index markers", () => { const en = LAYOUT_ENTRIES(CH(18)); return { entries: en, forkText: "# FORK\nno markers\n", ceilings: {} }; }, ["index-missing"]],
  ["a duplicated end marker", () => { const en = LAYOUT_ENTRIES(CH(18)); return { entries: en, forkText: FORK_FOR(en, INDEX_END + "\n"), ceilings: {} }; }, ["index-missing"]],
  ["a `## N.` section left in FORK.md", () => { const en = LAYOUT_ENTRIES(CH(18)); return { entries: en, forkText: FORK_FOR(en, "\n## 19. Left behind\n"), ceilings: {} }; }, ["section-in-fork"]],
  ["a change file's own `# N.` heading pasted into FORK.md", () => { const en = LAYOUT_ENTRIES(CH(18)); return { entries: en, forkText: FORK_FOR(en, "\n# 19. Pasted\n"), ceilings: {} }; }, ["section-in-fork"]],
  ["a leading zero in the heading", () => { const en = LAYOUT_ENTRIES(["018-a-thing.md", "# 018. A thing\n"]); return { entries: en, forkText: FORK_FOR(en), ceilings: {} }; }, ["heading"]],
  ["a stray file of another extension", () => { const en = LAYOUT_ENTRIES(CH(18), ["notes.txt", "x"]); return { entries: en, forkText: FORK_FOR(en), ceilings: {} }; }, ["bad-name"]],
  ["a directory (or symlink, or pipe) under changes/", () => { const en = LAYOUT_ENTRIES(CH(18), ["drafts", null]); return { entries: en, forkText: FORK_FOR(en), ceilings: {} }; }, ["bad-name"]],
  ["a numbered file below 18", () => { const en = LAYOUT_ENTRIES(CH(18), ["005-below.md", "# 5. Below (SMD-1)\n"]); return { entries: en, forkText: FORK_FOR(en), ceilings: {} }; }, ["below-first"]],
  ["a dotfile the OS left", () => { const en = LAYOUT_ENTRIES(CH(18), [".DS_Store", "x"]); return { entries: en, forkText: FORK_FOR(en), ceilings: {} }; }, []],
  ["two fragments for one ticket", () => { const en = LAYOUT_ENTRIES(CH(18), ["smd-9.md", "---\n"], ["smd-09.md", "---\n"]); return { entries: en, forkText: FORK_FOR(en), ceilings: {} }; }, ["duplicate-fragment"]],
  ["a stale index", () => { const en = LAYOUT_ENTRIES(CH(18), CH(19)); return { entries: en, forkText: FORK_FOR(en.slice(0, 1)), ceilings: {} }; }, ["index-stale"]],
  ["a citation above the highest", () => { const en = LAYOUT_ENTRIES(CH(18)); return { entries: en, forkText: FORK_FOR(en), ceilings: {}, citations: [{ where: "a.ts:1", n: 19 }] }; }, ["dangling"]],
  ["a citation of change 0", () => { const en = LAYOUT_ENTRIES(CH(18)); return { entries: en, forkText: FORK_FOR(en), ceilings: {}, citations: [{ where: "a.ts:1", n: 0 }] }; }, ["dangling"]],
  ["a citation of a gapped number", () => { const en = LAYOUT_ENTRIES(CH(18), CH(20)); return { entries: en, forkText: FORK_FOR(en), ceilings: {}, citations: [{ where: "a.ts:1", n: 19 }] }; }, ["gap", "dangling"]],
  ["a path citation under an old slug", () => { const en = LAYOUT_ENTRIES(CH(18)); return { entries: en, forkText: FORK_FOR(en), ceilings: {}, citations: [{ where: "a.md:1", n: 18, name: "018-old-name.md" }, { where: "b.md:1", n: 18, name: "018-a-thing.md" }] }; }, ["dangling"]],
  ["a path citation of a table change (no file can exist)", () => { const en = LAYOUT_ENTRIES(CH(18)); return { entries: en, forkText: FORK_FOR(en), ceilings: {}, citations: [{ where: "a.md:1", n: 5, name: "005-below.md" }] }; }, ["dangling"]],
];

const SKIP_DIRS = new Set([".git", "node_modules", ".planning", ".cf-out", ".claude", "dist", "build", ".wrangler"]);
/**
 * Every text file a citation can live in: what git tracks plus what it would
 * track (untracked, not ignored) — so a change file not yet added is read, and a
 * pulled email under an ignored data/ directory, an .env or a local corpus is
 * not, as .gitignore promises of this check. Without git (a copied tree), a walk
 * that skips the usual build and tool directories, symlinks left alone. Binary
 * names and files over 4 MB are skipped either way. Repo-relative paths.
 */
function citationFiles() {
  let names: string[];
  try {
    // A nested repository (an agent worktree under .claude/) is listed as `dir/`,
    // a deleted-but-indexed file has no stat, a symlink is followed by nothing
    // here: regular files alone, as the walk below keeps. An untracked file a
    // harness left behind IS read — that is the rule, not a slip.
    names = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: ROOT, encoding: "utf8", maxBuffer: Infinity })
      .split("\0").filter(Boolean);
  } catch (e) {
    console.warn(`  (git ls-files failed — ${(e as Error).message.split("\n")[0]} — walking the tree for citations, ignored files too)`);
    names = [];
    const walkFor = (dir: string) => {
      for (const name of readdirSync(dir).sort()) {
        const full = join(dir, name);
        const st = lstatSync(full);
        if (st.isSymbolicLink()) continue;
        if (st.isDirectory()) { if (!SKIP_DIRS.has(name)) walkFor(full); continue; }
        names.push(relative(ROOT, full).split(sep).join("/"));
      }
    };
    walkFor(ROOT);
  }
  const regular = (rel: string) => { try { const st = lstatSync(join(ROOT, rel)); return st.isFile() && st.size <= 4 * 1024 * 1024; } catch { return false; } };
  // Not this script: its probe strings are citation shapes, not citations.
  return names.filter((rel) => rel !== SELF && !BINARY_FILES.test(rel) && !rel.split("/").includes("node_modules") && regular(rel));
}

/** An offset → 1-based line number function for one text: the line starts are indexed once, then each lookup is a binary search. */
function lineIndexer(text: string) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return (index: number) => { let lo = 0, hi = starts.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= index) lo = mid; else hi = mid - 1; } return lo + 1; };
}

/** changes/ read once per run: the classified entries with their text, for checks 15, 16 and 17b. */
let changesCache: (ClassifiedChanges & { entries: ChangeEntry[] }) | null = null;
function changesOnDisk() {
  if (!changesCache) {
    const entries = readChangeEntries(ROOT);
    changesCache = { entries, ...classifyChanges(entries) };
  }
  return changesCache;
}

function checkForkLayout() {
  for (const [text, record, want] of CITATION_PROBES) {
    const got = citedChangesIn(text, { record }).map((c) => c.n);
    if (JSON.stringify(got) !== JSON.stringify(want)) fail(SELF, `check 15's citation reader returns [${got}] for ${JSON.stringify(text)}, expected [${want}] (its own probe)`);
  }
  // (this file is not among the files the reader scans, so its probes may cite dead links freely)
  const named = citedChangesIn('see changes/079-the-store-measured-against-pgvector.md and changes/080 and changes/081-The_Store.md and changes/082_x.md and [79](079-the-store.md) and [a](./079-a.md#top "t")', { record: true }).map((c) => c.name ?? null);
  if (JSON.stringify(named) !== JSON.stringify(["079-the-store-measured-against-pgvector.md", null, "081-The_Store.md", "082_x.md", "079-the-store.md", "079-a.md"])) fail(SELF, `check 15's citation reader keeps a slugged path's name (mis-cased, underscored, or a relative link inside the record too — a dead link on Linux), got ${JSON.stringify(named)} (its own probe)`);
  for (const [label, args, want] of LAYOUT_PROBES) {
    const got = forkLayoutProblems(args()).map((p) => p.kind);
    if (JSON.stringify(got) !== JSON.stringify(want)) fail(SELF, `check 15's layout decision reports [${got}] for ${label}, expected [${want}] (its own probe)`);
  }

  const forkText = readFileSync(join(ROOT, "FORK.md"), "utf8");
  const entries = changesOnDisk().entries; // every entry, any extension — a stray is a finding
  const citations: LayoutCitation[] = [];
  // A citation inside a fenced block or a code span counts: a quoted "change N" is
  // still a claim about the record (check 16 strips fences for its heading rule
  // alone, where a `# 1.` comment is not a heading).
  for (const rel of citationFiles()) {
    const text = readFileSync(join(ROOT, rel), "utf8");
    const record = rel === "FORK.md" || rel.startsWith(`${CHANGES_DIR}/`);
    const found = citedChangesIn(text, { record });
    if (found.length === 0) continue;
    const lineAt = lineIndexer(text);
    for (const c of found) citations.push({ where: `${rel}:${lineAt(c.index)}`, n: c.n, ...(c.name ? { name: c.name } : {}) });
  }
  for (const p of forkLayoutProblems({ entries, forkText, citations })) fail(p.where, `${p.msg} (SMD-1917)`);
}
checkForkLayout();
// ── 16–17: fragments, the changelog and the freeze (SMD-1804) ────────────────
const KAC_HEADINGS = new Set(["Added", "Changed", "Deprecated", "Removed", "Fixed", "Security"]);


/**
 * 16: a changes/<ticket>.md fragment is well-formed — fragmentProblems lives in
 * scripts/fragments.ts, one definition for this check and the release step. A fragment replaces the
 * hand-numbered FORK section for new work: front matter naming a Keep a Changelog
 * type, a bump the migrations it lists allow, and the tickets and migrations it
 * touches; a Changelog body (1–3 lines) and a FORK body. A `bump: patch` that
 * ships a migration is the rule from the version scheme; a numbered heading in
 * the FORK body (`### N.` / `# N.`) is the mistake the fragment format exists to
 * prevent — the number is assigned at release, so a fragment cannot know its own.
 * A citation of an existing change number is fine; check 15 holds every citation
 * to a file (SMD-1917).
 */

function checkFragments() {
  const goodFrag = "---\ntype: added\nbump: minor\ntickets: [SMD-1804, SMD-1805]\nmigrations: [044]\n---\n\n## Changelog\nThe fork gets a version (SMD-1804, SMD-1805).\n\n## FORK\nA title (SMD-1804 / 1805)\n\nBody citing SMD-1804, migration 044 and change 79.\n";
  if (fragmentProblems(goodFrag).length) fail(SELF, `check 16 false-positives on a valid fragment (${fragmentProblems(goodFrag).join("; ")})`);
  // Each probe isolates one rule: its other lines carry the ticket, so dropping
  // the rule it names is the only way it passes. A third element names the file.
  for (const [probe, why, name] of [
    ["---\ntype: added\nbump: patch\ntickets: [SMD-1]\nmigrations: [044]\n---\n\n## Changelog\nx (SMD-1)\n\n## FORK\ny (SMD-1)\n", "a patch that ships a migration"],
    ["---\ntype: added\nbump: minor\ntickets: [SMD-1]\nmigrations: []\n---\n\n## Changelog\nx (SMD-1)\n\n## FORK\n# 103. A title\n\nbody\n", "a numbered heading in the FORK body"],
    ["---\ntype: added\nbump: minor\ntickets: [SMD-1]\nmigrations: []\n---\n\n## Changelog\nx (SMD-1)\n\n## FORK\nA title (SMD-1)\n\n### 103. sub\n", "a numbered `### N.` heading in the FORK body"],
    ["---\ntype: added\nbump: minor\ntickets: [SMD-1]\nmigrations: []\n---\n\n## Changelog\nx (SMD-1)\n\n## FORK\n### A title\n\nbody\n", "an unnumbered heading as the FORK body's title"],
    ["---\ntype: added\nbump: minor\ntickets: [SMD-1]\nmigrations: []\n---\n\n## Changelog\nx (SMD-1)\n\n## FORK\nA title that\nwraps (SMD-1)\n\nbody\n", "a title wrapped onto a second line"],
    ["---\ntype: added\nbump: patch2\ntickets: [SMD-1]\n---\n\n## Changelog\nx (SMD-1)\n\n## FORK\ny (SMD-1)\n", "a bump off the three"],
    ["---\ntype: added\nbump: minor\ntickets: [SMD-x]\n---\n\n## Changelog\nx\n\n## FORK\ny\n", "a ticket that is not SMD-#### (no ticket on the lines, so only that rule fires)"],
    ["---\ntype: added\nbump: minor\ntickets: [SMD-1]\nmigrations: [44]\n---\n\n## Changelog\nx (SMD-1)\n\n## FORK\ny (SMD-1)\n", "a migration number of two digits"],
    ["---\ntype: added\nbump: minor\ntickets: [SMD-1]\n---\n\n## Changelog\na (SMD-1)\nb\nc\nd\n\n## FORK\ny (SMD-1)\n", "a four-line Changelog body"],
    ["---\ntype: added\nbump: minor\ntickets: [SMD-1]\n---\n\n## Changelog\nx (SMD-1)\n", "a missing FORK body"],
    ["---\ntype: added\nbump: minor\ntickets: [SMD-1, SMD-2]\n---\n\n## Changelog\nx (SMD-1)\n\n## FORK\nA title (SMD-1)\n\nbody\n", "a title that names one of the two tickets"],
    ["---\ntype: added\nbump: minor\ntickets: [SMD-1]\n---\n\n## Changelog\nx (SMD-1)\n\n## FORK\nA title\n\nbody\n", "a title that names no ticket"],
    ["---\ntype: added\nbump: minor\ntickets: [SMD-1]\n---\n\n## Changelog\n\n## FORK\nA title (SMD-1)\n\nbody\n", "an empty Changelog body (which used to read the FORK section as its text)"],
    ["---\ntype: added\nbump: minor\ntickets: [SMD-1, SMD-2]\n---\n\n## Changelog\nx (SMD-1)\n\n## FORK\nA title (SMD-1 / 2)\n\nbody\n", "a Changelog line that names one of the two tickets"],
    ["---\ntype: added\nbump: minor\ntickets: [SMD-1]\n---\n\n## Changelog\nx (SMD-1), closing SMD-7's follow-up\n\n## FORK\nA title (SMD-1)\n\nbody\n", "a Changelog line naming a ticket the front matter does not"],
    ["---\ntype: added\nbump: minor\ntickets: [SMD-1]\n---\n\n## Changelog\n- x (SMD-1)\n\n## FORK\nA title (SMD-1)\n\nbody\n", "a Changelog line that is already a bullet"],
    ["---\ntype: added\nbump: minor\ntickets: [SMD-1]\n---\n\n## FORK\nA title (SMD-1)\n\nbody\n\n## Changelog\nx (SMD-1)\n", "a Changelog section after the FORK body (which runs to the end of the file)"],
    ["---\ntype: added\nbump: minor\ntickets: [SMD-1]\n---\n\n## Changelog\nx (SMD-1)\n\n## Notes\nkept nowhere\n\n## FORK\nA title (SMD-1)\n\nbody\n", "a section between Changelog and FORK, which the cut writes nowhere"],
    ["---\ntype: added\nbump: minor\ntickets: [SMD-1]\n---\n\n## Changelog\nx (SMD-1)\n\n## Changelog\ny (SMD-1)\n\n## FORK\nA title (SMD-1)\n\nbody\n", "two Changelog sections"],
    ["---\ntype: added\nbump: minor\ntickets: [SMD-1]\n---\n\n## Changelog\nx (SMD-1)\n### Added\n\n## FORK\nA title (SMD-1)\n\nbody\n", "a heading inside the Changelog body"],
    ["---\ntype: added\nbump: minor\ntickets: [SMD-1]\n---\n\n## Changelog\nx (SMD-1)\n\n## FORK\nA title (SMD-1)\n\n##### 5. deep\n", "a numbered heading five levels deep in the FORK body"],
    ["---\ntype: added\nbump: minor\ntickets: [SMD-1804]\n---\n\n## Changelog\nx (SMD-1804)\n\n## FORK\nA title (SMD-1804)\n\nbody\n", "a fragment named for a ticket its front matter does not list", "smd-1805.md"],
    ["---\ntype: whatever\nbump: minor\ntickets: [SMD-1]\n---\n\n## Changelog\nx (SMD-1)\n\n## FORK\ny (SMD-1)\n", "a type off the six"],
    ["---\ntype: added\nbump: minor\ntickets: []\n---\n\n## Changelog\nx\n\n## FORK\ny\n", "an empty ticket list (no ticket on the lines, so only that rule fires)"],
    ["---\ntype: added\nbump: minor\ntickets: [SMD-1]\n---\n\n## Changelog\nx (SMD-1)\n\n## FORK\n", "an empty FORK section"],
    ["---\ntype: added\nbump: minor\ntickets: [SMD-1]\n---\n\n## FORK\ny (SMD-1)\n", "a missing Changelog body"],
    ["no front matter here\n", "no front matter"],
    ["---\ntype: added\nbump: minor\ntickets: [SMD-1]\nmigrations: 045\n---\n\n## Changelog\nx (SMD-1)\n\n## FORK\ny (SMD-1)\n", "a scalar `migrations:` (read as none, it passed while the cut refused \"migration 000\" — SMD-1870)"],
  ]) if (fragmentProblems(probe, name).length === 0) fail(SELF, `check 16 no longer catches ${why} (its own probe)`);
  for (const [probe, why] of [
    ["---\ntype: added\nbump: minor\ntickets: [SMD-1]\n---\n\n## Changelog\nx (SMD-1)\n\n## FORK\nA title (SMD-1)\n\n```bash\n# 1. install\n```\n\n#1. not a heading\n\n1. a list item\n\n## Measured after\n\nA second-level heading inside the record is kept, as changes 19 and 79 keep theirs.\n", "a numbered comment in a fenced block, a `#1.`, a list item and a `## ` sub-heading inside the record"],
    ["---\ntype: added        # one of the six\nbump: minor        # the rules\ntickets: [SMD-1804]        # one or more\nmigrations: [044]          # or [] for none\n---\n\n## Changelog\n\nx (SMD-1804, migration 044).\n\n## FORK\n\nA title (SMD-1804)\n\nbody\n", "the README's template copied with its inline comments"],
  ]) if (fragmentProblems(probe).length) fail(SELF, `check 16 refuses ${why}: ${fragmentProblems(probe).join("; ")} (its own non-probe)`);

  // Numbered files and stray names are check 15's; one definition of a fragment's name (fork-index.ts).
  for (const f of changesOnDisk().fragments) for (const p of fragmentProblems(f.text, f.name)) fail(`changes/${f.name}`, `${p} (SMD-1804)`);
}
checkFragments();

/**
 * 17a: CHANGELOG.md is Keep a Changelog 1.1.0 — Unreleased first, released
 * versions dated and newest-first, only the six headings under a version, and a
 * resolving compare link for every section. No back-fill: sections 1–100 of the
 * fork predate the first cut and live in FORK.md, so a fresh CHANGELOG has only
 * Unreleased until the first release is assembled.
 */
function changelogProblems(text: string) {
  const problems: string[] = [];
  const parts = text.split(/^## /m).slice(1);
  const titles = parts.map((p) => p.split("\n", 1)[0].trim());
  const sections = titles.filter((t) => t.startsWith("["));
  if (sections.length === 0 || sections[0] !== "[Unreleased]") problems.push("the first `## [..]` section must be `## [Unreleased]`");
  const versions: string[] = [];
  for (const part of parts) {
    const title = part.split("\n", 1)[0].trim();
    if (!title.startsWith("[") || title === "[Unreleased]") continue;
    const vm = /^\[(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\] - (\d{4}-\d{2}-\d{2})$/.exec(title);
    if (!vm) { problems.push(`\`## ${title}\` is not \`[X.Y.Z] - YYYY-MM-DD\``); continue; }
    versions.push(vm[1]);
    for (const h3 of part.matchAll(/^### (.+)$/gm)) if (!KAC_HEADINGS.has(h3[1].trim())) problems.push(`\`[${vm[1]}]\` has heading \`### ${h3[1].trim()}\` — only ${[...KAC_HEADINGS].join("/")} are allowed`);
  }
  for (let i = 1; i < versions.length; i++) if (semverCompare(versions[i - 1], versions[i]) <= 0) problems.push(`versions are not newest-first: [${versions[i - 1]}] then [${versions[i]}]`);
  const linkTargets = new Set([...text.matchAll(/^\[([^\]]+)\]:\s*\S+/gm)].map((m) => m[1]));
  for (const v of ["Unreleased", ...versions]) if (!linkTargets.has(v)) problems.push(`no compare link \`[${v}]: …\` at the foot`);
  for (const t of linkTargets) if (t !== "Unreleased" && !versions.includes(t)) problems.push(`a compare link \`[${t}]\` names a version with no section`);
  return problems;
}
function checkChangelogShape() {
  const good = "# Changelog\n\n## [Unreleased]\n\n## [1.1.0] - 2026-10-01\n### Added\n- a thing (SMD-2)\n\n## [1.0.0] - 2026-09-30\n### Fixed\n- a thing (SMD-1)\n\n[Unreleased]: u\n[1.1.0]: u\n[1.0.0]: u\n";
  if (changelogProblems(good).length) fail(SELF, `check 17a false-positives on a valid changelog (${changelogProblems(good).join("; ")})`);
  for (const [probe, why] of [
    ["# Changelog\n\n## [1.0.0] - 2026-09-30\n### Added\n- x (SMD-1)\n\n[Unreleased]: u\n[1.0.0]: u\n", "no Unreleased first (its links present, so only that rule fires)"],
    ["# Changelog\n\n## [Unreleased]\n\n## [1.0.0]\n### Added\n- x\n\n[Unreleased]: u\n", "an undated version (no footer link for it, so only that rule fires)"],
    ["# Changelog\n\n## [Unreleased]\n\n## [1.0.0] - 2026-09-30\n### Added\n- x\n\n[Unreleased]: u\n[1.0.0]: u\n[0.9.0]: u\n", "a compare link for a version with no section"],
    ["# Changelog\n\n## [Unreleased]\n\n## [1.0.0] - 2026-09-30\n### Reworked\n- x\n\n[Unreleased]: u\n[1.0.0]: u\n", "a seventh heading"],
    ["# Changelog\n\n## [Unreleased]\n\n## [1.0.0] - 2026-09-30\n### Added\n- x\n\n## [1.1.0] - 2026-10-01\n### Added\n- y\n\n[Unreleased]: u\n[1.0.0]: u\n[1.1.0]: u\n", "versions not newest-first"],
    ["# Changelog\n\n## [Unreleased]\n\n## [1.0.0] - 2026-09-30\n### Added\n- x\n\n[1.0.0]: u\n", "a missing Unreleased compare link"],
  ]) if (changelogProblems(probe).length === 0) fail(SELF, `check 17a no longer catches ${why} (its own probe)`);

  const path = join(ROOT, "CHANGELOG.md");
  if (!existsSync(path)) return fail("CHANGELOG.md", "the fork's changelog is missing — Keep a Changelog 1.1.0, Unreleased first (SMD-1804)");
  for (const p of changelogProblems(readFileSync(path, "utf8"))) fail("CHANGELOG.md", `${p} (SMD-1804)`);
}
checkChangelogShape();

/** Tickets appearing in each released `## [X.Y.Z]` section of a changelog. */
function releasedChangelogTickets(text: string) {
  const out = new Map<string, Set<string>>();
  for (const part of text.split(/^## /m).slice(1)) {
    const title = part.split("\n", 1)[0].trim();
    if (!title.startsWith("[") || title === "[Unreleased]") continue;
    const vm = /^\[([^\]]+)\]/.exec(title);
    if (!vm) continue; // a `## [` heading with no `]`: checkChangelogShape has reported it; reading vm[1] threw and hid every violation (SMD-1870)
    out.set(vm[1], new Set([...part.matchAll(/\bSMD-(\d+)\b/g)].map((m) => `SMD-${m[1]}`)));
  }
  return out;
}
/**
 * 17b: each release pairs both ways. releases.json is the machine record the
 * assembler writes; CHANGELOG.md is the page; FORK.md holds the sections. A
 * released version must appear in all three with the same tickets: a CHANGELOG
 * entry whose ticket has no numbered change file, or a release whose version or tickets
 * the changelog does not match, is drift the assembler would have to have caused.
 * A no-op until the first release (releases.json is []).
 */
function pairingProblems(releases: readonly { version: string; tickets?: readonly string[] }[], changelogText: string, forkTickets: Set<string>) {
  const problems: string[] = [];
  const cl = releasedChangelogTickets(changelogText);
  // releases.json carries the full version (`1.0.0+upstream.<sha>`); a CHANGELOG
  // section title carries the core (`[1.0.0]`) — the assembler writes both, so
  // the pairing compares cores (found by assembling a release on a copy of the
  // tree: the first cut failed its own check both ways, SMD-1917).
  const core = (v: string) => String(v).split("+")[0];
  for (const r of releases) {
    if (!cl.has(core(r.version))) { problems.push(`release ${r.version} (releases.json) has no [${core(r.version)}] section in CHANGELOG.md`); continue; }
    const clTickets = cl.get(core(r.version))!; // has() just tested
    const rTickets = new Set(r.tickets ?? []);
    for (const t of rTickets) if (!clTickets.has(t)) problems.push(`release ${r.version} lists ${t} but its CHANGELOG section does not`);
    for (const t of clTickets) if (!rTickets.has(t)) problems.push(`CHANGELOG [${r.version}] names ${t} but releases.json does not`);
    for (const t of rTickets) if (!forkTickets.has(t)) problems.push(`release ${r.version} lists ${t} but no numbered change file's title names it — the release step did not number its fragment`);
  }
  const known = new Set(releases.map((r) => core(r.version)));
  for (const v of cl.keys()) if (!known.has(v)) problems.push(`CHANGELOG has a released [${v}] with no releases.json entry`);
  return problems;
}
function checkChangelogForkPairing() {
  const fork = new Set(["SMD-1"]);
  const clGood = "## [1.0.0] - 2026-09-30\n### Added\n- x (SMD-1)\n";
  if (pairingProblems([{ version: "1.0.0", tickets: ["SMD-1"] }], clGood, fork).length) fail(SELF, "check 17b false-positives on a matched release");
  if (pairingProblems([{ version: "1.0.0+upstream.9543c29", tickets: ["SMD-1"] }], clGood, fork).length) fail(SELF, "check 17b false-positives on a matched release whose releases.json version carries the +upstream build metadata (its own probe)");
  for (const [rel, cl, forks, why] of [
    [[{ version: "1.0.0", tickets: ["SMD-1"] }], "## [1.0.0] - 2026-09-30\n- x (SMD-2)\n", fork, "a ticket in releases.json missing from the changelog"],
    [[{ version: "1.0.0", tickets: ["SMD-1"] }], "## [Unreleased]\n", fork, "a release with no CHANGELOG section of its version (and no other section to blame)"],
    [[{ version: "1.0.0", tickets: ["SMD-1", "SMD-2"] }], "## [1.0.0] - 2026-09-30\n- x (SMD-1)\n", new Set(["SMD-1", "SMD-2"]), "a release ticket the CHANGELOG section omits (its other ticket present, so only that branch fires)"],
    [[{ version: "1.0.0", tickets: ["SMD-1"] }], "## [1.0.0] - 2026-09-30\n- x (SMD-1)\n- y (SMD-2)\n", new Set(["SMD-1", "SMD-2"]), "a changelog ticket missing from releases.json"],
    [[{ version: "1.0.0", tickets: ["SMD-9"] }], "## [1.0.0] - 2026-09-30\n- x (SMD-9)\n", fork, "a released ticket with no FORK section"],
    [[], "## [1.0.0] - 2026-09-30\n- x (SMD-1)\n", fork, "a changelog release with no releases.json entry"],
  ] as const) if (pairingProblems(rel, cl, forks).length === 0) fail(SELF, `check 17b no longer catches ${why} (its own probe)`);
  // A malformed heading is check 17a's finding; the ticket reader skips it rather than throwing on it (a TypeError here hid every violation, SMD-1870).
  let skipped = false;
  try { skipped = releasedChangelogTickets("## [Unreleased]\n\n## [1.0.0 - 2026-09-30\n- x (SMD-1)\n").size === 0; } catch { /* the TypeError the guard removes */ }
  if (!skipped) fail(SELF, "check 17b's ticket reader no longer skips a `## [` heading with no closing bracket — it throws on it, or reads it as a version (its own probe)");

  const clPath = join(ROOT, "CHANGELOG.md");
  if (!existsSync(clPath)) return;
  // A released ticket has a record: a numbered change file whose TITLE ends in it
  // (ticketOf expands "(SMD-1301 / 1302)" to both; check 16 makes the release
  // step's title name every front-matter ticket). Neither FORK.md's text nor a
  // change file's body is a source: both name pending tickets in prose, which
  // would let a release that left a fragment unnumbered pass — the drift this
  // catches (SMD-1917).
  const recordTickets = new Set<string>();
  for (const c of changesOnDisk().numbered) for (const t of ticketsOf(c.heading?.title ?? "")) recordTickets.add(t);
  for (const p of pairingProblems(readReleases(), readFileSync(clPath, "utf8"), recordTickets)) fail("CHANGELOG.md", `${p} (SMD-1804)`);
}
checkChangelogForkPairing();

/**
 * 17c: a migration inside a released range keeps the sha the release froze. The
 * ledger's own sha check refuses drift at apply time; this refuses an EDIT to a
 * released migration at review time — the rule the version scheme adds. Each
 * releases.json entry records the sha of every migration in its range; a file
 * whose template now hashes to something else, or is gone, has been edited after
 * it was frozen. A no-op until the first release.
 */
function checkFrozenMigrations() {
  const migDir = join(ROOT, "db", "migrations");
  const shaOf = (num: number) => {
    const f = readdirSync(migDir).find((n) => n.startsWith(pad3(num) + "_"));
    return f ? migrationSha(readFileSync(join(migDir, f), "utf8")) : null;
  };
  // Self-test: a frozen sha that no longer matches, and a missing file, are caught.
  const real = readdirSync(migDir).filter((n) => /^\d{3}_/.test(n)).sort()[0];
  const realNum = Number(real.slice(0, 3));
  const realSha = migrationSha(readFileSync(join(migDir, real), "utf8"));
  const okRel = [{ version: "9.9.9", range: [realNum, realNum], frozenShas: { [pad3(realNum)]: realSha } }];
  if (frozenProblems(okRel, shaOf).length) fail(SELF, "check 17c false-positives on an unchanged frozen migration");
  const badRel = [{ version: "9.9.9", range: [realNum, realNum], frozenShas: { [pad3(realNum)]: "000000000000" } }];
  if (frozenProblems(badRel, shaOf).length === 0) fail(SELF, "check 17c no longer catches an edited frozen migration (its own probe)");
  const goneRel = [{ version: "9.9.9", range: [999, 999], frozenShas: { "999": "abc" } }];
  if (frozenProblems(goneRel, shaOf).length === 0) fail(SELF, "check 17c no longer catches a missing frozen migration (its own probe)");

  for (const p of frozenProblems(readReleases(), shaOf)) fail("db/migrations", `${p} (SMD-1804)`);
}
function frozenProblems(releases: readonly { version: string; range: readonly number[] | null; frozenShas?: Record<string, string> }[], shaOf: (num: number) => string | null) {
  const problems: string[] = [];
  for (const r of releases) {
    if (!r.range) continue; // a docs/server-only release froze no migration range
    const [lo, hi] = r.range;
    for (let n = lo; n <= hi; n++) {
      const frozen = (r.frozenShas ?? {})[pad3(n)];
      if (!frozen) { problems.push(`release ${r.version} froze range ${pad3(lo)}..${pad3(hi)} but records no sha for migration ${pad3(n)}`); continue; }
      const now = shaOf(n);
      if (now === null) problems.push(`migration ${pad3(n)} is inside released range ${r.version} but has no file — a released migration cannot be removed`);
      else if (now !== frozen) problems.push(`migration ${pad3(n)} was frozen at ${frozen} by release ${r.version} but now hashes to ${now} — a released migration is append-only, add a new file instead of editing it`);
    }
  }
  return problems;
}
checkFrozenMigrations();

/**
 * 17d: the version a brain reports equals the version the tooling computes. The
 * highest-numbered migration that writes ob1_config.schema_version writes the
 * current version; it must be exactly db/version.mjs's FORK_VERSION, so the
 * string a brain reports (044 at the baseline, a later set-version migration
 * after a cut) and the string preflight and the assembler use cannot drift.
 */
/** The schema_version literal a migration upserts, or null if it writes none. */
function schemaVersionValue(text: string) {
  const m = /'schema_version'\s*\)\s*VALUES?[\s\S]*?\(\s*'schema_version'\s*,\s*'([^']+)'/.exec(text)
    || /\(\s*'schema_version'\s*,\s*'([^']+)'\s*\)/.exec(text);
  return m ? m[1] : null;
}
function checkSchemaVersion() {
  // Self-test: the two INSERT shapes are read, a migration that writes no
  // schema_version is not mistaken for one that does.
  if (schemaVersionValue("INSERT INTO ob1_config (key, value) VALUES\n  ('schema_version', '1.2.3+upstream.abc')\nON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;") !== "1.2.3+upstream.abc")
    fail(SELF, "check 17d no longer reads the schema_version an INSERT writes (its own probe)");
  if (schemaVersionValue("INSERT INTO ob1_config (key, value) VALUES ('embedding_dim', '1024');") !== null)
    fail(SELF, "check 17d reads a schema_version from a migration that writes none (its own probe)");

  const migDir = join(ROOT, "db", "migrations");
  const writers: { num: number; name: string; value: string }[] = [];
  for (const name of readdirSync(migDir).filter((n) => /^\d{3}_.*\.sql$/.test(n))) {
    const value = schemaVersionValue(readFileSync(join(migDir, name), "utf8"));
    if (value !== null) writers.push({ num: Number(name.slice(0, 3)), name, value });
  }
  if (writers.length === 0) return fail("db/migrations", "no migration writes ob1_config.schema_version — migration 044 should (SMD-1804)");
  writers.sort((a, b) => a.num - b.num);
  const current = writers[writers.length - 1];
  if (current.value !== FORK_VERSION) fail(`db/migrations/${current.name}`, `writes schema_version '${current.value}' but db/version.mjs's FORK_VERSION is '${FORK_VERSION}' — the brain would report a version the tooling does not (SMD-1804)`);
}
checkSchemaVersion();

/**
 * 18: one type surface across the type-checked directories, and a CI step
 * for each — see the header. The rule is one pure function over in-memory
 * records, probed below, so a package.json that stops pinning, a tsconfig that
 * drifts, or a workflow that loses (or grows) a tsc step fails here by name.
 * `server-portable` is the reference: the others import its files, so its
 * pins are the ones a second copy would collide with.
 */
const TYPECHECKED_DIRS = ["server-portable", "compat/supabase-sql", "db", "evals", "scripts"];
const TYPE_PINS = ["@types/bun", "typescript", "@types/node"];
const WORKFLOW = ".github/workflows/fork-checks.yml";
const TSC_STEP = /^\s*bunx tsc --noEmit\s*$/;
/** What check 18 compares: each directory's package.json and tsconfig.json as read (absent when the file is), and the workflow's tsc steps by directory. */
type PackageJson = { devDependencies?: Record<string, string> };
type TsConfig = { compilerOptions?: Record<string, unknown> };
type TypecheckSurface = { packages: Record<string, PackageJson | undefined>; tsconfigs: Record<string, TsConfig | undefined>; tscSteps: string[] };
/** The probe's surface: every directory present with every field, so a mutation can reach in. */
type TypecheckProbe = { packages: Record<string, { devDependencies: Record<string, string> }>; tsconfigs: Record<string, { compilerOptions: Record<string, unknown> }>; tscSteps: string[] };
/** .github/workflows/fork-checks.yml as tscStepsIn reads it: jobs, their steps, a step's `run` and `working-directory` — every level optional, as the `?.`s say. */
type WorkflowDoc = { jobs?: Record<string, { steps?: { run?: unknown; "working-directory"?: string }[] } | undefined> } | null | undefined;
function typecheckSurfaceProblems({ packages, tsconfigs, tscSteps }: TypecheckSurface) {
  const problems: [string, string][] = [];
  const ref = TYPECHECKED_DIRS[0];
  const refDev = packages[ref]?.devDependencies ?? {};
  // Keys sorted at every depth (a nested object such as `paths` compares by
  // content, not insertion order); arrays keep their order, since `types`
  // and `lib` are ordered.
  const sortKeys = (v: unknown): unknown => (Array.isArray(v) ? v.map(sortKeys) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, sortKeys(x)])) : v);
  const canon = (o: unknown) => JSON.stringify(sortKeys(o ?? {}));
  const refOpts = canon(tsconfigs[ref]?.compilerOptions);
  for (const dir of TYPECHECKED_DIRS) {
    const dev = packages[dir]?.devDependencies;
    if (!dev) problems.push([`${dir}/package.json`, `${packages[dir] ? "has no devDependencies" : "is missing"} — every type-checked directory pins ${TYPE_PINS.join(", ")} in its devDependencies (SMD-1932)`]);
    else for (const name of TYPE_PINS) {
      if (!(name in dev)) problems.push([`${dir}/package.json`, dir === ref ? `does not pin ${name} — it is the reference the other type-checked directories are held to (SMD-1932)` : `does not pin ${name}; ${ref}/package.json pins it at ${refDev[name] ?? "(nothing)"} (SMD-1932)`]);
      else if (dir !== ref && dev[name] !== refDev[name]) problems.push([`${dir}/package.json`, `pins ${name} at ${dev[name]} but ${ref}/package.json pins ${refDev[name]} — bump every type-checked directory in one commit, or two copies of the types load into the programs that import ../server-portable (SMD-1932)`]);
    }
    const opts = tsconfigs[dir]?.compilerOptions;
    if (!opts) problems.push([`${dir}/tsconfig.json`, `missing, or has no compilerOptions (SMD-1932)`]);
    else if (dir !== ref && canon(opts) !== refOpts) problems.push([`${dir}/tsconfig.json`, `compilerOptions differ from ${ref}/tsconfig.json's: ${canon(opts)} vs ${refOpts} (SMD-1932)`]);
    const n = tscSteps.filter((d) => d === dir).length;
    if (n !== 1) problems.push([WORKFLOW, `runs \`bunx tsc --noEmit\` under ${dir} ${n} time(s); exactly one step per type-checked directory (SMD-1932)`]);
  }
  for (const d of tscSteps) if (!TYPECHECKED_DIRS.includes(d)) problems.push([WORKFLOW, `runs \`bunx tsc --noEmit\` under ${d}, which TYPECHECKED_DIRS in ${SELF} does not name — add it there, with its pins and tsconfig (SMD-1932)`]);
  return problems;
}
/** The working-directory of every `bunx tsc --noEmit` step in a parsed workflow, in order. */
function tscStepsIn(doc: WorkflowDoc) {
  const out: string[] = [];
  for (const job of Object.values(doc?.jobs ?? {})) {
    for (const step of job?.steps ?? []) if (typeof step?.run === "string" && TSC_STEP.test(step.run)) out.push(step["working-directory"] ?? ".");
  }
  return out;
}
function checkTypecheckSurface() {
  // Self-test: a consistent set passes; one drifted pin, one missing pin, one
  // differing option, one missing step and one unlisted step each report
  // exactly one problem.
  const good = (): TypecheckProbe => ({
    packages: Object.fromEntries(TYPECHECKED_DIRS.map((d) => [d, { devDependencies: { "@types/bun": "1.4.0", typescript: "5.9.3", "@types/node": "26.6.2" } }])),
    tsconfigs: Object.fromEntries(TYPECHECKED_DIRS.map((d) => [d, { compilerOptions: { strict: true, types: ["bun"] } }])),
    tscSteps: [...TYPECHECKED_DIRS],
  });
  if (typecheckSurfaceProblems(good()).length) fail(SELF, `check 18 false-positives on a consistent surface (${typecheckSurfaceProblems(good()).map((p) => p[1]).join("; ")})`);
  for (const [why, mutate] of [
    ["a drifted pin", (g: TypecheckProbe) => { g.packages.db.devDependencies.typescript = "5.9.4"; }],
    ["a missing pin", (g: TypecheckProbe) => { delete g.packages.evals.devDependencies["@types/node"]; }],
    ["a differing compilerOption", (g: TypecheckProbe) => { g.tsconfigs.evals.compilerOptions.strict = false; }],
    ["a missing tsc step", (g: TypecheckProbe) => { g.tscSteps = g.tscSteps.filter((d) => d !== "db"); }],
    ["a tsc step under an unlisted directory", (g: TypecheckProbe) => { g.tscSteps.push("recipes/x"); }],
  ] as const) {
    const g = good(); mutate(g);
    const got = typecheckSurfaceProblems(g);
    if (got.length !== 1) fail(SELF, `check 18 reports ${got.length} problem(s) for ${why}, not one (its own probe): ${JSON.stringify(got)}`);
  }

  if (typeof Bun === "undefined" || typeof Bun.YAML?.parse !== "function") {
    fail(SELF, `check 18 parses ${WORKFLOW} with Bun.YAML (Bun 1.2+) and this runtime has none — run \`bun ${SELF}\`, as CI does (SMD-1932)`);
    return;
  }
  const readJson = (rel: string) => (existsSync(join(ROOT, rel)) ? JSON.parse(readFileSync(join(ROOT, rel), "utf8")) : undefined);
  const packages = Object.fromEntries(TYPECHECKED_DIRS.map((d) => [d, readJson(`${d}/package.json`)]));
  const tsconfigs = Object.fromEntries(TYPECHECKED_DIRS.map((d) => [d, readJson(`${d}/tsconfig.json`)]));
  const tscSteps = tscStepsIn(Bun.YAML.parse(readFileSync(join(ROOT, WORKFLOW), "utf8")) as WorkflowDoc);
  for (const [where, msg] of typecheckSurfaceProblems({ packages, tsconfigs, tscSteps })) fail(where, msg);
}
checkTypecheckSurface();
// ── 19: the connector registry (SMD-1933) ────────────────────────────────────
/**
 * A registry every rule accepts, in memory, against a tree of two contributions
 * and a disposition table naming one of them: the baseline the mutants below
 * are measured from. Each mutant changes one thing and must produce exactly
 * the kinds listed — so a rule that stops firing is caught, and a rule that
 * fires on the baseline is caught first.
 */
/** The probe tree: registryProblems' Tree with the disposition table present, so a tree mutant can append to it. */
type ProbeTree = Tree & { dispositionText: string };
/** A pinned facet as the probe declares it; `family`'s `values` is the string "families", the other four are lists. */
type ProbeFacet = { stability: string; values: unknown[] | string };
/** A probe capability: the seven keys as strings, `fetcher` optional (one mutant deletes it), any other key settable (one adds a sixth). */
type ProbeCapability = { vendor: string; family: string; transport: string; direction: string; cardinality: string; round_trip: string; fetcher?: string; note?: string; [k: string]: unknown };
type ProbeArtifact = { path: string; capabilities: ProbeCapability[] };
/**
 * The baseline registry, every block present and every key a string, so a
 * mutant can reach in — the strict counterpart of connector-registry.ts's
 * loose Registry (the probe is assignable to it). The families reuse the loose
 * Family: a probe family is a reserved one or a full one, the rules read both.
 */
type ProbeRegistry = {
  facets: Record<string, ProbeFacet>;
  fetchers: Record<string, string>;
  families: Record<string, Family>;
  connectors: Record<string, { direction: string; note?: string }>;
  artifacts: ProbeArtifact[];
  not_connectors: { services: { pattern: string; reason?: string }[]; artifacts: Record<string, string> };
};
/**
 * A probe registry with one block reshaped: the parameter type of a mutant
 * that breaks a block's shape (an object for the artifacts list, a string for
 * a capability, null for a family) — wider than ProbeRegistry, so the closure
 * still fits the table's `(r: ProbeRegistry) => void`.
 */
type ProbeWith<K extends keyof ProbeRegistry, T> = Omit<ProbeRegistry, K> & Record<K, T>;
/** [why, mutate, want, tree?]: a mutant of the baseline registry, the kinds it must produce, and (a fourth element) null for a null registry or a function that reshapes the tree. */
type RegistryProbe = [why: string, mutate: (r: ProbeRegistry) => void, want: string[], tree?: ((t: ProbeTree) => void) | null];
const PROBE_TREE = (): ProbeTree => ({
  existingDirs: ["integrations/acme-capture", "recipes/acme-digest", "recipes/plain-tool"],
  metadataByPath: new Map([
    ["integrations/acme-capture", { requires: { services: ["Acme Chat API", "OpenRouter"] }, tags: ["messaging"], connectors: ["acme"] }],
    ["recipes/acme-digest", { requires: { services: ["Acme Chat API (optional)"] }, tags: ["digest"], connectors: ["acme"] }],
    ["recipes/plain-tool", { requires: { services: ["Supabase"] }, tags: ["ops"] }],
  ]),
  dispositionText: "### `integrations/` (1)\n\n| Artifact | Disposition | Justification |\n|---|---|---|\n| `acme-capture` | keep + audited → fold-in **SMD-1867** | a capture source |\n",
});
const PROBE_REGISTRY = (): ProbeRegistry => ({
  facets: {
    ...Object.fromEntries(Object.entries(FACET_SETS).map(([k, v]) => [k, { stability: v.stability, values: [...v.values] }])),
    family: { stability: "open", values: "families" },
  },
  fetchers: Object.fromEntries(FETCHERS.map((f) => [f, "x"])),
  families: {
    "message-stream/chat": { item: "a message", grouping_key: "thread", default_cardinality: "1:1", canonical: "c", text: "t", edges: ["e"], metadata: ["m"], identity: "i", typical_transport: ["push"], dividing_line: "d" },
    "notification-target": { reserved: true, direction: "sink", note: "held" },
  },
  connectors: { acme: { direction: "bidirectional" } },
  artifacts: [
    { path: "integrations/acme-capture", capabilities: [{ vendor: "acme", family: "message-stream/chat", transport: "push", direction: "source", cardinality: "1:1", round_trip: "read-only", fetcher: "native-driver" }] },
    { path: "recipes/acme-digest", capabilities: [{ vendor: "acme", family: "message-stream/chat", transport: "push", direction: "sink", cardinality: "many:1", round_trip: "read-only", fetcher: "native-driver", note: "n" }] },
  ],
  not_connectors: {
    services: [{ pattern: "openrouter", reason: "a model provider" }, { pattern: "supabase", reason: "hosting" }],
    artifacts: {},
  },
});
const REGISTRY_PROBES: RegistryProbe[] = [
  ["a transport off the near-closed set (webhook-push)", (r) => { r.artifacts[0].capabilities[0].transport = "webhook-push"; }, ["capability-value"]],
  ["a fourth transport added to the registry's own set", (r) => { (r.facets.transport.values as unknown[]).push("stream"); }, ["facet-set"]], // the four pinned facets' values are lists; only `family`'s is the string (ProbeFacet)
  ["a sixth facet", (r) => { r.facets.protocol = { stability: "open", values: ["http"] }; }, ["facet-set"]],
  ["a fifth fetcher kind", (r) => { r.fetchers.cron = "x"; }, ["fetcher-set"]],
  ["a capability naming an undeclared family", (r) => { r.artifacts[0].capabilities[0].family = "mailbox/email"; }, ["capability-family"]],
  ["a capability using the reserved family", (r) => { r.artifacts[1].capabilities[0].family = "notification-target"; }, ["reserved-used"]],
  ["a family missing a schema field", (r) => { delete r.families["message-stream/chat"].identity; }, ["family-schema"]],
  ["a reserved family that is not sink-only", (r) => { r.families["notification-target"].direction = "source"; }, ["family-schema"]],
  ["a capability with a sixth key and no fetcher", (r) => { const c = r.artifacts[0].capabilities[0]; delete c.fetcher; c.protocol = "https"; }, ["capability-keys"]],
  ["an artifact whose directory does not exist", (r) => { r.artifacts[0].path = "integrations/acme-gone"; }, ["artifact-missing", "coverage-unregistered"]],
  ["an artifact listed twice", (r) => { r.artifacts.push(structuredClone(r.artifacts[1])); }, ["artifact-duplicate"]],
  ["a connector declaring source while its capabilities span both", (r) => { r.connectors.acme.direction = "source"; }, ["connector-direction"]],
  ["a connector with no capability naming it", (r) => { r.connectors.ghost = { direction: "source" }; }, ["connector-set"]],
  ["a vendor used with no connector entry", (r) => { delete r.connectors.acme; }, ["connector-set"]],
  ["an external-touching artifact left unclassified", (r) => { r.artifacts.pop(); r.connectors.acme.direction = "source"; }, ["coverage-unregistered"]],
  ["an artifact both classified and excused (its metadata still declares the connector)", (r) => { r.not_connectors.artifacts["recipes/acme-digest"] = "because"; }, ["coverage-both", "excuse-declares"]],
  ["a classified artifact whose metadata declares no connector", (r) => { r.artifacts.push({ path: "recipes/plain-tool", capabilities: [{ vendor: "acme", family: "message-stream/chat", transport: "pull", direction: "source", cardinality: "1:1", round_trip: "read-only", fetcher: "native-driver" }] }); }, ["connectors-field"]],
  ["a provider matched twice, once at the head after a qualifier, is covered (every match is read)", (r) => {}, [], (t) => { t.metadataByPath.set("recipes/two-hits", { requires: { services: ["Any OpenRouter-compatible OpenRouter gateway"] }, tags: ["notes"] }); t.existingDirs.push("recipes/two-hits"); }],
  ["a registered artifact whose metadata declares other connectors than its capabilities", (r) => {}, ["connectors-field"], (t) => { t.metadataByPath.get("recipes/acme-digest")!.connectors = ["acme", "beta"]; }], // PROBE_TREE sets the key
  ["a contribution declaring a connector and classified nowhere", (r) => {}, ["coverage-unregistered"], (t) => { t.metadataByPath.set("recipes/plain-tool", { requires: { services: ["Supabase"] }, tags: ["ops"], connectors: ["acme"] }); }],
  ["an excused artifact whose metadata declares a connector", (r) => { r.not_connectors.artifacts["recipes/plain-tool"] = "a tool"; }, ["excuse-declares"], (t) => { t.metadataByPath.set("recipes/plain-tool", { requires: { services: ["Supabase"] }, tags: ["ops"], connectors: ["acme"] }); }],
  ["a vendor named after an Object.prototype member", (r) => { r.artifacts[1].capabilities[0].vendor = "constructor"; r.connectors.acme.direction = "source"; }, ["connector-set", "connectors-field"]],
  ["an excuse for an artifact nothing marks", (r) => { r.not_connectors.artifacts["recipes/plain-tool"] = "because"; }, ["excuse-stale"]],
  ["an excuse for a contribution that does not exist", (r) => { r.not_connectors.artifacts["recipes/gone"] = "because"; }, ["excuse-stale"]],
  ["a service pattern matching nothing in the tree", (r) => { r.not_connectors.services.push({ pattern: "zapier", reason: "x" }); }, ["pattern-stale"]],
  ["a service pattern that does not compile", (r) => { r.not_connectors.services.push({ pattern: "(", reason: "x" }); }, ["pattern-invalid"]],
  ["a service pattern that is empty (which would match every service)", (r) => { r.not_connectors.services.push({ pattern: "", reason: "x" }); }, ["pattern-invalid"]],
  ["a service pattern with no reason", (r) => { r.not_connectors.services.push({ pattern: "openrouter" }); }, ["pattern-reason"]],
  ["an excuse with no reason", (r) => { r.artifacts.pop(); r.connectors.acme.direction = "source"; r.not_connectors.artifacts["recipes/acme-digest"] = ""; }, ["excuse-reason"], (t) => { delete t.metadataByPath.get("recipes/acme-digest")!.connectors; }], // PROBE_TREE sets the key
  ["an artifact path that is not <category>/<slug>", (r) => { r.artifacts[1].path = "Recipes/Acme Digest"; }, ["artifact-path", "coverage-unregistered"]],
  ["a capability repeated within an artifact", (r) => { r.artifacts[0].capabilities.push({ ...r.artifacts[0].capabilities[0] }); }, ["capability-duplicate"]],
  ["a registry that is not an object", () => {}, ["shape"], null],
  ["an artifacts block that is an object, not a list", (r: ProbeWith<"artifacts", { [i: number]: ProbeArtifact; a?: ProbeArtifact }>) => { r.artifacts = { a: r.artifacts[0] }; }, ["shape", "coverage-unregistered", "connector-set"]],
  ["an artifact marked only by a tag naming its connector", (r) => {}, ["coverage-unregistered"], (t) => { t.metadataByPath.set("recipes/acme-notes", { requires: { services: ["OpenRouter"] }, tags: ["acme", "notes"] }); t.existingDirs.push("recipes/acme-notes"); }],
  ["a vendor named first in a service string a provider pattern also matches", (r) => {}, ["coverage-unregistered"], (t) => { t.metadataByPath.set("recipes/notion-sync", { requires: { services: ["Notion API (summaries via OpenRouter)"] }, tags: ["notes"] }); t.existingDirs.push("recipes/notion-sync"); }],
  ["a vendor first with the provider as the second token, bracketed or slashed", (r) => {}, ["coverage-unregistered"], (t) => { t.metadataByPath.set("recipes/notion-sync", { requires: { services: ["Notion (OpenRouter)"] }, tags: ["notes"] }); t.metadataByPath.set("recipes/mail-sync", { requires: { services: ["Gmail/OpenRouter"] }, tags: ["notes"] }); t.existingDirs.push("recipes/notion-sync", "recipes/mail-sync"); }],
  ["a connector's name as a tag in another case", (r) => {}, ["coverage-unregistered"], (t) => { t.metadataByPath.set("recipes/acme-notes", { requires: { services: ["OpenRouter"] }, tags: ["Acme", "Notes"] }); t.existingDirs.push("recipes/acme-notes"); }],
  ["an artifact marked only by a tag the brain's own vocabulary shares (capture) is not marked", (r) => {}, [], (t) => { t.metadataByPath.set("recipes/own-capture", { requires: { services: ["OpenRouter"] }, tags: ["capture", "export", "sync"] }); t.existingDirs.push("recipes/own-capture"); }],
  ["a family declared as null and used", (r: ProbeWith<"families", Record<string, Family | null>>) => { r.families["web-clip"] = null; r.artifacts[0].capabilities[0].family = "web-clip"; }, ["family-schema"]],
  ["a fold-in row naming a contribution that is gone", (r) => {}, ["disposition-stale"], (t) => { t.dispositionText += "| `gone-capture` | keep + audited → fold-in **SMD-1867** | removed since |\n"; }],
  // The three below keep a provider service on the probe tree so the openrouter pattern stays live: the table is the only trigger under test.
  ["an artifact the disposition table alone marks (a batch importer naming a provider only, declaring nothing)", (r) => { r.artifacts.shift(); r.connectors.acme.direction = "sink"; }, ["coverage-unregistered"], (t) => { t.metadataByPath.set("integrations/acme-capture", { requires: { services: ["OpenRouter"] }, tags: [] }); }],
  ["a fold-in row for a directory whose metadata did not parse marks nothing", (r) => { r.artifacts.shift(); r.connectors.acme.direction = "sink"; }, [], (t) => { t.metadataByPath.set("integrations/acme-capture", null); t.metadataByPath.set("recipes/plain-tool", { requires: { services: ["Supabase", "OpenRouter"] }, tags: ["ops"] }); }],
  ["a fold-in row after a fenced `# comment` under the same heading", (r) => { r.artifacts.shift(); r.connectors.acme.direction = "sink"; }, ["coverage-unregistered"], (t) => { t.metadataByPath.set("integrations/acme-capture", { requires: { services: ["OpenRouter"] }, tags: [] }); t.dispositionText = t.dispositionText.replace("| Artifact |", "```sh\n# a comment in an example\n```\n| Artifact |"); }],
  ["a service pattern that matches the empty string (a trailing `|`)", (r) => { r.not_connectors.services[0].pattern = "openrouter|"; }, ["pattern-invalid"]],
  ["a registry entry for a placeholder directory", (r) => { r.artifacts[1].path = "recipes/_template"; }, ["artifact-path", "coverage-unregistered"]],
  ["a disposition table that is missing", (r) => {}, ["disposition-missing"], (t: Tree) => { t.dispositionText = null; }],
  ["a disposition table with one category's heading moved (partly dark)", (r) => {}, ["disposition-dark"], (t) => { t.dispositionText = "### `recipes/` (1)\n\n| `acme-digest` | keep + audited → SMD-1867 candidate | x |\n\n## Integrations\n\n| `acme-capture` | keep + audited → fold-in **SMD-1867** | x |\n"; }],
  ["a not-a-connector pattern broad enough to cover a classified vendor's own service", (r) => { r.not_connectors.services.push({ pattern: "acme", reason: "too broad" }); }, ["pattern-broad"]],
  ["a provider as the bare second word after a vendor's name", (r) => {}, ["coverage-unregistered"], (t) => { t.metadataByPath.set("recipes/notion-sync", { requires: { services: ["Notion OpenRouter summaries"] }, tags: ["notes"] }); t.existingDirs.push("recipes/notion-sync"); }],
  ["a capability with a direction typo beside source capabilities (no spurious connector-direction)", (r) => { r.artifacts[1].capabilities[0].direction = "both"; r.connectors.acme.direction = "source"; }, ["capability-value"]],
  ["a fold-in row for a directory with no metadata.json marks nothing", (r) => { r.artifacts.shift(); r.connectors.acme.direction = "sink"; }, [], (t) => { t.metadataByPath.delete("integrations/acme-capture"); t.metadataByPath.set("recipes/plain-tool", { requires: { services: ["Supabase", "OpenRouter"] }, tags: ["ops"] }); }],
  ["a registry path with a space, which the walk admits", (r) => { r.artifacts[1].path = "recipes/acme digest"; }, ["artifact-missing", "coverage-unregistered"]],
  ["a disposition table whose headings moved to `##`, yielding no fold-in", (r) => {}, ["disposition-dark"], (t) => { t.dispositionText = t.dispositionText.replace("### ", "## "); }],
  ["a capability that is a bare string", (r: ProbeWith<"artifacts", { path: string; capabilities: (ProbeCapability | string)[] }[]>) => { r.artifacts[1].capabilities[0] = "acme"; r.connectors.acme.direction = "source"; }, ["capability-keys", "connectors-field"]],
  ["an artifact listed twice, the duplicate under another vendor (the first entry is judged)", (r) => { r.artifacts.push({ path: "recipes/acme-digest", capabilities: [{ vendor: "beta", family: "message-stream/chat", transport: "push", direction: "sink", cardinality: "many:1", round_trip: "read-only", fetcher: "native-driver" }] }); r.connectors.beta = { direction: "sink" }; }, ["artifact-duplicate"]],
];
/** Non-probes: what the rules must accept (a `want` of []) and must not throw on. */
const REGISTRY_NON_PROBES: RegistryProbe[] = [
  ["a contribution naming only a model provider is not marked", (r) => {}, [], (t) => { t.metadataByPath.set("recipes/uses-a-model", { requires: { services: ["OpenRouter"] }, tags: ["synthesis"] }); t.existingDirs.push("recipes/uses-a-model"); }],
  ["two patterns matching one service are both live (the narrower inside the word, covering nothing)", (r) => { r.not_connectors.services.push({ pattern: "router", reason: "overlaps openrouter on purpose" }); }, []],
  ["a provider first and qualified after is covered", (r) => {}, [], (t) => { t.metadataByPath.set("recipes/uses-a-gateway", { requires: { services: ["Any OpenRouter-compatible LLM gateway (Ollama, etc.)", "Optional: OpenRouter (Sonar) for live search"] }, tags: ["synthesis"] }); t.existingDirs.push("recipes/uses-a-gateway"); }],
  ["a pattern whose only match lies past the head is live, though it covers nothing", (r) => { r.not_connectors.services.push({ pattern: "sonar", reason: "a model" }); }, [], (t) => { t.metadataByPath.set("recipes/uses-a-gateway", { requires: { services: ["Optional: OpenRouter (Sonar) for live search"] }, tags: ["synthesis"] }); t.existingDirs.push("recipes/uses-a-gateway"); }],
  ["an excuse for a directory that exists without a metadata.json waits on check 1", (r) => { r.not_connectors.artifacts["recipes/no-meta"] = "waiting on its metadata"; }, [], (t) => { t.existingDirs.push("recipes/no-meta"); }],
  ["a registered artifact whose metadata did not parse gets no coverage verdict", (r) => {}, [], (t) => { t.metadataByPath.set("recipes/acme-digest", null); }],
  ["a metadata whose tags and services are strings marks nothing and throws nothing", (r) => {}, [], (t) => { t.metadataByPath.set("recipes/odd-tool", { requires: { services: "Acme Chat API" }, tags: "digest" }); t.existingDirs.push("recipes/odd-tool"); }],
];
/** [text, want]: what dispositionPaths reads from a table — the fold-in marker in the Disposition cell under a contribution-category heading, and nothing from the Justification cell, past another heading, under `docs/drafts/`, or from a bare mention or a negation. */
const DISPOSITION_PROBES: [text: string, want: string[]][] = [
  ["### `integrations/` (2)\n\n| Artifact | Disposition | Justification |\n|---|---|---|\n| `a-capture` | keep + audited → fold-in **SMD-1867** | x |\n| `b-tool` | keep + audited | mentioned beside SMD-1867 and SMD-1924; a tool, not a fold-in |\n| `e-graph` | keep + audited | a graph view; not an SMD-1867 adapter |\n\n### `recipes/` (1)\n\n| `c-import` | keep + audited → SMD-1867 candidate | x |\n| `f-import` | keep + audited *(drop one sub-file)* → SMD-1867 candidate | x |\n| `h-import` | remove | superseded by the seam; was the SMD-1867 candidate |\n| `i-import` | remove — was the SMD-1867 candidate | superseded by the seam |\n| `g-ext` | keep + audited | A capture adapter under the SMD-1867 contract, not an ad-hoc integration. |\n\n### `docs/drafts/` (1)\n\n| `sketch.md` | keep + audited → SMD-1867 candidate | not a contribution directory |\n\n## Notes\n\n| `d-tool` | remove → fold-in **SMD-1867** | was considered |\n", ["integrations/a-capture", "recipes/c-import", "recipes/f-import"]],
  ["## Summary\n\n| `x-tool` | fold-in **SMD-1867** |\n", []],
];
function checkConnectorRegistry() {
  // One pattern for a vendor key: the schema's for metadata `connectors`, the registry's for its vendors.
  if (props.connectors?.items?.pattern !== VENDOR_PATTERN) fail(".github/metadata.schema.json", `connectors.items.pattern is ${JSON.stringify(props.connectors?.items?.pattern)} but scripts/connector-registry.ts's VENDOR_PATTERN is ${JSON.stringify(VENDOR_PATTERN)} — one definition of a vendor key (SMD-1933)`);
  const kindsOf = (registry: Registry | null, tree: Tree = PROBE_TREE()) => [...new Set(registryProblems({ registry, ...tree }).map((p) => p.kind))].sort();
  const base = registryProblems({ registry: PROBE_REGISTRY(), ...PROBE_TREE() });
  if (base.length) return fail(SELF, `check 19's baseline registry fails its own rules (${base.map((p) => `${p.kind}: ${p.msg}`).join("; ")}) — the mutants below measure nothing`);
  for (const [text, want] of DISPOSITION_PROBES) {
    const got = dispositionPaths(text);
    if (JSON.stringify(got) !== JSON.stringify(want)) fail(SELF, `check 19's disposition reader returns [${got}], expected [${want}] (its own probe)`);
  }
  // A fourth element: null runs the mutant on a null registry; a function reshapes the tree. A `want` of []
  // is a non-probe — a case the rules must accept and not throw on.
  for (const [why, mutate, want, tree] of [...REGISTRY_PROBES, ...REGISTRY_NON_PROBES]) {
    let r: ProbeRegistry | null = PROBE_REGISTRY();
    if (tree === null) r = null; else mutate(r);
    const t = PROBE_TREE();
    if (typeof tree === "function") tree(t);
    let got: string[];
    try { got = kindsOf(r, t); } catch (e) { fail(SELF, `check 19 throws for ${why}: ${(e as Error).message} (its own probe)`); continue; }
    if (JSON.stringify(got) !== JSON.stringify([...want].sort())) fail(SELF, `check 19 reports [${got}] for ${why}, expected [${want}] (its own probe)`);
  }

  if (!existsSync(join(ROOT, REGISTRY_PATH))) return fail(REGISTRY_PATH, "missing — the connector taxonomy's one source (SMD-1933)");
  let registry: Registry;
  try { registry = readRegistry(ROOT); } catch (e) { return fail(REGISTRY_PATH, `does not parse: ${(e as Error).message} (SMD-1933)`); }
  const dispositionText = existsSync(join(ROOT, DISPOSITION_PATH)) ? readFileSync(join(ROOT, DISPOSITION_PATH), "utf8") : null;
  let problems: Problem[];
  // readMetadata is the one statement of "absent is not in the map, unparseable is null (no verdict)" — the CLI reads the same; check 1 names the unparseable file.
  try { problems = registryProblems({ registry, existingDirs: dirs.map((d) => d.rel), metadataByPath: readMetadata(dirs), dispositionText }); } catch (e) { return fail(REGISTRY_PATH, `check 19 threw instead of reporting: ${(e as Error).message} (SMD-1933)`); }
  for (const p of problems) fail(p.where, `${p.msg} (SMD-1933)`);
  if (!existsSync(join(ROOT, SPEC_PATH))) return fail(SPEC_PATH, "missing — the spec that carries the registry's rendered tables (SMD-1933)");
  const span = tablesSpan(readFileSync(join(ROOT, SPEC_PATH), "utf8"));
  if (!span) return fail(SPEC_PATH, "the generated-tables markers are missing or doubled (SMD-1933)");
  // The renderer assumes a sound registry (the CLI refuses to render otherwise); an unsound one has its findings above.
  if (problems.length === 0 && span.block !== renderClassification(registry)) fail(SPEC_PATH, `the generated tables differ from what ${REGISTRY_PATH} renders — run \`bun scripts/connector-registry.ts\` (SMD-1933)`);
}
checkConnectorRegistry();
// ── 20: main's ruleset is a record in the tree, and the record names every job (SMD-1856) ──
/**
 * The ruleset GitHub enforces on `main` (id 22189960) lived outside the tree,
 * where a job added to the workflow was not added to it — which is how the
 * replay gate ran unrequired from SMD-1295 until this ticket. And with strict
 * off, a run green against the `main` of its trigger time stayed green after
 * `main` moved, so two branches could each pass and together break the tree.
 * `.github/rulesets/main.json` is the body that
 * `gh api -X PUT repos/MHarris-SgyMd/OB1/rulesets/22189960 --input` applies, so
 * the setting is reviewed here first; this check holds the record to the
 * workflow — every job's display name required, nothing required that is not a
 * job — and to the ticket's decisions: the default branch as the target, strict
 * up-to-date on, every check pinned to the Actions app so only a workflow run
 * satisfies it, a pull-request rule with no required review (one maintainer)
 * and none of the review flags that would ask one another way, deletion and
 * force-push refused, no bypass actor, enforcement active. The workflow is held
 * to names this check can predict: no matrix, no expression in a name, no two
 * jobs sharing one — any of those and the required context never matches, the
 * check waits forever and every PR blocks. The record can still drift from the
 * live ruleset — CI's token cannot read it, and a GET adds defaults the record
 * omits — so FORK.md names the one command that re-applies it.
 */
const RULESET = ".github/rulesets/main.json";
/** GitHub's own app id for Actions: a required check pinned to it is satisfied by a workflow run and by nothing else — not a status another app or a token posts under the same name. */
const GITHUB_ACTIONS_APP_ID = 15368;
/** The rule types the record carries, each exactly once; another type (a linear-history rule, say) is a decision the ticket declined, and edits this list with it. */
const RULE_TYPES = ["deletion", "non_fast_forward", "pull_request", "required_status_checks"];
/** The one ref the ruleset targets: GitHub's alias for the default branch, so a rename of `main` carries it. */
const RULESET_REFS = ["~DEFAULT_BRANCH"];
/** The pull-request rule's flags, each held false: any of them true asks a review, or blocks on a thread, that the zero count says nothing asks. */
const PR_RULE_FLAGS = ["dismiss_stale_reviews_on_push", "require_code_owner_review", "require_last_push_approval", "required_review_thread_resolution"];
/** The record as rulesetProblems reads it: every level optional, as the `?.`s say. */
type RulesetDoc = {
  target?: unknown;
  enforcement?: unknown;
  bypass_actors?: unknown;
  conditions?: { ref_name?: { include?: unknown; exclude?: unknown } } | null;
  rules?: ({ type?: unknown; parameters?: ({ strict_required_status_checks_policy?: unknown; do_not_enforce_on_create?: unknown; required_status_checks?: unknown; required_approving_review_count?: unknown } & Record<string, unknown>) | null } | null)[];
} | null | undefined;
/** The workflow as workflowJobs reads it: a job's display name is its `name`, else its key — what GitHub reports the check as — and a matrix multiplies it. */
type JobsDoc = { jobs?: Record<string, { name?: unknown; strategy?: { matrix?: unknown } | null } | null | undefined> | null } | null | undefined;
/**
 * The display names the workflow's jobs report as checks, and the jobs whose
 * name this check cannot predict: a `strategy.matrix` job reports one check per
 * cell, named `<name> (<values>)`; a name holding `${{ … }}` is rendered at run
 * time; two jobs with one display name are one context GitHub cannot tell
 * apart. Each is refused here, before the record is compared to the list.
 */
function workflowJobs(doc: JobsDoc) {
  const names: string[] = [];
  const problems: [string, string][] = [];
  for (const [key, job] of Object.entries(doc?.jobs ?? {})) {
    const name = typeof job?.name === "string" ? job.name : key;
    if (job?.strategy && typeof job.strategy === "object" && "matrix" in job.strategy) problems.push([WORKFLOW, `job ${key} runs a matrix — GitHub reports one check per cell, named after its values, which ${RULESET} cannot name; give each cell its own job (SMD-1856)`]);
    else if (name.includes("${{")) problems.push([WORKFLOW, `job ${key} is named by an expression (${name}) — the check's context is rendered at run time and ${RULESET} cannot name it (SMD-1856)`]);
    else if (names.includes(name)) problems.push([WORKFLOW, `job ${key} shares the display name "${name}" with another job — one context for two jobs (SMD-1856)`]);
    else names.push(name);
  }
  return { names, problems };
}
function rulesetProblems(ruleset: RulesetDoc, jobNames: string[]) {
  const problems: [string, string][] = [];
  if (!ruleset || typeof ruleset !== "object") return [[RULESET, "is missing or does not parse — the body main's ruleset is applied from (SMD-1856)"]] as [string, string][];
  if (ruleset.target !== "branch") problems.push([RULESET, `target is ${JSON.stringify(ruleset.target)}, not "branch" (SMD-1856)`]);
  if (ruleset.enforcement !== "active") problems.push([RULESET, `enforcement is ${JSON.stringify(ruleset.enforcement)}, not "active" (SMD-1856)`]);
  if (!Array.isArray(ruleset.bypass_actors) || ruleset.bypass_actors.length) problems.push([RULESET, "bypass_actors is not the empty list — the ruleset applies to admins too (SMD-1856)"]);
  const refs = ruleset.conditions?.ref_name;
  if (JSON.stringify(refs?.include) !== JSON.stringify(RULESET_REFS) || !Array.isArray(refs?.exclude) || refs.exclude.length) problems.push([RULESET, `conditions.ref_name is not {include: ${JSON.stringify(RULESET_REFS)}, exclude: []} — the ruleset would apply to something other than the default branch, or to nothing (SMD-1856)`]);
  const rules = Array.isArray(ruleset.rules) ? ruleset.rules : [];
  const types = rules.map((r) => (typeof r?.type === "string" ? r.type : "(untyped)"));
  for (const t of RULE_TYPES) if (types.filter((x) => x === t).length !== 1) problems.push([RULESET, `carries the ${t} rule ${types.filter((x) => x === t).length} time(s), not once (SMD-1856)`]);
  for (const t of new Set(types)) if (!RULE_TYPES.includes(t)) problems.push([RULESET, `carries a ${t} rule that RULE_TYPES in ${SELF} does not name — a new rule is a decision; record it there with the reason (SMD-1856)`]);
  const pr = rules.find((r) => r?.type === "pull_request");
  if (pr) {
    if (pr.parameters?.required_approving_review_count !== 0) problems.push([RULESET, `the pull_request rule's required_approving_review_count is ${JSON.stringify(pr.parameters?.required_approving_review_count)}, not 0 — one maintainer; a required review blocks every PR (SMD-1856)`]);
    for (const flag of PR_RULE_FLAGS) if (pr.parameters?.[flag] !== false) problems.push([RULESET, `the pull_request rule's ${flag} is ${JSON.stringify(pr.parameters?.[flag])}, not false — a review, or a resolved thread, asked another way than the count (SMD-1856)`]);
  }
  const checksRule = rules.find((r) => r?.type === "required_status_checks");
  if (!checksRule) return problems;
  const checks = checksRule.parameters;
  if (!checks || typeof checks !== "object") { problems.push([RULESET, "the required_status_checks rule has no parameters — strict, the contexts and the pins live there (SMD-1856)"]); return problems; }
  if (checks.strict_required_status_checks_policy !== true) problems.push([RULESET, "strict_required_status_checks_policy is not true — a run green against an older main would stay green after main moves (SMD-1856)"]);
  if (checks.do_not_enforce_on_create !== false) problems.push([RULESET, `do_not_enforce_on_create is ${JSON.stringify(checks.do_not_enforce_on_create)}, not false — a branch created at main's ref would skip the checks (SMD-1856)`]);
  if (!Array.isArray(checks.required_status_checks)) { problems.push([RULESET, `required_status_checks is ${JSON.stringify(checks.required_status_checks)}, not a list (SMD-1856)`]); return problems; }
  const required = checks.required_status_checks as ({ context?: unknown; integration_id?: unknown } | null)[];
  const contexts = required.map((c) => (typeof c?.context === "string" ? c.context : ""));
  for (const c of required) {
    if (typeof c?.context !== "string" || !c.context) problems.push([RULESET, `a required check has no context: ${JSON.stringify(c)} (SMD-1856)`]);
    else if (c.integration_id !== GITHUB_ACTIONS_APP_ID) problems.push([RULESET, `"${c.context}" is not pinned to the Actions app (integration_id ${GITHUB_ACTIONS_APP_ID}) — unpinned, a status any app posts under the name satisfies it (SMD-1856)`]);
  }
  for (const c of new Set(contexts)) if (c && contexts.filter((x) => x === c).length > 1) problems.push([RULESET, `requires "${c}" twice (SMD-1856)`]);
  for (const name of jobNames) if (!contexts.includes(name)) problems.push([RULESET, `does not require "${name}", a job ${WORKFLOW} runs — every job is required, or a PR merges with it red; add it and re-apply the ruleset (SMD-1856)`]);
  for (const c of new Set(contexts)) if (c && !jobNames.includes(c)) problems.push([RULESET, `requires "${c}", which no job in ${WORKFLOW} is named — a renamed or removed job leaves the check waiting forever and every PR blocked (SMD-1856)`]);
  return problems;
}
/** A record every rule accepts, with every field a mutant can reach, and the job list it is judged against. */
type RulesetProbeRule = { type: string; parameters?: { strict_required_status_checks_policy?: boolean; do_not_enforce_on_create?: boolean; required_status_checks?: ({ context?: string; integration_id?: number } | null)[] | string; required_approving_review_count?: number; [flag: string]: unknown } | null };
type RulesetProbe = { target: string; enforcement: string; bypass_actors: unknown[]; conditions: { ref_name: { include: string[]; exclude: string[] } } | null; rules: RulesetProbeRule[] };
const RULESET_PROBE_JOBS = ["Server tests", "Repo consistency"];
const RULESET_PROBE = (): RulesetProbe => ({
  target: "branch",
  enforcement: "active",
  bypass_actors: [],
  conditions: { ref_name: { include: [...RULESET_REFS], exclude: [] } },
  rules: [
    { type: "deletion" },
    { type: "non_fast_forward" },
    { type: "pull_request", parameters: { required_approving_review_count: 0, ...Object.fromEntries(PR_RULE_FLAGS.map((f) => [f, false])) } },
    { type: "required_status_checks", parameters: { strict_required_status_checks_policy: true, do_not_enforce_on_create: false, required_status_checks: RULESET_PROBE_JOBS.map((context) => ({ context, integration_id: GITHUB_ACTIONS_APP_ID })) } },
  ],
});
/** [why, mutate (returns the record to judge — the mutated probe, or null for no record), the job list, a phrase the ONE problem must carry]. */
const RULESET_MUTANTS: [why: string, mutate: (g: RulesetProbe) => RulesetProbe | null, jobs: string[], says: string][] = [
  ["a job the record does not require", (g) => g, [...RULESET_PROBE_JOBS, "Retrieval replay gate"], 'does not require "Retrieval replay gate"'],
  ["a required check no job is named", (g) => { (g.rules[3].parameters!.required_status_checks as object[]).push({ context: "Old job", integration_id: GITHUB_ACTIONS_APP_ID }); return g; }, RULESET_PROBE_JOBS, 'requires "Old job", which no job'],
  ["a required check with no context", (g) => { (g.rules[3].parameters!.required_status_checks as object[]).push({ integration_id: GITHUB_ACTIONS_APP_ID }); return g; }, RULESET_PROBE_JOBS, "has no context"],
  ["strict off", (g) => { g.rules[3].parameters!.strict_required_status_checks_policy = false; return g; }, RULESET_PROBE_JOBS, "strict_required_status_checks_policy is not true"],
  ["enforce-on-create off", (g) => { g.rules[3].parameters!.do_not_enforce_on_create = true; return g; }, RULESET_PROBE_JOBS, "do_not_enforce_on_create is true"],
  ["a check not pinned to the Actions app", (g) => { delete (g.rules[3].parameters!.required_status_checks as { integration_id?: number }[])[0].integration_id; return g; }, RULESET_PROBE_JOBS, "is not pinned to the Actions app"],
  ["a check required twice", (g) => { (g.rules[3].parameters!.required_status_checks as object[]).push({ context: RULESET_PROBE_JOBS[0], integration_id: GITHUB_ACTIONS_APP_ID }); return g; }, RULESET_PROBE_JOBS, `requires "${RULESET_PROBE_JOBS[0]}" twice`],
  ["a required_status_checks rule with no parameters", (g) => { g.rules[3].parameters = null; return g; }, RULESET_PROBE_JOBS, "has no parameters"],
  ["a required_status_checks list that is a string", (g) => { g.rules[3].parameters!.required_status_checks = "Server tests"; return g; }, RULESET_PROBE_JOBS, "not a list"],
  ["no pull-request rule", (g) => { g.rules.splice(2, 1); return g; }, RULESET_PROBE_JOBS, "pull_request rule 0 time(s)"],
  ["a doubled deletion rule", (g) => { g.rules.push({ type: "deletion" }); return g; }, RULESET_PROBE_JOBS, "deletion rule 2 time(s)"],
  ["a pull-request rule requiring a review", (g) => { g.rules[2].parameters!.required_approving_review_count = 1; return g; }, RULESET_PROBE_JOBS, "required_approving_review_count is 1"],
  ["a pull-request rule requiring thread resolution", (g) => { g.rules[2].parameters!.required_review_thread_resolution = true; return g; }, RULESET_PROBE_JOBS, "required_review_thread_resolution is true"],
  ["a linear-history rule", (g) => { g.rules.push({ type: "required_linear_history" }); return g; }, RULESET_PROBE_JOBS, "carries a required_linear_history rule"],
  ["a bypass actor", (g) => { g.bypass_actors.push({ actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" }); return g; }, RULESET_PROBE_JOBS, "bypass_actors is not the empty list"],
  ["enforcement set to evaluate", (g) => { g.enforcement = "evaluate"; return g; }, RULESET_PROBE_JOBS, 'enforcement is "evaluate"'],
  ["a push target", (g) => { g.target = "push"; return g; }, RULESET_PROBE_JOBS, 'target is "push"'],
  ["a ruleset aimed at another branch", (g) => { g.conditions!.ref_name.include = ["refs/heads/dev"]; return g; }, RULESET_PROBE_JOBS, "conditions.ref_name is not"],
  ["a ruleset with no conditions", (g) => { g.conditions = null; return g; }, RULESET_PROBE_JOBS, "conditions.ref_name is not"],
  ["no record at all", () => null, RULESET_PROBE_JOBS, "is missing or does not parse"],
];
/** Non-probes: shapes the rules must not throw on and must report at least one problem for — a record that parsed but is not a ruleset. */
const RULESET_NON_PROBES: [why: string, record: unknown][] = [
  ["a list", []],
  ["a string", "main"],
  ["an object with no fields", {}],
  ["rules that are not a list", { ...RULESET_PROBE(), rules: "deletion" }],
  ["a null rule", { ...RULESET_PROBE(), rules: [null] }],
  ["a null required check", (() => { const g = RULESET_PROBE(); (g.rules[3].parameters!.required_status_checks as (object | null)[]).push(null); return g; })()],
  ["a pull-request rule with no parameters", (() => { const g = RULESET_PROBE(); delete g.rules[2].parameters; return g; })()],
  ["conditions that are a string", { ...RULESET_PROBE(), conditions: "main" }],
];
/** The workflow reader's probes: [why, jobs, a phrase the one problem must carry]; the plain job by name and by key are read before them. */
const WORKFLOW_MUTANTS: [why: string, jobs: Record<string, { name?: string; strategy?: { matrix?: unknown } | null }>, says: string][] = [
  ["a matrix job", { a: { name: "Server tests", strategy: { matrix: { x: [1, 2] } } } }, "runs a matrix"],
  ["a job named by an expression", { a: { name: "Tests (${{ matrix.x }})" } }, "named by an expression"],
  ["two jobs with one display name", { a: { name: "Server tests" }, b: { name: "Server tests" } }, "shares the display name"],
];
function checkRulesetRecord() {
  // Self-test: a record every rule accepts passes; each mutant reports exactly
  // one problem, and that problem names what the mutant broke; a non-probe
  // reports something and throws nothing.
  const base = rulesetProblems(RULESET_PROBE(), RULESET_PROBE_JOBS);
  if (base.length) fail(SELF, `check 20 false-positives on a consistent record (${base.map((p) => p[1]).join("; ")})`);
  for (const [why, mutate, names, says] of RULESET_MUTANTS) {
    const got = rulesetProblems(mutate(RULESET_PROBE()), [...names]);
    if (got.length !== 1) fail(SELF, `check 20 reports ${got.length} problem(s) for ${why}, not one (its own probe): ${JSON.stringify(got)}`);
    else if (!got[0][1].includes(says)) fail(SELF, `check 20's one problem for ${why} does not say "${says}" (its own probe): ${got[0][1]}`);
  }
  for (const [why, record] of RULESET_NON_PROBES) {
    let got: [string, string][];
    try { got = rulesetProblems(record as RulesetDoc, RULESET_PROBE_JOBS); } catch (e) { fail(SELF, `check 20 throws for ${why}: ${(e as Error).message} (its own probe)`); continue; }
    if (!got.length) fail(SELF, `check 20 accepts ${why} (its own probe)`);
  }
  const plain = workflowJobs({ jobs: { a: { name: "Server tests" }, b: {}, c: null, d: { strategy: null } } });
  if (plain.problems.length || JSON.stringify(plain.names) !== JSON.stringify(["Server tests", "b", "c", "d"])) fail(SELF, `check 20 reads a plain workflow as ${JSON.stringify(plain)} (its own probe)`);
  for (const [why, jobs, says] of WORKFLOW_MUTANTS) {
    const got = workflowJobs({ jobs }).problems;
    if (got.length !== 1 || !got[0][1].includes(says)) fail(SELF, `check 20 reports ${JSON.stringify(got)} for ${why}, not one problem saying "${says}" (its own probe)`);
  }
  if (typeof Bun === "undefined" || typeof Bun.YAML?.parse !== "function") {
    fail(SELF, `check 20 parses ${WORKFLOW} with Bun.YAML (Bun 1.2+) and this runtime has none — run \`bun ${SELF}\`, as CI does (SMD-1856)`);
    return;
  }
  let ruleset: RulesetDoc = null;
  if (existsSync(join(ROOT, RULESET))) {
    try { ruleset = JSON.parse(readFileSync(join(ROOT, RULESET), "utf8")); } catch { ruleset = null; }
  }
  let doc: JobsDoc = null;
  try { doc = Bun.YAML.parse(readFileSync(join(ROOT, WORKFLOW), "utf8")) as JobsDoc; } catch (e) { return fail(WORKFLOW, `does not parse: ${(e as Error).message} — check 20 has no job list to hold the record to (SMD-1856)`); }
  const { names, problems } = workflowJobs(doc);
  if (!names.length && !problems.length) return fail(WORKFLOW, "has no jobs check 20 can read — the record cannot be held to an empty list (SMD-1856)");
  for (const [where, msg] of [...problems, ...rulesetProblems(ruleset, names)]) fail(where, msg);
}
checkRulesetRecord();

// ── 21: a .sql file never destroys rows a brain already holds ────────────────
//
// SMD-1936. CLAUDE.md's guard rail and CONTRIBUTING.md's review checklist said
// "no DROP TABLE, DROP DATABASE, TRUNCATE or unqualified DELETE FROM in SQL
// files" and nothing on this fork checked it. Upstream's PR gate
// (ob1-gate-v2.yml, rule 5) greps a PR's changed .sql files for the words on
// any line, comments included, and calls a DELETE unqualified when its own
// line has no WHERE; the fork does not run that gate (FORK.md's detach note:
// it enforces contribution rules this fork does not follow), and
// read that literally the rail fails the one file that applies it — 046's
// `BEFORE TRUNCATE ON thought_audit` trigger, which REFUSES truncation, was
// flagged twice in SMD-1730's review against the sentence — and 034's
// `DELETE FROM query_log` with its WHERE on the next line. So the rule is
// stated as what it means, a SQL file must never destroy rows a brain already
// holds, and read as STATEMENTS: db/config.mjs's DESTRUCTIVE_SQL_RULES through
// destructiveSqlIn — the comment-stripped text (stripSqlComments, literal-
// aware, so a header quoting a statement to say why the file has none is not
// a hit), a TRUNCATE counted only when a table follows it (a trigger event, a
// privilege and the bare value `TG_OP = 'TRUNCATE'` are not it), a DELETE FROM
// counted only when its statement — to the `;`, or the `)` that closes its
// CTE, a literal's parentheses and semicolons not counted — has no WHERE of
// its own at the top level (a WHERE inside a USING subquery or a format()
// argument qualifies nothing; the first review pass found both holes), DROP
// TABLE, DROP DATABASE/SCHEMA and DROP OWNED wherever they stand outside a
// quoted identifier (`"a DROP TABLE b"` names a column), string literals read
// because an EXECUTE string runs — which makes a statement quoted in prose
// (`RAISE EXCEPTION 'TRUNCATE refused'`) a hit as well; the remedy is check
// 12's, a `--` comment or a rewording, and the messages say so. test-schema
// does not repeat the scan: the migrations are in this check's scope as
// files, and a substituted value (`${EMBEDDING_DIM}`) is never one of these
// statements.
//
// Scope: every .sql git tracks or would track (citationFiles, check 15's
// listing) — the seven category directories, docs/, deploy/ AND
// db/migrations/; an ignored file, the Supabase CLI's supabase/migrations or
// a recipe's data/, is not the tree's. The fork's migrations DROP FUNCTION and DROP TRIGGER deliberately
// (032/033/046's ACL replays, 046's own trigger), which the rail does not name
// and which destroy no row; no migration has ever dropped a table — a scratch
// table is a TEMP table ON COMMIT DROP (016's `_rte_in`), and the dead `DROP
// TABLE IF EXISTS` change 61 records was db/migrate.ts's, TypeScript — so the
// migrations are held to the same rule with no carve-out. Outside the rule, by
// the rail's own words ("in SQL files"): SQL inside .ts (compat's suite drops
// the tables it makes, test-schema empties the one it owns) and the heredocs
// of a recipe's init .sh. Exceptions are per (file, rule) and COUNTED as check
// 7's are; the list is empty, and a file that needs one says why beside it.

/** Statements each rule must catch — the check's own negative tests, run through the rules every time. */
const DESTRUCTIVE_SQL_PROBES: [string, string][] = [
  ["truncate", "TRUNCATE thoughts;"],
  ["truncate", "truncate table only public.thoughts restart identity cascade;"],
  ["truncate", 'TRUNCATE "thoughts";'],
  ["truncate", "BEGIN\n  TRUNCATE\n    thought_chunks;\nEND"],
  ["truncate", "EXECUTE 'TRUNCATE ' || quote_ident(p_table);"],
  ["truncate", "EXECUTE format('TRUNCATE %I', p_table);"],
  ["drop-table", "DROP TABLE IF EXISTS thoughts CASCADE;"],
  ["drop-table", "drop table pg_temp.scratch;"],
  ["drop-database", "DROP DATABASE open_brain;"],
  ["drop-database", "DROP SCHEMA public CASCADE;"],
  ["unqualified-delete", "DELETE FROM thoughts;"],
  ["unqualified-delete", "DELETE FROM thoughts RETURNING id;"],
  ["unqualified-delete", "delete from only thoughts"],
  ["unqualified-delete", "DELETE FROM thoughts -- WHERE id = $1\n;"],
  ["unqualified-delete", "WITH gone AS (DELETE FROM thoughts RETURNING id) SELECT count(*) FROM gone WHERE id IS NOT NULL;"],
  ["unqualified-delete", "EXECUTE format('DELETE FROM %I', p_table);"],
  // First review pass: a WHERE that is not the statement's own, a literal that would move its boundary, the forms the regexes missed.
  ["unqualified-delete", "DELETE FROM thoughts USING (SELECT id FROM x WHERE y) s;"],
  ["unqualified-delete", "DELETE FROM thoughts RETURNING 'WHERE';"],
  ["unqualified-delete", "WITH d AS (DELETE FROM thoughts RETURNING id, '(') SELECT 1 WHERE true;"],
  ["unqualified-delete", "EXECUTE format('DELETE FROM %I', (SELECT n FROM x WHERE k = 1));"],
  // The `)` that closes the CTE must END the statement, not just lower the depth: a later CTE's
  // WHERE sits at depth 0 again once its `(` reopens (the depth-0 rule alone let this pass).
  ["unqualified-delete", "WITH d AS (DELETE FROM thoughts RETURNING id), e AS (SELECT 1 WHERE true) SELECT * FROM e;"],
  ["truncate", "EXECUTE format('TRUNCATE %1$I', p_table);"],
  ["truncate", "EXECUTE $q$TRUNCATE $q$ || quote_ident(p_table);"],
  ["drop-database", "DROP OWNED BY community CASCADE;"],
  // Second review pass: an apostrophe inside a dollar-quoted value must not open a literal that swallows the rest of the file; a tag may carry digits.
  ["unqualified-delete", "COMMENT ON TABLE t IS $q1$don't$q1$;\nDELETE FROM t RETURNING 'WHERE';"], // the blanker's own tag grammar, digits included
  ["truncate", "EXECUTE $q1$TRUNCATE $q1$ || quote_ident(p_table);"],
  // Third review pass: a dollar-quoted dynamic string's delete, and an unquoted non-ASCII name.
  ["unqualified-delete", "EXECUTE $q$DELETE FROM $q$ || quote_ident(p_table);"],
  ["truncate", "TRUNCATE Übersicht;"],
];
/** SQL this repository writes that no rule may catch. */
const DESTRUCTIVE_SQL_NON_PROBES = [
  "-- TRUNCATE thoughts; is what this file must never run",
  "/* DROP TABLE thoughts; DELETE FROM thoughts; */",
  "CREATE TRIGGER thought_audit_immutable_truncate\n  BEFORE TRUNCATE ON thought_audit\n  FOR EACH STATEMENT EXECUTE FUNCTION thought_audit_refuse_mutation();",
  "CREATE TRIGGER t AFTER INSERT OR DELETE OR TRUNCATE ON thoughts FOR EACH STATEMENT EXECUTE FUNCTION f();",
  "GRANT SELECT, INSERT, TRUNCATE ON thoughts TO community;",
  "REVOKE TRUNCATE, DELETE ON thoughts FROM PUBLIC;",
  "CASE WHEN TG_OP = 'TRUNCATE' THEN 'thought_audit_immutable_truncate' ELSE 'thought_audit_immutable' END",
  "DELETE FROM thoughts WHERE id = $1;",
  "DELETE FROM query_log\n   WHERE logged_at < now() - make_interval(days => p_keep_days);",
  "DELETE FROM _rte_in WHERE true;",
  "DELETE FROM _rte_in a USING _rte_in b\n   WHERE a.ntype = b.ntype AND a.nname = b.nname;",
  "WITH d AS (DELETE FROM ob1_entity_edges WHERE thought_id = p_thought_id RETURNING from_entity_id) SELECT 1;",
  "DELETE FROM thoughts WHERE id IN (SELECT id FROM thoughts ORDER BY created_at LIMIT 1);",
  "EXECUTE 'DELETE FROM ' || quote_ident(p_table) || ' WHERE id = $1' USING p_id;",
  "EXECUTE format('DELETE FROM %I WHERE id = $1', p_table) USING p_id;",
  "CREATE TEMP TABLE IF NOT EXISTS _rte_in (name text) ON COMMIT DROP;",
  "DROP TRIGGER IF EXISTS thought_audit_immutable_truncate ON thought_audit;",
  "DROP FUNCTION IF EXISTS update_thought(uuid, text, jsonb);",
  "DROP POLICY IF EXISTS p ON t;",
  "ALTER TABLE thoughts DROP CONSTRAINT IF EXISTS thoughts_derivation_layer_check;",
  "REFERENCES thoughts(id) ON DELETE CASCADE",
  "CREATE POLICY p ON t FOR DELETE USING (true);",
  "COMMENT ON COLUMN thoughts.truncated_at IS 'when the text was cut';",
  'SELECT "TRUNCATE", "DELETE FROM" FROM information_schema.role_table_grants;',
  "SELECT has_table_privilege('community', 'thoughts', 'TRUNCATE');",
  "ALTER TABLE thoughts ENABLE ALWAYS TRIGGER thought_audit_immutable_truncate;",
  "DELETE FROM thoughts WHERE false;",
  "COMMENT ON FUNCTION prune_query_log(int) IS 'Delete query_log rows older than p_keep_days. The DELETE is always bounded by logged_at.';",
  "DELETE FROM thoughts USING f(')') g WHERE thoughts.id = g.id;",
  "DELETE FROM thoughts USING (SELECT ';' AS s) x WHERE thoughts.id = $1;", // the literal's `;` before the WHERE
  // Second review pass: a keyword anywhere inside a quoted identifier; an apostrophe in a dollar-quoted value before a qualified delete.
  'SELECT "my TRUNCATE", "a DROP TABLE b", "x DELETE FROM y" FROM information_schema.role_table_grants;',
  "COMMENT ON TABLE t IS $$don't$$;\nDELETE FROM t USING f(')') g WHERE t.id = g.id;",
  "EXECUTE $q$DELETE FROM $q$ || quote_ident(p_table) || ' WHERE id = $1';", // third pass: the WHERE arrives in a `'…'` piece the blanked walk cannot see
];
/** file → rule → the reason and the exact hit count; a hit past the count fails, a count no hit reaches fails as stale. Empty: no file in the tree needs one. */
const DESTRUCTIVE_SQL_EXCEPTIONS = new Map<string, Record<string, CountedException>>([]);

function checkDestructiveSql() {
  const rules = new Set(DESTRUCTIVE_SQL_RULES.map((r) => r.name));
  for (const [rule, probe] of DESTRUCTIVE_SQL_PROBES) {
    if (!rules.has(rule)) { fail(SELF, `check 21's probe names rule '${rule}', which DESTRUCTIVE_SQL_RULES does not define (its own probe)`); continue; }
    if (!destructiveSqlIn(probe).some((h) => h.rule === rule)) fail(SELF, `check 21's rule '${rule}' no longer catches its probe: ${JSON.stringify(probe)} (its own probe)`);
  }
  for (const text of DESTRUCTIVE_SQL_NON_PROBES) {
    const [hit] = destructiveSqlIn(text);
    if (hit) fail(SELF, `check 21's rule '${hit.rule}' catches SQL this repository writes: ${JSON.stringify(text)} (its own probe)`);
  }
  // The line is the statement's own, through comments and a plpgsql body alike.
  const lined = destructiveSqlIn("-- a header\nCREATE FUNCTION f() RETURNS void LANGUAGE plpgsql AS $$\nBEGIN\n  -- TRUNCATE in prose\n  TRUNCATE thoughts;\nEND;\n$$;\n");
  if (lined.map((h) => `${h.rule}@${h.line}`).join(",") !== "truncate@5") fail(SELF, `check 21 reports ${JSON.stringify(lined.map((h) => `${h.rule}@${h.line}`))} for a TRUNCATE on line 5 of a function body, expected ["truncate@5"] (its own probe)`);

  const counts = new Map<string, number>();
  // The files git tracks or would track, as check 15 reads them — so an ignored
  // .sql (the Supabase CLI's supabase/migrations, a recipe's data/) is not the
  // tree's, as .gitignore promises of this script (first review pass; the walk
  // read the disk). citationFiles skips a file over 4 MB; no .sql is near it.
  const files = citationFiles().filter((rel) => rel.endsWith(".sql"));
  if (files.length === 0) fail(SELF, "check 21 found no .sql file in the tree — the listing or its filter is broken, and the rule would pass everything");
  for (const rel of files) {
    for (const h of destructiveSqlIn(readFileSync(join(ROOT, rel), "utf8"))) {
      const key = `${rel} ${h.rule}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
      if (DESTRUCTIVE_SQL_EXCEPTIONS.get(rel)?.[h.rule]) continue;
      fail(`${rel}:${h.line}`, `${h.msg} (SMD-1936)`);
    }
  }
  for (const [rel, byRule] of DESTRUCTIVE_SQL_EXCEPTIONS) {
    for (const [rule, { why, lines }] of Object.entries(byRule)) {
      const seen = counts.get(`${rel} ${rule}`) ?? 0;
      if (seen !== lines) {
        fail(rel, seen === 0
          ? `listed as a destructive-SQL exception for '${rule}' (${why}) but matches nothing — remove it from DESTRUCTIVE_SQL_EXCEPTIONS`
          : `destructive-SQL exception for '${rule}' (${why}) covers ${lines} line(s) but ${seen} match — a new statement beside the documented one, or the exception's count is stale`);
      }
    }
  }
}
checkDestructiveSql();

// ── 22: no vendored file imports @supabase/supabase-js at runtime ────────────
//
// SMD-1798 (the third of SMD-1795's seven). Every vendored MCP server, API,
// worker and script reaches the brain through compat/supabase-sql — Bun's
// Postgres client in supabase-js's shape — so running any of them needs no
// Supabase project, PostgREST or service key; supabase-js stays in the tree as
// the parity oracle compat/supabase-sql/test-compat.ts measures the shim
// against (extensions/package.json installs it for that) and in
// server-portable/store-postgrest.ts for the Cloudflare Workers target
// (SMD-1847), both outside this scan. This is what keeps the next rebase, or
// the next vendored file, from bringing a PostgREST client back: a
// specifier-shaped string naming the package — "@supabase/supabase-js",
// "npm:@supabase/supabase-js@2", "jsr:@supabase/supabase-js@2",
// "https://esm.sh/@supabase/supabase-js@2", with or without a subpath — in any
// code file (.ts, .tsx, .js, .mjs, .cjs, .svelte, .vue) under the seven
// category directories and docs/, comments blanked (the codemod's
// `// ob1-original-import:` record is a comment; a README's sample is prose,
// SMD-1802's), is a hit, whatever statement holds it: an import, a type-only
// import, a require, a dynamic import. Counted per-file exceptions, as check 7
// counts them: the one client the codemod's KEEP list holds on supabase-js
// (local-brain-no-mcp's, which runs inside that recipe's own Supabase stack —
// SMD-1800 decides the recipe) and the dashboard's type-only import
// (SMD-1801's). Every other vendored client moved: 26 files in change 74, six
// servers here.
const SUPABASE_JS_SPECIFIER = /(["'])(?:npm:|jsr:|https:\/\/esm\.sh\/)?@supabase\/supabase-js(?:@[^"'/]*)?(?:\/[^"']*)?\1/g;
const CODE_FILE = /\.(ts|tsx|js|mjs|cjs|svelte|vue)$/;
/** [text, whether it is a hit] — the forms the tree has had, and the neighbours the rule must not reach. */
const SUPABASE_JS_PROBES: [string, boolean][] = [
  ['import { createClient } from "@supabase/supabase-js";', true],
  ["import { createClient } from 'npm:@supabase/supabase-js@2';", true],
  ['import { createClient } from "jsr:@supabase/supabase-js@2";', true],
  ['import { createClient } from "https://esm.sh/@supabase/supabase-js@2.47.10";', true],
  ['import type { Session, User } from "@supabase/supabase-js";', true],
  ['const { createClient } = require("@supabase/supabase-js");', true],
  ['const m = await import("@supabase/supabase-js/dist/module/index.js");', true],
  ['import { createClient } from "../../compat/supabase-sql/index.ts";', false],
  ['// ob1-original-import: @supabase/supabase-js\nimport { createClient } from "../../compat/supabase-sql/index.ts";', false],
  ['import "jsr:@supabase/functions-js/edge-runtime.d.ts";', false],
  ['/* import { createClient } from "@supabase/supabase-js"; */\nconst x = 1;', false],
  ['const note = "the file imports @supabase/supabase-js at runtime";', false],
  ['import { createClient } from "@supabase/supabase-js-shaped/thing";', false],
];
/** file → rule → the reason and the exact hit count; a hit past the count fails, a count no hit reaches fails as stale. */
const SUPABASE_JS_EXCEPTIONS = new Map<string, Record<string, CountedException>>([
  ["recipes/local-brain-no-mcp/functions/_shared/db.ts", { "supabase-js": { why: "runs inside the recipe's own self-hosted Supabase stack, where PostgREST is present and bun is not — the codemod's KEEP list; SMD-1800 decides the recipe", lines: 1 } }],
  ["dashboards/open-brain-dashboard/src/app.d.ts", { "supabase-js": { why: "the dashboard's type-only import: the one client left that reads the brain over PostgREST — SMD-1801 moves it onto the fork's REST API", lines: 1 } }],
]);
/** The 1-based lines of `text` (comments blanked) holding a supabase-js specifier, ascending. */
function supabaseJsImportsIn(text: string): number[] {
  const code = blanked(text, false);
  const lineOf = lineIndexer(code);
  const lines = new Set<number>();
  for (const m of code.matchAll(SUPABASE_JS_SPECIFIER)) lines.add(lineOf(m.index!));
  return [...lines].sort((a, b) => a - b);
}
function checkSupabaseJsImports() {
  for (const [probe, hit] of SUPABASE_JS_PROBES) {
    const n = supabaseJsImportsIn(probe).length;
    if (hit && n === 0) fail(SELF, `check 22 no longer catches its probe: ${JSON.stringify(probe)} (its own probe)`);
    if (!hit && n > 0) fail(SELF, `check 22 catches a non-probe: ${JSON.stringify(probe)} (its own probe)`);
  }
  const files = textFilesUnder(SCANNED_ROOTS).filter((f) => CODE_FILE.test(f));
  if (files.length === 0) fail(SELF, "check 22 found no code file under the seven category directories and docs/ — the listing is broken, not the tree clean");
  const seen = new Set<string>();
  for (const file of files) {
    const rel = relOf(file);
    const lines = supabaseJsImportsIn(readFileSync(file, "utf8"));
    const excepted = SUPABASE_JS_EXCEPTIONS.get(rel)?.["supabase-js"];
    if (excepted) {
      seen.add(rel);
      if (lines.length !== excepted.lines) fail(rel, `check 22's exception covers ${excepted.lines} line(s) of a supabase-js import and the file has ${lines.length} — ${lines.length > excepted.lines ? "a new import, or a moved one" : "the exception is stale"} (${excepted.why})`);
      continue;
    }
    for (const line of lines) {
      fail(`${rel}:${line}`, `imports @supabase/supabase-js at runtime — every vendored server reaches the brain through compat/supabase-sql since SMD-1798 (\`bun scripts/migrate-to-sql-shim.ts --apply ${rel}\`; the shim's README says what it still refuses); supabase-js stays only as the parity oracle in compat/ and extensions/package.json, and in server-portable's Workers store`);
    }
  }
  for (const rel of SUPABASE_JS_EXCEPTIONS.keys()) if (!seen.has(rel)) fail(rel, "check 22's exception names a file the scan does not reach — stale, or the file is gone");
}
checkSupabaseJsImports();

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
