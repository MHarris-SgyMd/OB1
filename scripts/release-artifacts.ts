#!/usr/bin/env bun
/**
 * release-artifacts.ts — what the release job reads and renders (SMD-1860).
 *
 * A release is cut on `main` by scripts/assemble-release.ts and named by a tag,
 * `v<MAJOR.MINOR.PATCH>`; .github/workflows/release.yml runs on that tag and
 * publishes the runnable half — the ob1-server and ob1-migrate images, a compose
 * overlay pinning them and Ollama by digest, the cut's change files and the
 * review yield as a GitHub release. This script is the job's reader and
 * renderer, so the workflow's bash carries no rule of its own:
 *
 *   facts    what this tag releases, checked against the tree — the tag names
 *            releases.json's last entry and FORK_VERSION equals it; the entry's
 *            range closes every migration on disk and no fragment sits in
 *            changes/ (nothing landed between the cut and the tag); the entry's
 *            change files exist; the tagged commit is on origin/main; Ollama is
 *            pinned to a tag in deploy/compose.yaml — written as key=value for
 *            GITHUB_OUTPUT, or refused with every problem named
 *   compose  the release's compose overlay: the two images by tag and digest,
 *            Ollama by the digest its pinned tag resolved to
 *   notes    the release notes: the CHANGELOG section, how to run it, the
 *            images with their digests, the change files, the yield table
 *
 * `--rehearsal` in place of `--tag` is the same run with nothing published: on a
 * pull request and on workflow_dispatch the job builds the images, renders the
 * overlay against them and brings the stack up from them, so the shape is
 * exercised before a tag ever is. The version is then FORK_VERSION and the
 * image tag `rehearsal`; the release checks that need a release are skipped.
 *
 *   bun scripts/release-artifacts.ts facts --tag v1.0.0 --out "$GITHUB_OUTPUT"
 *   bun scripts/release-artifacts.ts facts --rehearsal --out "$GITHUB_OUTPUT"
 *   bun scripts/release-artifacts.ts compose --tag v1.0.0 --ollama-digest sha256:… --server-digest sha256:… --migrate-digest sha256:…
 *   bun scripts/release-artifacts.ts notes --tag v1.0.0 --yield mechanism-yield.txt [--server-digest … --migrate-digest … --ollama-digest …]
 *   bun scripts/release-artifacts.ts --self-check
 *
 * Exit 0; 1 when facts finds a problem or a command's input is missing; 2 for
 * usage. The rules are pure functions over the tree's texts, probed by
 * --self-check, which the job runs first.
 */

import { existsSync, readFileSync, readdirSync, appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FORK_VERSION, UPSTREAM_PIN, readReleases, type Release } from "../db/version.mjs";
import { pad3, readChanges, type ClassifiedChanges } from "./fork-index.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const REPO_URL = "https://github.com/MHarris-SgyMd/OB1";
/** The images the job publishes, by their short names; the registry path comes from imageNames. */
export const IMAGES = ["server", "migrate"] as const;
export type ImageKind = (typeof IMAGES)[number];
/** Where each image builds from — the Dockerfile the job passes to buildx, context the repo root. */
export const DOCKERFILES: Record<ImageKind, string> = { server: "server-portable/Dockerfile", migrate: "db/Dockerfile" };
/** The tag the job runs on — `v` and the version's core, what CHANGELOG.md's compare links name. */
const TAG_RE = /^v(\d+\.\d+\.\d+)$/;
export const REHEARSAL_TAG = "rehearsal";

// ── Pure functions (self-checked) ────────────────────────────────────────────

/** The version's core, build metadata dropped: `1.0.0+upstream.abc` → `1.0.0`. */
export const coreOf = (version: string) => String(version).split("+")[0];
/** The tag a version is released under. */
export const tagFor = (version: string) => `v${coreOf(version)}`;
/** The two images' registry paths. GHCR wants the owner in lower case. */
export function imageNames(owner: string): Record<ImageKind, string> {
  const o = owner.toLowerCase();
  return { server: `ghcr.io/${o}/ob1-server`, migrate: `ghcr.io/${o}/ob1-migrate` };
}

