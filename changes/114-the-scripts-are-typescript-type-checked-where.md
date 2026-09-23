# 114. The scripts are TypeScript, type-checked where they run — `scripts/*.mjs` become `scripts/*.ts` with a tsconfig and pins mirroring the server's, a typecheck step in the repo-consistency job, check 18 holding five directories, and the "node runs it too" claim gone (SMD-1870)

**What changed.** The thirteen files under `scripts/` — the consistency checker,
the release assembler, the index renderer, the fragment reader, the commit
grammar and its commitlint config, the review-yield report, the shim codemod,
the tools generator, the hook installer, the README updater, and the connector
registry and contribution walk SMD-1933 landed while this was in review — are
`.ts`, renamed with `git mv` and typed in place: parameter and return types, a
record type where an object was built as `{}` and filled, tuple types on the
probe tables, `unknown` narrowed where a value is read from JSON or YAML. No
`@ts-ignore`, no `any` on a parameter, and no behaviour change: every script's
output on the renamed tree is byte-identical to its output on the `.mjs` tree
(the checker's PASS, the yield report over the whole log and a window, both
self-checks, the assembler's dry run, the codemod's triage, commitlint over a
range). `scripts/tsconfig.json` is `db/tsconfig.json` byte for byte;
`scripts/package.json` pins `@types/bun` 1.4.0, `typescript` 5.9.3 and
`@types/node` 26.6.2 — types only, the scripts have no packages — and check 18's
`TYPECHECKED_DIRS` names `scripts` as its fifth directory. Two steps in
`.github/workflows/fork-checks.yml`'s repo-consistency job, after the checker
runs: `bun install --frozen-lockfile` and `bunx tsc --noEmit` in `scripts/`,
there because that job is where the scripts run and nothing they import needs an
install beyond the types (`../db/config.mjs` and `../db/version.mjs` through
their `.d.mts`, `../server-portable/tools.ts` directly). The codemod's banner
says `bun scripts/migrate-to-sql-shim.ts`, and the 23 migrated files were
rewritten through the codemod itself — `--revert`, then `--apply --all`, the
round trip CI runs — so the step stays clean. `scripts/fragments.d.mts` and
`scripts/fork-index.d.mts` are gone: a `.ts` is its own declaration, and
`db/ingest-records.ts` imports the `.ts` files. The six node shebangs are bun's;
the "node runs it too" sentences in the checker's, `fork-index`'s, `fragments`'
and the codemod's headers, the registry's run line and the walk's sentence,
FORK.md's run line and the workflow's comment are gone — the scripts are Bun
scripts. `db/ci-parity.sh` runs the fifth typecheck after the four; the two
sentences that counted "four type-checked directories" (`evals/README.md`,
`db/README.md`) stop counting, and `db/README.md`'s `.d.mts` rule names the two
declaration files that remain. Everything else that named a `scripts/*.mjs`
follows — `changes/README.md`, the live how-to for a fragment, included; the
numbered records and the earlier fragments keep theirs: FORK.md's ledger and its
index marker (the marker text is `fork-index`'s `START` constant, so the two
moved together — as the spec's `connector-tables` marker moved with the
registry's), the registry JSON's comment, `CONTRIBUTING.md`, `SETUP.md`, the
READMEs, `.gitignore`'s comment, `extensions/test-writes.ts`'s existence assert,
the vendored files' "check 10 holds it" comments, `tools.ts`'s note and the
regenerated `tools.json`.

**Why.** Everything else Bun runs in this fork is TypeScript and type-checked —
`server-portable/` and `compat/supabase-sql/` since their jobs existed, `db/`
and `evals/` since SMD-1932 — and `scripts/` was the one directory left as
JavaScript with no compiler over it: 6,377 lines (thirteen files once SMD-1933
landed) that import `db/config.mjs`, `db/version.mjs` and each other by hand,
where a moved signature would be found by the next run. The headers said "plain
ESM; node runs it too", and it did not: CI runs them under bun, node is not
installed on the maintainer's machine (SMD-1844's second review pass tried), and
checks 13 and 14 parse YAML with `Bun.YAML`. Raised by the maintainer on PR #90
as "dotenv and TypeScript instead of .mjs"; the dotenv half was declined there
(check 13 reads the *commented-out* knob lines, which a dotenv parser discards).
What types would not have bought: none of SMD-1844's defects were type-shaped —
regex semantics, an indentation walk, a parser's merge precedence — and
`Bun.YAML.parse` still answers `unknown`, so the runtime narrowing stays. The
gain is one shape across the tree, a checked import surface, and an honest
header.

