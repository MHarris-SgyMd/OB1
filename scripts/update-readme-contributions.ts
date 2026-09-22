#!/usr/bin/env bun

import { execFileSync } from "node:child_process";
import fs from "node:fs";

/** The fields this reads from GitHub's pull and pull-files payloads. */
type Pull = { number: number; title: string; html_url: string; merged_at: string | null; user: { login: string } };
type PullFile = { filename: string; additions?: number };

const README_PATH = new URL("../README.md", import.meta.url);
const START_MARKER = "<!-- recent-contributions:start -->";
const END_MARKER = "<!-- recent-contributions:end -->";
const DEFAULT_REPOSITORY = "NateBJones-Projects/OB1";
const repository = process.env.GITHUB_REPOSITORY || DEFAULT_REPOSITORY;
const [owner, repo] = repository.split("/");

if (!owner || !repo) {
  throw new Error(`Invalid repository value: ${repository}`);
}

const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || getGhToken();

async function github<T>(path: string): Promise<T> {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub API ${response.status} for ${path}: ${body.slice(0, 300)}`);
  }

  return (await response.json()) as T;
}

function getGhToken() {
  try {
    return execFileSync("gh", ["auth", "token"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

function rootForPath(filePath: string): string {
  const parts = filePath.split("/");
  const first = parts[0];

  if (
    ["dashboards", "extensions", "integrations", "primitives", "recipes", "schemas", "skills"].includes(first) &&
    parts.length >= 2
  ) {
    return `${parts[0]}/${parts[1]}/`;
  }

  if (first === "docs" && parts.length >= 2) return parts.slice(0, 2).join("/");
  if (first === "server") return "server/index.ts";
  return filePath;
}

function titleWords(title: string): string[] {
  return title
    .toLowerCase()
    .replace(/#[0-9]+/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((word) => word.length >= 3);
}

function chooseRepoTarget(pr: Pull, files: PullFile[]): string {
  const candidates = new Map<string, { root: string; additions: number; count: number; titleHits: number }>();
  const words = titleWords(pr.title);

  for (const file of files) {
    const root = rootForPath(file.filename);
    const current = candidates.get(root) || { root, additions: 0, count: 0, titleHits: 0 };
    current.additions += file.additions || 0;
    current.count += 1;
    const normalizedRoot = root.toLowerCase().replace(/[^a-z0-9]+/g, " ");
    current.titleHits += words.filter((word) => normalizedRoot.includes(word)).length;
    candidates.set(root, current);
  }

  const ranked = [...candidates.values()].sort((a, b) => {
    if (b.titleHits !== a.titleHits) return b.titleHits - a.titleHits;
    if (b.count !== a.count) return b.count - a.count;
    if (b.additions !== a.additions) return b.additions - a.additions;
    return a.root.localeCompare(b.root);
  });

  return ranked[0]?.root || pr.html_url;
}

function cleanTitle(title: string): string {
  const cleaned = title
    .replace(/^\s*((\[[^\]]+\])+\s*)+/g, "")
    .replace(/^docs:\s*/i, "")
    .replace(/^dashboards?\(next\):\s*/i, "")
    .trim();

  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

function descriptionFromTitle(title: string): string {
  const cleaned = cleanTitle(title)
    .replace(/^add\s+/i, "Adds ")
    .replace(/^fix\s+/i, "Fixes ")
    .replace(/^preserve\s+/i, "Preserves ")
    .replace(/^load\s+/i, "Loads ")
    .replace(/^return\s+/i, "Returns ")
    .replace(/^enable\s+/i, "Enables ")
    .replace(/^improve\s+/i, "Improves ")
    .replace(/^document\s+/i, "Documents ");

  const sentence = cleaned.endsWith(".") ? cleaned : `${cleaned}.`;
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

function profileLink(user: { login: string }): string {
  return `[@${user.login}](https://github.com/${user.login})`;
}

function repoLink(target: string): string {
  if (/^https?:\/\//.test(target)) return target;
  return target;
}

function buildSection(items: { title: string; target: string; user: { login: string } }[]): string {
  const generatedAt = new Date().toISOString().slice(0, 10);
  const lines = [
    "## Recent Contributions",
    "",
    `The 20 most recent merged PRs. This list is generated from GitHub and refreshes daily. Last updated: ${generatedAt}.`,
    "",
    START_MARKER,
    "",
    "| Contribution | What changed | Creator |",
    "| ------------ | ------------ | ------- |",
  ];

  for (const item of items) {
    lines.push(
      `| [${escapeTable(cleanTitle(item.title))}](${repoLink(item.target)}) | ${escapeTable(descriptionFromTitle(item.title))} | ${profileLink(item.user)} |`,
    );
  }

  lines.push("", END_MARKER);
  return lines.join("\n");
}

function escapeTable(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

async function main() {
  const pulls = await github<Pull[]>(`/repos/${owner}/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=100`);
  const merged = pulls
    .filter((pr) => pr.merged_at)
    .sort((a, b) => new Date(b.merged_at ?? 0).getTime() - new Date(a.merged_at ?? 0).getTime())
    .slice(0, 20);

  const items: { title: string; target: string; user: { login: string } }[] = [];
  for (const pr of merged) {
    const files = await github<PullFile[]>(`/repos/${owner}/${repo}/pulls/${pr.number}/files?per_page=100`);
    items.push({
      title: pr.title,
      target: chooseRepoTarget(pr, files),
      user: pr.user,
    });
  }

  const readme = fs.readFileSync(README_PATH, "utf8");
  const section = buildSection(items);
  const sectionPattern = new RegExp(`## Recent Contributions\\n[\\s\\S]*?${END_MARKER}`);

  let next: string;
  if (sectionPattern.test(readme)) {
    next = readme.replace(sectionPattern, section);
  } else {
    next = readme.replace(/\n## Extensions — The Learning Path\n/, `\n${section}\n\n## Extensions — The Learning Path\n`);
  }

  if (next === readme) {
    console.log("README recent contributions already up to date.");
    return;
  }

  fs.writeFileSync(README_PATH, next, "utf8");
  console.log("Updated README recent contributions.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
