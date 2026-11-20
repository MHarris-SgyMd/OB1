/**
 * fixture-git.ts — the git the runner's self-checks build their clone fixtures with (SMD-4325: four checks each
 * carried a copy). On macOS the active developer git, past Apple's /usr/bin/git shim, as probes.ts's developerGit
 * finds it; on Linux (CI), where there is no xcode-select to ask, plain `git` from PATH.
 */
import { developerGit } from "./probes.ts";

export function fixtureGit(): string {
  try {
    return developerGit() ?? "git";
  } catch {
    // No xcode-select (Linux): fall back to PATH git.
    return "git";
  }
}
