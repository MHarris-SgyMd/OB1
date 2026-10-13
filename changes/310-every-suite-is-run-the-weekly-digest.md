# 310. Every suite is run: the weekly digest's and the job registry's suites in CI, and check 34 holds every `test-*` script to a workflow step or a stated reason (SMD-2895)

**What changed.**
- **Two steps in `.github/workflows/fork-checks.yml`.**
  - "Weekly digest (no database)" runs `db/test-weekly-digest.ts` in the replay-gate job, beside the other db/ suites that need no database. Its 31 assertions cover the ranking, the Telegram chunking, the egress subject and gate, and `telegramEndpoint`, including SMD-2885's Basic from userinfo.
  - "Async job registry" runs `server-portable/test-jobs.ts` in the portable-server job, beside the server's other in-memory suites. Its 45 assertions cover the lifecycle, ownership, the SSE frames, retention, the cap and the durable sink through a fake (SMD-2273, SMD-2318).
- **Check 34** in `scripts/check-fork-consistency.ts`. Every `test-*` script git tracks or would track must be run by a step of fork-checks.yml, the workflow every pull request runs, or be named in `SUITES_NOT_RUN` with a reason.
  - A step runs a suite when its `run` calls `bun` or `node` on it. The path is resolved from the step's working-directory (or the job's, or the workflow's), and from any directory a `cd` in the same step names.
  - A run counts only if the suite's failure fails the job. So nothing counts from a step or job with `continue-on-error` (set to anything but `false`) or `if: false`, or from a command followed by `|| true` or `|| :`, with a continued line (`\` at its end) read as one.
  - A comment line runs nothing. A quoted string is read as nothing, so an echo that names `bun` on a suite does not run it. One consequence: a suite run only inside `sh -c "…"`, or only through `bun run` and a package script, reads as unrun, so the check fails loudly rather than passing a suite that never runs.
  - release.yml is not read. It runs on a tag, and on a pull request only when its own paths change.
  - The check also reports an entry in `SUITES_NOT_RUN` that a workflow runs, an entry that names no suite, and an entry with no reason. Each rule has an in-memory probe.
  - `eval-*` files are measurements, not suites, so the check skips them.
- **`SUITES_NOT_RUN`** names five files:
  - the two `test-support.ts` helper libraries;
  - `db/test-bench-reuse.ts`, three minutes of 150,000-row builds that `db/ci-parity.sh` already leaves out;
  - `recipes/atomizer/test-atomize.mjs`, which calls a live provider with the operator's key;
  - `recipes/authorship-edges/test-attribution.mjs`, an upstream recipe's self-test that its README runs by hand. Leaving it out was the maintainer's call; it passes its 21 assertions under Bun.
- **Records.** `server-portable/README.md`'s Expected outcome lists `test-jobs.ts` with its 45. `db/ci-parity.sh` runs it beside the server's other suites that need no database. The consistency step's name in fork-checks.yml mentions the new check.

**Why.** fork-checks.yml exists because upstream's suites ran in no workflow, and one asserted the opposite of production for months. The fork had done the same in small. `test-weekly-digest.ts` was found while SMD-2885 added an assertion to it. The census this ticket asked for found `test-jobs.ts`, unrun since it was written for SMD-2273 on 2026-09-27 and listed in no README. Both passed only when someone ran them by hand, and nothing would have caught a third.

**Held.**
- On the tree, before the steps were added, check 34 reported exactly the two unrun suites, and nothing else. After the steps were added: PASS.
- 16 mutants, all killed:
  - each of the reader's decisions dropped: the `cd` directories, the comment filter, the job's working-directory, the flag skip, the quote blanking, the `|| true` read, `continue-on-error`/`if: false` on a step and on a job, an expression `continue-on-error` read as false, and continued lines left unjoined;
  - each of the three reports dropped;
  - either new step removed;
  - an entry in `SUITES_NOT_RUN` renamed.
  
  The `cd` mutant also trips the check's own guard: it must read `server-portable/test-preflight.ts`, which CI runs through a `cd`, as run.
  
  No mutant covers reading fork-checks.yml alone. Reading every workflow changes nothing today, because release.yml runs no suite.
- Each suite also passes in a clean copy of the tree (`git archive`) with only its job's install, as the runner has it. Replay-gate installs db/ alone, and test-weekly-digest imports `server-portable/egress.ts` and `embed.ts`. Portable-server installs server-portable/ alone, and test-jobs imports `db/test-support.ts`.
- The ticket's Verify, locally: one assertion broken in each suite gives exit 1 (`30 passed, 1 failed`; test-jobs `FAIL`), so either step fails its job. Both suites pass under a bare environment (`env -i`, no `OB1_*`), as a runner gives them. `tsc` in scripts/ passes.

**Review passes.**

| Pass | Finding | Caught | Fix |
|---|---|---|---|
| 1 | An echo naming `bun` on a suite (`echo "bun x/test-a.ts failed"`) read as a run, so the record's "an echo runs nothing" was false and a suite could pass the check unrun | run-it | quoted strings blanked before reading, a probe each for an echo, a printf and `sh -c` |
| 1 | A suite in a step whose failure cannot fail the job — `continue-on-error`, `if: false`, `\|\| true` — counted as run, against the ticket's Verify that a broken assertion fails the job | run-it | none of the three counts, on a step or a job; probes, including `\|\| { …; exit 1; }` and a `;` that ends the swallow |
| 1 | release.yml counted: a suite only there would run on a tag, and on a pull request only when its paths change | cold read | only fork-checks.yml is read |
| 2 | A swallow on a continued line (`bun x/test-y.ts \` then `--flag \|\| true`) counted as a run | run-it | continued lines joined before reading; a probe |
| 2 | The record did not say that a suite run only through `bun run` and a package script reads as unrun | run-it | said in the check's comment and here; a probe holds it |
| 2 | Check 34's header entry left out the report of an entry with no reason. The consistency step's comment in fork-checks.yml named only five of the eleven checks that parse YAML | cold read | both corrected |
| 3 | The report for an unrun suite still said "no workflow step runs", though since pass 1 only fork-checks.yml is read and a run that cannot fail the job does not count; a suite run only in release.yml would have been told something false | cold read | the message names fork-checks.yml and the rule |
| boyscout | Check 34 spelled `{ path: string; where: string }` four times and left `SHELL_CD` without a comment. Replay-gate's last two steps, Board findings and the weekly digest, had no blank line between them, unlike every other step in that job. `server-portable/README.md`'s Expected outcome listed test-jobs but not test-thoughts (330), which CI runs in the same job | cold read | a `SuiteRun` type and the comment, the blank lines, and test-thoughts' line; no behaviour change |

**Not taken.**
- `db/ci-parity.sh`, which says it is CI's local equivalent, misses 14 of the `test-*` suites CI runs, `test-weekly-digest.ts` among them, and every `--self-check` step. Its tally parser also reads only the house `N assertions:` line. Only test-jobs was added, beside the server suites it already lists: SMD-2903.
- Unreferenced evals: `eval-propose-coverage`, `eval-propose-recall` and `eval-reference-windows` are named by no file, and `eval-jev-coload` only by `evals/package.json`. They are measurements, type-checked in CI. Running them is outside a check of suites.
