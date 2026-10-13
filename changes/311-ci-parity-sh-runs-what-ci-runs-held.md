# 311. ci-parity.sh runs what CI runs, held to the workflow both ways by check 35 (SMD-2903)

**What changed.**
- **`db/ci-parity.sh`** now runs every script a `fork-checks.yml` step runs outside the Docker jobs, from the step's directory, with the step's flags and environment:
  - fourteen `test-*` suites it lacked;
  - the 21 `--self-check` runs: the nine evals, the forwarder, orchestration's two, the authorization server's four, sync-linear and the four ingest adapters;
  - `eval-write-path.ts --gate` and `eval-projection-replay.ts --fixture-check`, with `OB1_FIXTURE_RESET=1` as CI sets it;
  - test-schema at the 768 width;
  - the consistency checker;
  - the typechecks of `jev` and `deploy/auth`.
- **Two verbs.** `run` is for a step that sets `DATABASE_URL`, against the shared Postgres. `nodb` is for a step of a job with no database, run with `DATABASE_URL` unset. Before, the database-free suites (test-server, test-auth, test-schema and the rest) ran with it set, unlike CI, and a suite that reads it, such as test-cli or test-connect, saw something CI's never does.
- **The verdict is the exit code**, as it is CI's. A suite that prints the house tally (`N assertions: …`) shows it, and a tally with failures fails even on exit 0. Before, a suite with no house tally was reported as crashed, and the exit code was not read at all.
- **Installs:** each directory CI installs is installed once, up front, from its lockfile, and a lockfile out of step is reported on its own row.
- **Check 35** in `scripts/check-fork-consistency.ts` holds ci-parity.sh to the workflow, both ways.
  - Every script a step runs must be a `run` or `nodb` line. It reads the steps with check 34's reader, now generalised to return each command's directories, flags and environment, including a command's own `NAME=value` assignments, so the 768 width is a run of its own.
  - The verb must match whether the step sets `DATABASE_URL`, and the other variables must match too. The database URLs themselves are the harness's.
  - Every typecheck step must be a `typecheck` line.
  - A line that no step runs as written is reported as stale.
  - `PARITY_NOT_RUN` excuses what ci-parity.sh cannot run:
    - the full-stack job and the authorization POC, which need built images and compose stacks;
    - the landing check, which reads a pull request's commit range;
    - the codemod round-trip, which rewrites tracked files.
    
    An excuse for a job or script CI no longer has is reported too.
- **FORK.md** says what ci-parity.sh runs and that check 35 holds it. Its "runs the default width only" is corrected: it runs both.

**Why.** ci-parity.sh says it is CI's local equivalent, and its own comment records why that matters: leaving the database-free suites out once let two stale tool-count assertions reach a pull request while it reported all green. By SMD-2895 it missed fourteen suites, every self-check and two typechecks, and nothing held it to the workflow.

**Held.**
- Against main's ci-parity.sh, check 35 reports 55 problems:
  - 46 CI commands missing or run with the wrong database verb;
  - 7 lines run with `DATABASE_URL` where CI's step has none;
  - the two typechecks.
  
  Against this branch's: PASS.
- `./db/ci-parity.sh` run whole, on Bun 1.4.3, twice: once as first written, and once as committed (review pass 3). All suites passed both times.
  - 64 suites and self-checks, among them test-schema at both widths (2733 each), test-live 1255, test-preflight 731, test-tools 185, extensions' test-auth 725, the session hook's 696, test-jev 106, and the gate (4) and fixture check (30);
  - all seven typechecks.