/** The Ollama image deploy/compose.yaml pins — its one `x-ollama-image` anchor — or null when it is absent, not a string, or floating on `latest`. */
export function ollamaImageOf(composeText: string): string | null {
  let doc: unknown;
  try { doc = Bun.YAML.parse(composeText); } catch { return null; }
  const image = (doc as Record<string, unknown> | null)?.["x-ollama-image"];
  if (typeof image !== "string" || !/^ollama\/ollama:(?!latest$)[A-Za-z0-9._-]+$/.test(image)) return null;
  return image;
}

export type FactsInput = {
  mode: "tag" | "rehearsal";
  tag?: string;
  releases: Release[];
  forkVersion: string;
  /** Every db/migrations/NNN_*.sql number on disk. */
  migrationNumbers: number[];
  changes: Pick<ClassifiedChanges, "numbered" | "fragments">;
  composeText: string;
  owner: string;
  /** Whether HEAD is an ancestor of origin/main; null when that cannot be read. */
  headOnMain: boolean | null;
  head: string;
};
export type Facts = Record<string, string>;

/**
 * What the run releases, and everything wrong with releasing it. In `tag` mode
 * every rule applies; in `rehearsal` the tree is taken as it is and the version
 * is FORK_VERSION, the image tag `rehearsal`.
 */
export function releaseFacts(input: FactsInput): { problems: string[]; facts: Facts } {
  const problems: string[] = [];
  const names = imageNames(input.owner);
  const hi = input.migrationNumbers.length ? Math.max(...input.migrationNumbers) : 0;
  const last = input.releases[input.releases.length - 1];
  const previous = input.mode === "tag" ? input.releases[input.releases.length - 2] : last;
  let version = input.forkVersion;
  let imageTag = REHEARSAL_TAG;
  let range: [number, number] = [1, hi];
  let changeFiles: string[] = [];
  let date = "";
  let server = input.head.slice(0, 8);

  if (input.mode === "tag") {
    const tag = input.tag ?? "";
    const m = TAG_RE.exec(tag);
    if (!m) problems.push(`the tag ${JSON.stringify(tag)} is not v<MAJOR.MINOR.PATCH> — release.yml runs on the tags the cut names (CHANGELOG.md's compare links)`);
    if (!last) problems.push(`releases.json records no release — ${tag} names nothing; cut one first (scripts/assemble-release.ts)`);
    else {
      version = last.version;
      imageTag = coreOf(last.version);
      date = last.date;
      server = last.server;
      if (m && tagFor(last.version) !== tag) problems.push(`the tag is ${tag} but releases.json's last release is ${last.version} (tag ${tagFor(last.version)}) — a tag names the cut that is last in the manifest`);
      if (input.forkVersion !== last.version) problems.push(`db/version.mjs's FORK_VERSION is ${input.forkVersion} but the release is ${last.version} — the cut did not bump it (check-fork 17d holds it equal to the schema_version migration)`);
      if (!last.range) problems.push(`release ${last.version} closes no migration range — every cut ships its schema_version migration, so its range is never empty`);
      else {
        range = [last.range[0], last.range[1]];
        if (last.range[1] !== hi) problems.push(`release ${last.version} closes migrations ${pad3(last.range[0])}..${pad3(last.range[1])} but the tree's highest migration is ${pad3(hi)} — a migration landed after the cut; tag the cut's merge commit, or cut again`);
      }
      if (!last.changes) problems.push(`release ${last.version} records no change-file range (\`changes\`) — assemble-release.ts writes it since SMD-1860; cut again`);
      else {
        for (let n = last.changes[0]; n <= last.changes[1]; n++) {
          const file = input.changes.numbered.find((c) => c.n === n);
          if (file) changeFiles.push(file.name);
          else problems.push(`release ${last.version} numbered change ${n} but changes/ has no ${pad3(n)}-*.md`);
        }
      }
    }
    if (input.changes.fragments.length) problems.push(`changes/ still holds ${input.changes.fragments.map((f) => f.name).join(", ")} — a fragment landed after the cut, so this tree is not the release it names; tag the cut's merge commit, or cut again`);
    if (input.headOnMain === false) problems.push("the tagged commit is not on origin/main — a release is cut on main and tagged there");
    if (input.headOnMain === null) problems.push("cannot tell whether the tagged commit is on origin/main (no origin/main ref — a full checkout has one)");
  }
  const ollama = ollamaImageOf(input.composeText);
  if (!ollama) problems.push("deploy/compose.yaml does not pin Ollama — its `x-ollama-image` anchor must name `ollama/ollama:<tag>`, not `latest`, for the job to resolve a digest from");

  const core = coreOf(version);
  const facts: Facts = {
    mode: input.mode,
    version,
    core,
    tag: input.mode === "tag" ? tagFor(version) : REHEARSAL_TAG,
    image_tag: imageTag,
    server_image_name: names.server,
    migrate_image_name: names.migrate,
    server_image: `${names.server}:${imageTag}`,
    migrate_image: `${names.migrate}:${imageTag}`,
    server_dockerfile: DOCKERFILES.server,
    migrate_dockerfile: DOCKERFILES.migrate,
    range_lo: pad3(range[0]),
    range_hi: pad3(range[1]),
    ollama_image: ollama ?? "",
    previous_tag: previous ? tagFor(previous.version) : "",
    change_files: changeFiles.join(" "),
    date,
    server,
    upstream: UPSTREAM_PIN,
    // The row preflight prints for the brain this release's migrator wrote —
    // the job greps the server's log for it (the version 0NN wrote, the ledger's
    // highest migration). Anchored on both sides so 1.0.0 does not match 1.0.0-rc.
    preflight_row: `schema version +${version.replace(/[.+]/g, "\\$&")} · highest migration ${pad3(range[1])}\\b`,
  };
  return { problems, facts };
}

