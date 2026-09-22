/**
 * contributions.ts — the one walk of the contribution directories.
 *
 * check-fork-consistency.ts walks the seven categories for every check, and
 * connector-registry.ts walks them for the coverage sweep and its CLI; one
 * definition of "what is a contribution" keeps the two from disagreeing about a
 * directory (SMD-1933, review pass 2). Plain fs, no Bun API.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export const CATEGORIES = [
  "recipes",
  "schemas",
  "dashboards",
  "integrations",
  "skills",
  "primitives",
  "extensions",
];

/**
 * The directory names under a category that are not contributions: _template
 * is the category's placeholder, _shared the auth module the category's servers
 * import (a copy of server-portable/auth.ts), node_modules
 * extensions/test-auth.ts's install (gitignored).
 */
export const NOT_CONTRIBUTIONS = ["_template", "_shared", "node_modules"];

/** One contribution directory: its category, folder name, absolute path and repo-relative path. */
export type ContribDir = { cat: string; name: string; dir: string; rel: string };

/**
 * Every contribution directory under `root`, as `{ cat, name, dir, rel }`,
 * categories and names sorted — any directory but NOT_CONTRIBUTIONS, with or
 * without a metadata.json (check 1 is what fails a missing one).
 */
export function contributionDirs(root: string): ContribDir[] {
  const out: ContribDir[] = [];
  for (const cat of CATEGORIES) {
    const base = join(root, cat);
    if (!existsSync(base)) continue;
    for (const name of readdirSync(base).sort()) {
      if (NOT_CONTRIBUTIONS.includes(name)) continue;
      const dir = join(base, name);
      if (statSync(dir).isDirectory()) out.push({ cat, name, dir, rel: `${cat}/${name}` });
    }
  }
  return out;
}