- With one assertion broken in test-weekly-digest, an added suite with no house tally, the row shows ✗ and the failing assertion, judged by its exit code (the ticket's Verify). A script that exits non-zero when it sees `DATABASE_URL` passes under `nodb` and fails under `run`. A command's own variables show in its row, so the two test-schema rows read apart.
- The ticket's own comparison, the `test-*` and `eval-*` scripts fork-checks.yml names against those ci-parity.sh runs, comes out empty both ways: 48 and 48.
- 27 mutants of check 35, all killed by check 35's own message:
  - the real workflow changed four ways, each reported from both sides (the step ci-parity.sh no longer matches, and the line no step runs now): a step's env value, a step's working-directory, a flag added to a step, a typecheck step removed;
  - each comparison dropped: verb, environment, flags, directory;
  - the stale-line report dropped, the unread-line report, and both typecheck reports;
  - a trailing comment not stripped, and a lowercase assignment not read;
  - a job excuse ignored, and both stale-excuse reports dropped;
  - a command's own assignments, or a script's flags, not read;
  - the database URLs compared;
  - the real ci-parity.sh broken seven ways: a line removed, `OB1_FIXTURE_RESET` dropped, a `nodb` suite run with the database, the 768 width dropped, a suite from the wrong directory, a typecheck removed, a self-check's flag dropped.
- Check 34's 16 mutants, all killed on the reader as refactored here.
- **A flaw in the mutant harness, found while doing this.** The harness for SMD-2895 and for this ticket wrote each backup beside the file it mutated (`scripts/check-fork-consistency.ts.smd2895bak`). The checker reads untracked files, so check 33 failed on the probe strings in the backup, and every mutant exited 1 whatever it did. So "killed" proved nothing unless the targeted check's own message was printed.
  - It hid one survivor here: a probe for the wrong directory had changed the script too, so dropping the directory comparison went unseen. The probe now changes the directory alone.
  - SMD-2895's 16 were rerun on a clean copy of main as merged (68a46679), with backups outside the tree and a kill counted only on check 34's message: all 16 killed, so its record stands.
  - The harness now keeps backups in `/private/tmp` and reports a failure from elsewhere as OTHER.
  - It also restored each file from a backup made by `shutil.copyfile`, which drops the mode, so db/ci-parity.sh lost its executable bit (review pass 3). It now copies with `copy2`, and `git diff --summary` shows no mode change after the run.

**Review passes.**

| Pass | Finding | Caught | Fix |
|---|---|---|---|
| 1 | A ci-parity.sh line check 35 could not read was skipped, though bash runs it: a quoted value with a space, a positional argument, a script with no script extension, a lowercase assignment, a trailing comment, a bare `typecheck`. So a wrong or stale line could pass unreported | run-it | a trailing comment and a lowercase assignment are read (on the workflow's side too), and any other line whose command is `run`, `nodb` or `typecheck` is reported as unreadable; probes for each |
| 1 | The record and the summary said 69 suites and self-checks; the run's rows are 64, and 7 typechecks | run-it | counted from the log, and corrected |
| 2 | Every mutant broke ci-parity.sh or the checker and none the workflow, so "both ways" was held on the real files from one side only | mutant | four mutants of fork-checks.yml (an env value, a working-directory, a flag, a typecheck step), each reported from both sides |
| 2 | The ticket's Verify names its own comparison, which had not been rerun | run-it | rerun with `nodb` lines and root-level paths read: empty both ways, 48 and 48 |
| 3 | db/ci-parity.sh had lost its executable bit (100755 to 100644), so `./db/ci-parity.sh`, as FORK.md runs it, was refused with "permission denied". The mutant harness's restore did it, and nothing checked the mode | run-it | the bit restored; check 35 refuses the script when it is not executable (a mutant that drops the bit is reported); the harness copies with `copy2`. The whole run was redone on the file as committed, row labels included |
| boyscout | ci-parity.sh's opening `cd` had no failure branch (shellcheck SC2164, on main too), and its two `deploy/orchestration` lines broke the column. Check 35 filtered the database URLs in two places and normalised CI's typecheck directories inside a loop | cold read | `cd … \|\| exit 1`, the column, one `heldEntries`, and the directories normalised once; shellcheck clean, mutants unchanged, no behaviour change |

**Not taken.**
- CI's write-path gate runs with no install for evals/ or db/, on purpose: a package added there and imported on that path fails it first. ci-parity.sh installs every directory once, up front, so it cannot reproduce that failure. Reproducing it would mean a second checkout without those installs.
- Deriving ci-parity.sh's list from the workflow at run time: offered, and the maintainer chose the list held by a check. It keeps CI's order on one database and each step's environment written down.
- The suites' own tallies: those with none of the house's (test-cli, test-connect and the rest print their own) show `exit 0`, which is CI's verdict too.