**Held.** The step: a deliberate type error in a script fails `bunx tsc
--noEmit` in `scripts/` and nothing else does; restored, the five directories
exit 0. Check 18 on the real tree: a drifted `scripts/` pin, a drifted
`compilerOption` and a missing `scripts/` tsc step each fail by name — the same
pure function SMD-1932 shipped, one more directory in its list. The checker
still bites as a `.ts`: check 13's `network_mode: host` and a published
`0.0.0.0` port, check 14's dropped forward and check 18's drifted pin each fail
with the message `main`'s `.mjs` gives on the same mutant, compared line for
line (the two differences: the checker's own path, and check 18 saying "every
type-checked directory" where it counted four). commitlint loads the `.ts`
config under `bunx --bun` (probed before the rename); the flag because `bunx`
otherwise honours the CLI's node shebang where node exists, as on the runner and
not on this machine.

**Caught by the pass.** Two defects, each its own commit tagged `(caught:
automated)`, as the ticket asked. Typing `assemble-release`'s front matter
honestly (`migrations?: string | string[]`) showed check 16 read a scalar
`migrations: 045` as no migrations: the fragment passed, its patch-bump rule
never saw the migration, and the cut then walked the string's characters and
refused "migration 000 … an earlier release froze it". `fragmentProblems` now
refuses the scalar and says how to write it; a probe holds it. And the one error
the checker's pass left standing — `vm` possibly null in
`releasedChangelogTickets` — was a crash: a `## [` heading with no `]` (already
check 17a's finding) made check 17b's reader throw a TypeError, so the run ended
in a stack trace with every accumulated violation unprinted; on the mutant,
`main`'s checker dies with `null is not an object (evaluating 'vm[1]')` and this
one ends in the FAIL report naming CHANGELOG.md. The reader skips the heading,
as `changelogProblems` did ten lines above; a probe holds it. One declaration
gap beside the two: `db/config.mjs` exported `grantRows()` (SMD-1471) and
`db/config.d.mts` did not declare it, so the checker's import saw no such
member; declared now.

**Review passes.** A cold read beside an independent reviewer each pass. The
code half held — every delta in the emitted JavaScript between the `.mjs` and
the `.ts` was an import path, one of the two declared fixes, or an equivalent
coercion — and the record half did not; the second and third passes' top
findings were against the pass before's additions, the stop signal, and were
fixed.

| Pass | Finding | Caught | Fix |
| --- | --- | --- | --- |
| 1 | `changes/README.md`, the live how-to, still ran `bun scripts/assemble-release.mjs` and named four more `.mjs`; the sweep had excluded `changes/` whole | cold read | five references renamed; the record says what was swept |
| 1 | "the 44 migrated files" — 23 carry the banner; the rest of the vendored edits were comments and README notes naming the checker or the codemod | run-it | 23 |
| 1 | "the two node shebangs" — five | run-it | five |
| 1 | the runner has node, so `bunx` would run commitlint under it and load the `.ts` config through a loader the probe never ran | walkthrough | `bunx --bun` in the workflow, the hook and the config's header |
| 1 | "86 numbered files and 7 fragments name a `scripts/*.mjs`" — 24 and 3 do; "5,750 lines" — 5,647 | cold read | the counts |
| 1 | two line-number citations in `docs/vendored-disposition.md`, stale before, re-pointed at the new name as if fresh | cold read | cite the rule, not the line |
| 2 | the rule the first pass cited for telegram-capture's README was wrong: it is one of check 10's probe fixtures, not a counted exception (the README writes through `update_thought`); the row's other line cite was stale too | cold read | the probe table named; the suite's section named |
| 2 | the checker's `Metadata` comment said a scalar `requires_primitives` is check 1's finding; check 1 never reads that field, so the scalar reaches check 4, which walks its characters | cold read | the comment says so |
| 2 | "the other 21 edits were the check-10 comments" — README notes as well as comments, naming the codemod as well as the checker | run-it | the row |
| 2 | a scalar `tickets:` got "must list at least one" and a changelog mismatch, never the word scalar; the migrations message's example degenerated on `""` | run-it | the same scalar rule for `tickets:`; a fixed example |
| 2 | the 17b probe did not fail by name on the drop-the-guard mutant — the TypeError escaped it — and its message described a failure the regex cannot produce | mutant | the call caught; the message says throws-or-reads |
| 3 | the second pass counted the other vendored edits at 22; the tree says 26, of which 11 name the codemod and 15 the checker — the third count for one clause | run-it | no count: "the rest" |
| 3 | "check 1 types no field" — it types `tags` and `requires.open_brain`; what holds is that it never reads `requires_primitives` | cold read | the comment and the row say that |
| 3 | `db/ci-parity.sh`'s fifth typecheck and the two READMEs' "four directories" edits were changes the record's sweep sentence did not cover | cold read | a clause in What changed |
| 3 | `main` moved under the branch (SMD-1490's fragment); the index line conflicts once, as Not taken predicts, and the "7 earlier fragments" would be 8 | walkthrough | the count dropped; the merge at the maintainer's word |
| 4 | the merge, read by diff-of-diffs and the CI steps rerun: content preserved, both-sides files coherent, all green; FORK.md's ledger column had lost a space on the four padded renamed entries | cold read | one space each |
| 5 | the second merge (SMD-1933's check 19 and two scripts) held by diff-of-diffs and identical emit; the record lagged the arrivals — six shebangs not five, four fragments not three, 6,377 lines, and the registry's run line, the walk's sentence and the spec's marker unnamed | cold read | the counts and the clauses |

**Not taken.** `allowJs`/`checkJs` over the `.mjs` files instead of a rename:
under the shared strictness the errors are the same ones, the compiler options
would differ from the reference's (check 18 refuses that), and the files would
stay the tree's odd ones out. Renaming `db/config.mjs` and `db/version.mjs`: the
Deno and Workers server bundles import `config.mjs`, and their fate is
SMD-1795's. Removing `update-readme-contributions.ts`, which no fork workflow
runs (upstream's daily README job): a rename is not the place — it is its own
question under the no-parity posture. Rewriting the records under `changes/` (24
of the 86 numbered files and 4 of the earlier fragments name a `scripts/*.mjs`):
they are the record of what shipped. A path-free index marker — the rename moved
FORK.md's marker line, which is `fork-index`'s `START` constant, so a branch in
flight over the index region conflicts once — is a change for the next rename,
not this one.

**Upstream status:** not sent — upstream has no `scripts/` directory of this
shape and runs no typecheck.