/** The OCI labels one image is built with, one `key=value` per line (docker/build-push-action's `labels:`). */
export function ociLabels(kind: ImageKind, f: { version: string; head: string; created: string }): string {
  const title = kind === "server" ? "ob1-server" : "ob1-migrate";
  const description = kind === "server"
    ? "Open Brain MCP server (server-portable) with its preflight gate — the OB1 fork, no Supabase"
    : "Open Brain schema migrator (db/migrate.ts and the migrations) — the OB1 fork";
  return [
    `org.opencontainers.image.title=${title}`,
    `org.opencontainers.image.description=${description}`,
    `org.opencontainers.image.version=${f.version}`,
    `org.opencontainers.image.revision=${f.head}`,
    `org.opencontainers.image.created=${f.created}`,
    `org.opencontainers.image.source=${REPO_URL}`,
    `org.opencontainers.image.url=${REPO_URL}/blob/main/deploy/README.md`,
    "org.opencontainers.image.licenses=FSL-1.1-MIT",
  ].join("\n");
}

export type OverlayInput = {
  version: string;
  tag: string;
  rendered: string;
  images: Record<ImageKind, { ref: string; digest?: string }>;
  ollamaImage: string;
  ollamaDigest: string;
};

/** `name:tag@sha256:…` when the digest is known, `name:tag` otherwise (a rehearsal's image was built, not pulled, and has no registry digest to resolve). */
const pinned = (ref: string, digest?: string) => (digest ? `${ref}@${digest}` : ref);

/**
 * The release's compose overlay: a second -f over compose.yaml from the same
 * tag, naming the published images by tag and digest and Ollama by the digest
 * its pinned tag resolved to at release time. compose.yaml's `build:` stays
 * under it and is used only when asked (`--build`); `pull` and `up` take the
 * images. Ollama is one anchor here as in compose.yaml.
 */
