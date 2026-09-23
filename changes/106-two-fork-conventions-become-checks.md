# 106. Two fork conventions become checks — the commit grammar and the CI workflow (SMD-1808)

Two conventions were enforced by memory and review, not by anything that runs: the
commit grammar SMD-1711 introduced (`[fork]`/`[category]` header ending in
`(SMD-NNNN)`, and a `(caught: …)` tag on each review-pass finding bullet, which
`scripts/mechanism-yield.mjs` counts yield with), and the CI workflow itself —
`.github/workflows/fork-checks.yml`, 56 `run:` steps under `bash -e` with no
`pipefail`, never linted, and about to become a merge queue's gate (SMD-1805).

**commitlint, the house grammar not Conventional Commits.** SMD-1804 declined
Conventional Commits; commitlint is the tool, not the grammar, so a custom
`parserPreset` enforces this one. `scripts/commitlint.config.mjs` (run via
`bunx @commitlint/cli@19.6.1`, no root `package.json`): the ten-category
`headerPattern`, `type-enum`/`type-empty` at error, and two custom warn rules —
`ticket-ref` (a `[fork]` subject ends in its ticket) and `caught-tag` (every
finding bullet of a review-pass body carries a tag). No length cap: subjects run
to ~1,169 characters by design, and a cap would fail the record. The tag and
review-pass grammar is extracted to `scripts/commit-grammar.mjs` and imported by
both the config and `mechanism-yield.mjs`, so the check and the yield count cannot
disagree — the rule the fork already applies to SQL: one definition, called by
each user. The job `commit-lint` lints a PR's own commits (merge commits ignored);
`scripts/hooks/commit-msg` + `bun scripts/install-hooks.mjs` run the same config
locally, opt-in, no husky.

**actionlint + shellcheck.** The `workflow-lint` job runs `actionlint` (pinned by
version and sha256) with the runner's `shellcheck` over every `run:` body; the one
finding (SC2013, a `for … in $(grep …)` that word-split filenames) is fixed with a
`while read` loop, so the file lints clean with no suppressions. `fork-checks.yml`
now sets `defaults.run.shell: bash`, giving every step `-eo pipefail`, so a masked
`cmd | grep`/`cmd | jq` left-side failure is surfaced — the three `docker compose
config | jq -e` gates and the migrated-files loop were re-read and want it.

Making the two jobs *required* waits on SMD-1805's branch-protection work; the
orphaned upstream workflows named in CLAUDE.md's Key Files are SMD-1802's. `[fork]`
prefix and `(caught: …)` tags stay; SMD-1804's "Conventional Commits declined"
note stands.
