#!/usr/bin/env bun
/**
 * install-hooks.mjs — opt in to the local commit-message check (SMD-1808).
 *
 *   bun scripts/install-hooks.mjs             # git config core.hooksPath = scripts/hooks
 *   bun scripts/install-hooks.mjs --uninstall # unset it
 *
 * No husky, no lefthook, no dependency: it sets one git config value so the
 * committed scripts/hooks/commit-msg runs. Nothing runs unless you install it,
 * and it is per-checkout (git config is local), so it never affects anyone else.
 */

import { execFileSync } from "node:child_process";

const HOOKS_PATH = "scripts/hooks";
const run = (args) => execFileSync("git", args, { encoding: "utf8" }).trim();

if (process.argv.includes("--uninstall")) {
  const current = (() => {
    try { return run(["config", "--local", "--get", "core.hooksPath"]); } catch { return ""; }
  })();
  if (current !== HOOKS_PATH) {
    console.log(current ? `core.hooksPath is "${current}", not ${HOOKS_PATH} — leaving it as it is.` : "core.hooksPath is not set — nothing to remove.");
  } else {
    run(["config", "--local", "--unset", "core.hooksPath"]);
    console.log("Removed core.hooksPath — the local commit-msg check is off.");
  }
} else {
  run(["config", "--local", "core.hooksPath", HOOKS_PATH]);
  console.log(`Set core.hooksPath = ${HOOKS_PATH}. Commit messages are now checked by scripts/commitlint.config.mjs before a commit is written.`);
  console.log("Undo with: bun scripts/install-hooks.mjs --uninstall");
}