export function renderComposeOverlay(o: OverlayInput): string {
  const rehearsal = o.tag === REHEARSAL_TAG;
  const ollamaRef = `${o.ollamaImage.split(":")[0]}@${o.ollamaDigest}`;
  return [
    `# Open Brain — release ${o.version}${rehearsal ? " (REHEARSAL: images built here, not published)" : ` (tag ${o.tag})`}, rendered ${o.rendered} by`,
    "# .github/workflows/release.yml (SMD-1860). A second -f over compose.yaml from the",
    "# same tag: the images the release published, by tag and digest, and Ollama by",
    "# the digest its pinned tag resolved to at release time. compose.yaml's `build:`",
    "# stays under it and is used only when asked; `pull` and `up` take these.",
    "#",
    "#   docker compose -f compose.yaml -f compose.release.yaml pull",
    "#   docker compose -f compose.yaml -f compose.release.yaml up -d --wait",
    "#",
    "# Add `--profile local-models` to both for the stack's own Ollama. Secrets and",
    "# knobs come from deploy/.env as ever (copy .env.example). deploy/README.md,",
    '# "Pinning a release", has the rest.',
    "",
    `x-ollama-image: &ollama-image ${ollamaRef}  # ${o.ollamaImage} at release time`,
    "",
    "services:",
    "  server:",
    `    image: ${pinned(o.images.server.ref, o.images.server.digest)}`,
    "  migrate:",
    `    image: ${pinned(o.images.migrate.ref, o.images.migrate.digest)}`,
    "  ollama:",
    "    image: *ollama-image",
    "  ollama-pull:",
    "    image: *ollama-image",
    "",
  ].join("\n");
}

/** The body of CHANGELOG.md's `## [core] - date` section (heading excluded, the compare-link foot that follows the last section cut off), or null when there is none. */
export function changelogSectionFor(changelogText: string, core: string): string | null {
  for (const part of changelogText.split(/^## /m).slice(1)) {
    const title = part.split("\n", 1)[0].trim();
    if (!new RegExp(`^\\[${core.replace(/\./g, "\\.")}\\] - \\d{4}-\\d{2}-\\d{2}$`).test(title)) continue;
    const body = part.slice(part.indexOf("\n") + 1);
    const foot = /^\[[^\]]+\]:\s*\S+/m.exec(body); // the last section runs into the `[X.Y.Z]: url` links
    return (foot ? body.slice(0, foot.index) : body).trim();
  }
  return null;
}

export type NotesInput = {
  facts: Facts;
  changelogSection: string | null;
  digests: Partial<Record<ImageKind | "ollama", string>>;
  yieldText: string;
  yieldWindow: string;
};

/** The GitHub release's notes. */
export function renderNotes(n: NotesInput): string {
  const f = n.facts;
  const rehearsal = f.mode === "rehearsal";
  const names = { server: f.server_image, migrate: f.migrate_image };
  const download = (asset: string) => `${REPO_URL}/releases/download/${f.tag}/${asset}`;
  const lines: string[] = [];
  lines.push(`# Open Brain ${f.version}${rehearsal ? " — rehearsal" : ""}`, "");
  if (rehearsal) lines.push("_A rehearsal of the release job: the images below were built on the runner and never published, the overlay names them by tag alone, and nothing here is a release. The shape is what a tag's run does._", "");
  lines.push(`Migrations \`${f.range_lo}..${f.range_hi}\` · server \`${f.server}\` · upstream pin \`${f.upstream}\`${f.date ? ` · cut ${f.date}` : ""}`, "");
  lines.push("## Changes", "");
  lines.push(n.changelogSection ?? (rehearsal ? "_Nothing released yet — the fragments under `changes/` are what the next cut assembles._" : "_CHANGELOG.md has no section for this version._"), "");
  if (f.change_files) {
    lines.push("The record of each change, as this release numbered it:", "");
    for (const file of f.change_files.split(" ")) lines.push(`- [\`changes/${file}\`](${REPO_URL}/blob/${f.tag}/changes/${file})`);
    lines.push("");
  }
  lines.push("## Run it", "");
  lines.push("On a machine with Docker (or Podman) and nothing else:", "");
  lines.push("```bash");
  if (rehearsal) lines.push("# (a rehearsal publishes no assets — from a checkout at this commit, in deploy/)");
  else {
    lines.push(`curl -fsSLO ${download("compose.yaml")}`);
    lines.push(`curl -fsSLO ${download("compose.release.yaml")}`);
    lines.push(`curl -fsSL -o .env.example ${download("env.example")}`);
    lines.push("cp .env.example .env    # then set POSTGRES_PASSWORD, MCP_ACCESS_KEYS and a model provider");
  }
  lines.push("docker compose -f compose.yaml -f compose.release.yaml pull");
  lines.push("docker compose -f compose.yaml -f compose.release.yaml up -d --wait");
  lines.push("```", "");
  lines.push(`The server's log carries preflight's row for the brain this release's migrator wrote: \`schema version   ${f.version} · highest migration ${f.range_hi}\`. \`deploy/smoke.sh <url> <key>\` checks a running stack over MCP.`, "");
  lines.push("## Images", "");
  lines.push("| Image | Digest |", "| --- | --- |");
  for (const kind of IMAGES) lines.push(`| \`${names[kind]}\` | ${n.digests[kind] ? `\`${n.digests[kind]}\`` : rehearsal ? "_built, not published_" : "_unknown_"} |`);
  lines.push(`| \`${f.ollama_image}\` | ${n.digests.ollama ? `\`${n.digests.ollama}\`` : "_unresolved_"} |`, "");
  lines.push(`Both OB1 images are built from this tag's tree (\`${f.server_dockerfile}\`, \`${f.migrate_dockerfile}\`) for linux/amd64 and linux/arm64; the overlay pins each by digest, and Ollama by the digest its tag (\`${f.ollama_image}\`, deploy/compose.yaml) resolved to when the release ran.`, "");
  lines.push(`## What the review passes caught`, "");
  lines.push(`\`scripts/mechanism-yield.ts\`${n.yieldWindow ? ` ${n.yieldWindow}` : ""}: which mechanism — a cold read, running it, a mutant, a walkthrough, a gate — found each finding recorded in this window's review-pass commits.`, "");
  lines.push("<details><summary>The table</summary>", "", "```", n.yieldText.trimEnd(), "```", "", "</details>", "");
  return lines.join("\n");
}

