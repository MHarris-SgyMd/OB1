/**
 * commitlint.config.ts — enforce the project's commit grammar (SMD-1808).
 *
 * NOT config-conventional: SMD-1804 declined Conventional Commits because the
 * house grammar is readable and the release fragment's type/bump fields feed
 * tooling. commitlint is the tool, not the grammar — a custom parserPreset makes
 * it enforce THIS grammar:
 *   [<category>] <subject>            where <category> is CLAUDE.md's PR set + core/docs/resources
 *   a [core] subject ends in (SMD-NNNN)                       — ticket-ref, warn
 * `[core]` is a change to the project's own code (SMD-3765). `[fork]`, its name
 * before, is still accepted and held to the same rule, so a branch begun before
 * the rename lints as it did; new commits say `[core]`.
 *   every finding bullet of a review-pass body carries (caught: …)  — caught-tag, warn
 * No length cap: subjects run to ~1,169 characters by design (they are sentences),
 * and a cap would fail the record. The rule is SHAPE, not length.
 *
 * The tag and review-pass grammar is imported from commit-grammar.ts — the same
 * definition scripts/mechanism-yield.ts counts yield with, so the two cannot
 * disagree (the Verify: they report the same tagged count for a range).
 *
 * Run (no root package.json; the project pins by exact version; --bun because
 * bunx otherwise honours the CLI's node shebang where node exists, and this
 * config is a .ts loaded under bun — SMD-1870):
 *   bunx --bun @commitlint/cli@19.6.1 --config scripts/commitlint.config.ts --from <base> --to <head>
 *   bunx --bun @commitlint/cli@19.6.1 --config scripts/commitlint.config.ts --edit <file>   (the hook)
 * Merge commits are commitlint's default ignore, so "Merge origin/main …" and
 * "Merge pull request …" are skipped.
 */

import { isReviewPass, bulletsOf, readTag } from "./commit-grammar.ts";

/** CLAUDE.md's contribution categories less plugins, plus the project's own `core`, `docs`, `resources` — and `fork`, `core`'s name before SMD-3765. */
const CATEGORIES = ["core", "fork", "extensions", "primitives", "recipes", "schemas", "integrations", "skills", "docs", "resources"];
/** The categories that are the project's own code, held to ticket-ref. */
const OWN = new Set(["core", "fork"]);

export default {
  parserPreset: {
    parserOpts: {
      // Built from CATEGORIES so the header regex and type-enum share one list.
      headerPattern: new RegExp(`^\\[(${CATEGORIES.join("|")})\\] (.+)$`),
      headerCorrespondence: ["type", "subject"],
    },
  },
  plugins: [
    {
      rules: {
        // A [core] subject ends in its ticket. A category contribution (e.g.
        // [recipes] …) is a community PR that need not carry an SMD ticket.
        "ticket-ref": ({ type, header }: { type?: string | null; header?: string | null }) => {
          if (!OWN.has(type ?? "")) return [true];
          const ok = /\(SMD-\d+[^()]*\)\s*$/.test(header ?? "");
          return [ok, `a [${type}] subject should end in its ticket, (SMD-NNNN)`];
        },
        // Only a review-pass commit is held to the tag, and only its FINDING
        // bullets (bulletsOf drops run-results and "green"/"verified" bullets).
        // A pass whose finding is in the subject with no bullets passes. A tag
        // that is present but malformed still counts as carrying one — a warn
        // rule catches the missing tag, not a mechanism typo (readTag !== null).
        "caught-tag": ({ header, body }: { header?: string | null; body?: string | null }) => {
          // A review pass (REVIEW_RE), not merely a subject that names a "pass N"
          // — mechanism-yield gates its yield count the same way (SMD-1808).
          if (!isReviewPass(header ?? "")) return [true];
          const { findings } = bulletsOf(body ?? "");
          const untagged = findings.filter((f) => readTag(f) === null);
          const detail = untagged.map((f) => JSON.stringify(f.length > 50 ? f.slice(0, 50) + "…" : f)).join(", ");
          return [untagged.length === 0, `a review-pass finding bullet has no (caught: …) tag: ${detail}`];
        },
      },
    },
  ],
  rules: {
    "type-enum": [2, "always", CATEGORIES],
    "type-empty": [2, "never"],
    "ticket-ref": [1, "always"],
    "caught-tag": [1, "always"],
  },
};