/** `key=value` lines for GITHUB_OUTPUT; a value with a newline uses the delimiter form. */
export function githubOutput(facts: Facts): string {
  let out = "";
  for (const [k, v] of Object.entries(facts)) {
    if (v.includes("\n")) out += `${k}<<__OB1_EOF__\n${v}\n__OB1_EOF__\n`;
    else out += `${k}=${v}\n`;
  }
  return out;
}

// ── I/O ──────────────────────────────────────────────────────────────────────

function git(args: string[]): string | null {
  try { return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { return null; }
}

function readInput(mode: "tag" | "rehearsal", tag: string | undefined, owner: string): FactsInput {
  const migrationNumbers = readdirSync(join(ROOT, "db", "migrations")).filter((f) => /^\d{3}_.*\.sql$/.test(f)).map((f) => Number(f.slice(0, 3)));
  const head = git(["rev-parse", "HEAD"]) ?? "unknown";
  const onMain = git(["rev-parse", "--verify", "-q", "origin/main"]) === null ? null : git(["merge-base", "--is-ancestor", "HEAD", "origin/main"]) !== null;
  return {
    mode, tag, owner, head,
    releases: readReleases(),
    forkVersion: FORK_VERSION,
    migrationNumbers,
    changes: readChanges(ROOT),
    composeText: readFileSync(join(ROOT, "deploy", "compose.yaml"), "utf8"),
    headOnMain: onMain,
  };
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

function usage(): never {
  console.error("usage: bun scripts/release-artifacts.ts facts|compose|notes (--tag vX.Y.Z | --rehearsal) [--out FILE] [--owner OWNER] [--ollama-digest sha256:…] [--server-digest sha256:…] [--migrate-digest sha256:…] [--yield FILE]\n       bun scripts/release-artifacts.ts --self-check");
  process.exit(2);
}

// ── Self-check ───────────────────────────────────────────────────────────────

function selfCheck(): number {
  let bad = 0;
  const ok = (cond: boolean, label: string) => { if (!cond) { console.error(`FAIL ${label}`); bad++; } };
  const composeGood = "x-ollama-image: &o ollama/ollama:0.34.3\nservices:\n  ollama:\n    image: *o\n";
  const release: Release = { version: "1.0.0+upstream.9543c29", range: [1, 48], server: "abcdef12", upstream: "9543c29", date: "2026-09-30", tickets: ["SMD-1"], changes: [104, 105], frozenShas: {} };
  const numbered = (ns: number[]) => ns.map((n) => ({ name: `${pad3(n)}-x.md`, n, heading: { n, title: "x (SMD-1)" }, text: "", lines: 1 }));
  const base: FactsInput = { mode: "tag", tag: "v1.0.0", releases: [release], forkVersion: release.version, migrationNumbers: Array.from({ length: 48 }, (_, i) => i + 1), changes: { numbered: numbered([103, 104, 105]), fragments: [] }, composeText: composeGood, owner: "MHarris-SgyMd", headOnMain: true, head: "abcdef1234567890" };

  ok(coreOf("1.2.3+upstream.abc") === "1.2.3" && tagFor("1.2.3+upstream.abc") === "v1.2.3", "core and tag drop the build metadata");
  ok(imageNames("MHarris-SgyMd").server === "ghcr.io/mharris-sgymd/ob1-server" && imageNames("X").migrate === "ghcr.io/x/ob1-migrate", "image names lower-case the owner");
  ok(ollamaImageOf(composeGood) === "ollama/ollama:0.34.3", "the Ollama pin is read from the anchor");
  ok(ollamaImageOf("x-ollama-image: ollama/ollama:latest\n") === null && ollamaImageOf("services: {}\n") === null && ollamaImageOf(": :\n  - [") === null, "latest, no anchor and unparseable YAML are no pin");

  const good = releaseFacts(base);
  ok(good.problems.length === 0, `a matching tag, manifest, tree and pin release cleanly (${good.problems.join("; ")})`);
  ok(good.facts.version === release.version && good.facts.core === "1.0.0" && good.facts.tag === "v1.0.0" && good.facts.image_tag === "1.0.0" && good.facts.server_image === "ghcr.io/mharris-sgymd/ob1-server:1.0.0" && good.facts.range_hi === "048" && good.facts.change_files === "104-x.md 105-x.md" && good.facts.previous_tag === "" && good.facts.server === "abcdef12" && good.facts.date === "2026-09-30", "the facts: version, core, tag, image, range, change files, no previous release, the cut's server and date");
  ok(new RegExp(good.facts.preflight_row).test("  ✓  schema version            1.0.0+upstream.9543c29 · highest migration 048") && !new RegExp(good.facts.preflight_row).test("schema version   1.0.0+upstream.9543c29 · highest migration 0481"), "the preflight row pattern matches the row and not a longer number");
  const mutants: [Partial<FactsInput>, string, string][] = [
    [{ tag: "1.0.0" }, "not v<MAJOR.MINOR.PATCH>", "a tag without the v"],
    [{ tag: "v1.1.0" }, "last release is 1.0.0+upstream.9543c29", "a tag naming another version"],
    [{ releases: [] }, "records no release", "an empty manifest"],
    [{ forkVersion: "0.0.0+upstream.9543c29" }, "FORK_VERSION is 0.0.0", "FORK_VERSION not bumped"],
    [{ migrationNumbers: Array.from({ length: 49 }, (_, i) => i + 1) }, "highest migration is 049", "a migration past the range"],
    [{ changes: { numbered: numbered([103, 104, 105]), fragments: [{ name: "smd-9.md", ticket: "SMD-9", text: "", lines: 1 }] } }, "still holds smd-9.md", "a fragment left in changes/"],
    [{ changes: { numbered: numbered([103, 104]), fragments: [] } }, "no 105-*.md", "a numbered change file missing"],
    [{ releases: [{ ...release, changes: undefined }] }, "records no change-file range", "an entry without `changes`"],
    [{ releases: [{ ...release, range: null }] }, "closes no migration range", "an entry with no range"],
    [{ headOnMain: false }, "not on origin/main", "a tag off main"],
    [{ headOnMain: null }, "cannot tell", "no origin/main to compare with"],
    [{ composeText: "services: {}\n" }, "does not pin Ollama", "no Ollama pin"],
  ];
  for (const [over, phrase, why] of mutants) {
    const { problems } = releaseFacts({ ...base, ...over });
    ok(problems.length === 1 && problems[0].includes(phrase), `${why} is one problem naming it (${problems.join(" | ")})`);
  }
  const two = releaseFacts({ ...base, releases: [{ ...release, version: "0.9.0+upstream.9543c29", changes: [100, 103], range: [1, 44] }, release], changes: { numbered: numbered([100, 101, 102, 103, 104, 105]), fragments: [] } });
  ok(two.problems.length === 0 && two.facts.previous_tag === "v0.9.0", "the previous release's tag is the yield window's start");
  const rehearsal = releaseFacts({ ...base, mode: "rehearsal", tag: undefined, releases: [], forkVersion: "0.0.0+upstream.9543c29", migrationNumbers: Array.from({ length: 47 }, (_, i) => i + 1), changes: { numbered: numbered([103]), fragments: [{ name: "smd-9.md", ticket: "SMD-9", text: "", lines: 1 }] }, headOnMain: false });
  ok(rehearsal.problems.length === 0 && rehearsal.facts.version === "0.0.0+upstream.9543c29" && rehearsal.facts.tag === REHEARSAL_TAG && rehearsal.facts.image_tag === REHEARSAL_TAG && rehearsal.facts.range_lo === "001" && rehearsal.facts.range_hi === "047" && rehearsal.facts.change_files === "" && rehearsal.facts.previous_tag === "", "a rehearsal on an unreleased tree: FORK_VERSION, the rehearsal tag, the whole migration range, no release checks");
  ok(releaseFacts({ ...base, mode: "rehearsal", composeText: "services: {}\n" }).problems.length === 1, "a rehearsal still wants the Ollama pin");

  const overlay = renderComposeOverlay({ version: release.version, tag: "v1.0.0", rendered: "2026-09-30", images: { server: { ref: "ghcr.io/x/ob1-server:1.0.0", digest: "sha256:aa" }, migrate: { ref: "ghcr.io/x/ob1-migrate:1.0.0", digest: "sha256:bb" } }, ollamaImage: "ollama/ollama:0.34.3", ollamaDigest: "sha256:cc" });
  const parsed = Bun.YAML.parse(overlay) as { services: Record<string, { image: string }> };
  ok(parsed.services.server.image === "ghcr.io/x/ob1-server:1.0.0@sha256:aa" && parsed.services.migrate.image === "ghcr.io/x/ob1-migrate:1.0.0@sha256:bb", "the overlay pins the two images by tag and digest");
  ok(parsed.services.ollama.image === "ollama/ollama@sha256:cc" && parsed.services["ollama-pull"].image === "ollama/ollama@sha256:cc" && overlay.includes("ollama/ollama:0.34.3 at release time"), "Ollama is pinned by digest for both services, the tag it came from beside it");
  ok(overlay.startsWith("# Open Brain — release 1.0.0+upstream.9543c29 (tag v1.0.0)"), "the overlay's header names the release");
  const dry = renderComposeOverlay({ version: "0.0.0+upstream.x", tag: REHEARSAL_TAG, rendered: "d", images: { server: { ref: "s:rehearsal" }, migrate: { ref: "m:rehearsal" } }, ollamaImage: "ollama/ollama:1", ollamaDigest: "sha256:cc" });
  ok((Bun.YAML.parse(dry) as { services: Record<string, { image: string }> }).services.server.image === "s:rehearsal" && dry.includes("REHEARSAL"), "a rehearsal overlay names the images by tag alone and says so");

  const cl = "# Changelog\n\n## [Unreleased]\n\n_x_\n\n## [1.0.0] - 2026-09-30\n\n### Added\n- a thing (SMD-1)\n\n## [0.9.0] - 2026-09-01\n\n### Fixed\n- b\n\n[Unreleased]: u\n";
  ok(changelogSectionFor(cl, "1.0.0") === "### Added\n- a thing (SMD-1)" && changelogSectionFor(cl, "0.9.0") === "### Fixed\n- b" && changelogSectionFor(cl, "1.1.0") === null, "the changelog section for a version, and null for none");
  ok(changelogSectionFor("## [1.0.0] - 2026-09-30\n- x\n## [1.0.0-rc.1] - 2026-09-01\n- y\n", "1.0.0") === "- x", "1.0.0 does not read 1.0.0-rc.1's section");

  const notes = renderNotes({ facts: good.facts, changelogSection: "### Added\n- a thing (SMD-1)", digests: { server: "sha256:aa", migrate: "sha256:bb", ollama: "sha256:cc" }, yieldText: "== table ==\n", yieldWindow: "over the whole log" });
  ok(notes.includes("# Open Brain 1.0.0+upstream.9543c29\n") && notes.includes("- a thing (SMD-1)") && notes.includes("releases/download/v1.0.0/compose.release.yaml") && notes.includes("`ghcr.io/mharris-sgymd/ob1-server:1.0.0` | `sha256:aa`") && notes.includes("`ollama/ollama:0.34.3` | `sha256:cc`") && notes.includes("/blob/v1.0.0/changes/") && notes.includes("104-x.md") && notes.includes("== table ==") && notes.includes("highest migration 048"), "the notes carry the changelog, the download lines, the digests, the change files, the yield and the preflight row");
  const rn = renderNotes({ facts: rehearsal.facts, changelogSection: null, digests: {}, yieldText: "t", yieldWindow: "" });
  ok(rn.includes("— rehearsal") && rn.includes("_built, not published_") && !rn.includes("releases/download"), "rehearsal notes say what they are and offer no downloads");

  ok(githubOutput({ a: "1", b: "x\ny" }) === "a=1\nb<<__OB1_EOF__\nx\ny\n__OB1_EOF__\n", "GITHUB_OUTPUT lines, the delimiter form for a multi-line value");
  ok(ociLabels("server", { version: "1.0.0+upstream.x", head: "h", created: "c" }).split("\n").every((l) => /^org\.opencontainers\.image\.[a-z]+=.+$/.test(l)) && ociLabels("migrate", { version: "v", head: "h", created: "c" }).includes("title=ob1-migrate"), "OCI labels are key=value lines, the title per image");

  if (bad === 0) console.log("release-artifacts.ts self-check PASS");
  return bad === 0 ? 0 : 1;
}

// ── Entry ────────────────────────────────────────────────────────────────────

if (import.meta.main) {
  if (flag("self-check")) process.exit(selfCheck());
  const command = process.argv[2];
  if (!["facts", "compose", "notes"].includes(command ?? "")) usage();
  const rehearsal = flag("rehearsal");
  const tag = arg("tag");
  if (rehearsal === Boolean(tag)) usage(); // one of the two, not both, not neither
  const owner = arg("owner") ?? process.env.GITHUB_REPOSITORY_OWNER ?? "MHarris-SgyMd";
  const input = readInput(rehearsal ? "rehearsal" : "tag", tag, owner);
  const { problems, facts } = releaseFacts(input);
  if (problems.length) {
    console.error(`release-artifacts: ${rehearsal ? "this tree" : `${tag}`} cannot be released:\n`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  const digests = { server: arg("server-digest"), migrate: arg("migrate-digest"), ollama: arg("ollama-digest") };
  if (command === "facts") {
    const created = new Date().toISOString();
    for (const kind of IMAGES) facts[`${kind}_labels`] = ociLabels(kind, { version: facts.version, head: input.head, created });
    const text = githubOutput(facts);
    const out = arg("out");
    if (out) appendFileSync(out, text);
    process.stdout.write(text);
  } else if (command === "compose") {
    if (!digests.ollama) { console.error("compose needs --ollama-digest sha256:… (docker buildx imagetools inspect <image> --format '{{.Manifest.Digest}}')"); process.exit(1); }
    process.stdout.write(renderComposeOverlay({
      version: facts.version, tag: facts.tag, rendered: new Date().toISOString().slice(0, 10),
      images: { server: { ref: facts.server_image, digest: digests.server }, migrate: { ref: facts.migrate_image, digest: digests.migrate } },
      ollamaImage: facts.ollama_image, ollamaDigest: digests.ollama,
    }));
  } else {
    const yieldFile = arg("yield");
    if (!yieldFile || !existsSync(yieldFile)) { console.error("notes needs --yield <file> (scripts/mechanism-yield.ts's output)"); process.exit(1); }
    process.stdout.write(renderNotes({
      facts,
      changelogSection: changelogSectionFor(readFileSync(join(ROOT, "CHANGELOG.md"), "utf8"), facts.core),
      digests,
      yieldText: readFileSync(yieldFile, "utf8"),
      yieldWindow: facts.previous_tag ? `since ${facts.previous_tag}` : "over the whole log",
    }));
  }
}
