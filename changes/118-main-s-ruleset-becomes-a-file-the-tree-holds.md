# 118. `main`'s ruleset becomes a file the tree holds to the workflow — every job required, strict, PR-only (SMD-1856)

**What changed.** Ruleset 22189960 on `main` required nine checks, none of
them `Retrieval replay gate` or SMD-1808's two linters, on whatever head the
PR had when they ran, and had no pull-request rule, so a direct push carrying
green checks reached `main`. It now carries four rules: `deletion` and
`non_fast_forward` as before; `pull_request` with zero required reviews (one
maintainer) and every review flag off, so nothing reaches `main` except
through a PR and nothing asks a review another way; and
`required_status_checks` naming every one of
`.github/workflows/fork-checks.yml`'s twelve jobs by display name, each pinned
to the GitHub Actions app (`integration_id` 15368) so a status another app or a
token posts under the same name satisfies nothing, with
`strict_required_status_checks_policy` on, so a PR whose run was green against
an older `main` is `BEHIND`, not mergeable, until it merges `main` and runs
again. The target stays the default branch, the bypass list empty, enforcement
`active`. The body is `.github/rulesets/main.json`, applied with one command:

```bash
gh api -X PUT repos/MHarris-SgyMd/OB1/rulesets/22189960 --input .github/rulesets/main.json
```

**Why.** The ticket's three gaps were each read off the live ruleset with
`gh api repos/MHarris-SgyMd/OB1/rulesets/22189960` on 2026-09-22: three rules,
nine contexts, none pinned to an app, strict `false`, no pull-request rule,
created 2026-09-03 and never updated. Two gaps had already cost something. The
replay gate (SMD-1295) had run unrequired since it was added, because the
ruleset lives outside the tree and adding a job to the workflow adds nothing to
it — SMD-1808's two linters then repeated that, added "as reporting jobs" with
a note that requiring them was this ticket's work. Strict off is the narrower
gap: a PR's run checks out the test merge against the `main` of its trigger
time, and stays green after `main` moves — which is how a second migration 047
could land on a tree that already held one. On 2026-09-22 three unpushed
branches carried a 047 each.

**Held.** `check-fork-consistency` check 20: `rulesetProblems`, one pure
function over the record and the workflow's job names (parsed with Bun.YAML,
as checks 13, 14 and 18 do), reports a job the record does not require, a
required context no job is named (a rename would otherwise block every PR
forever), a required entry with no context, a check not pinned to the Actions
app, a duplicate, strict off, enforce-on-create off, a required-status-checks
rule with no parameters or whose list is not a list, a pull-request rule
requiring a review, with a review flag on, or with none, a missing or doubled
rule, a rule type outside the four, a target other than `branch`, conditions
aiming anywhere but the default branch, a bypass actor, enforcement other than
`active`, and a record that is missing or does not parse. `workflowJobs`
refuses what the record could not name: a matrix job, a name holding an
expression, two jobs sharing one display name; a workflow that does not parse,
or has no jobs, is said so rather than read as an empty list. Twenty record
mutants and three workflow mutants each report exactly one problem, and the
problem names what was broken; eight non-probes — a list, a string, a null
rule, a null check, conditions that are a string — throw nothing and report
something. Run against the tree before the probes were there: the record
missing the replay gate fails 1, strict off fails 1, the shipped record passes.
What the check cannot hold is the live ruleset itself — CI's token cannot read
it, and a GET returns defaults the record omits, so a byte diff would not
serve — so the record drifts from GitHub's copy in one direction only:
someone editing the ruleset in the UI. The command above is the repair, and
the file is the review.

**Measured after.** The maintainer applied the record on 2026-09-22; the PUT's
response carried the four rules, the twelve contexts each with
`integration_id` 15368, strict `true`, the empty bypass list — and three
parameters the record does not name, which GitHub fills:
`required_reviewers: []`, `allowed_merge_methods` (all three) and
`require_extra_approval_for_unattributed_changes: true`, the last one more
review than the count for a pull request Copilot opens that no person is
attributed to. This PR, opened by a person, read `BLOCKED` with nine of twelve
checks green and `CLEAN` with twelve, no review asked. While it was in review
`main` took PR #110 and then PR #112, and each time the branch's index
conflicted with the new fragment, merged `main`, regenerated and ran again; the
second time the PR read `DIRTY` — a conflict, which strict would have read as
`BEHIND` had the trees merged clean. The direct-push refusal is the
maintainer's to observe: a push carries the ruleset's reasons back in
`remote:` lines.

**Review passes.** A cold read by an independent reviewer over the diff, twice.

| Pass | Finding | Caught | Fix |
| --- | --- | --- | --- |
| 1 | a `required_status_checks` rule with `parameters` absent or null passed — the type counted once and the function returned before strict, the pins or the job list were read | cold read | a problem, and a mutant |
| 1 | `target` and `conditions` were not held: a record aimed at `refs/heads/dev`, or at nothing, passed, and the one command would apply it | cold read | held to `branch` and `~DEFAULT_BRANCH`; two mutants |
| 1 | the pull-request rule was held for presence only while the record claimed zero reviews as a decision | cold read | `required_approving_review_count` held to 0; two mutants |
| 1 | a matrix job, a name with `${{ … }}` or two jobs sharing a name would pass the check and never match a context — every PR blocked, undetected | cold read | `workflowJobs` refuses the three shapes; three probes |
| 1 | the probes asserted a count, so any one rule firing satisfied a mutant; the no-record mutant mutated a record it then discarded | cold read | each mutant names the phrase its problem must carry; the table returns the record to judge |
| 1 | the fragment stated as measured a PUT, a refused push and a blocked PR that had not happened | cold read | measured is what was read before; the live verification is the PR's |
| 2 | the record pinned four review flags and `do_not_enforce_on_create` that the check never read — `required_review_thread_resolution: true` would have passed and been applied | cold read | `PR_RULE_FLAGS` and enforce-on-create held false; two mutants |
| 2 | the no-context push and the doubled-rule branch had no mutant; either could be deleted or weakened with every probe green | cold read | two mutants; the probe tables hoisted beside check 19's, with a non-probe set |
| 2 | `require_extra_approval_for_unattributed_changes` was described as a rule about commit authorship; it is one more review for a Copilot-opened PR no person is attributed to | cold read | reworded; the decision to leave it unpinned stands, for its real reason |
| 2 | a `required_status_checks` that is not a list read as twelve missing jobs; a workflow with no readable jobs read as twelve unknown contexts | cold read | each says what it is |
| 2 | FORK.md quoted two `remote:` lines as observed output that were not observed | cold read | prose says what GitHub answers; the transcript is the maintainer's to see |

**Not taken.** A linear-history rule — the fork lands with `--merge` by habit
and the record of how a branch diverged is wanted. Restricting merge methods
to `merge` — the same habit, not a rule the ticket asked for. Required
reviews above zero — one maintainer. A CI step comparing the record to the
live ruleset — the default token has no administration read; a maintainer's
`gh` does, and the command is one line. Pinning
`require_extra_approval_for_unattributed_changes` — no Copilot agent opens
PRs on this fork, so GitHub's default (on) changes nothing here; the record
stays the ticket's decisions.

**Follow-ups.** SMD-1857 (merge queue): with a queue, `merge_group` runs the
checks on the merged tree and strict becomes moot; the record then adds the
queue's rule. SMD-1981: `commit-lint` is `if:`-skipped on `push`, and a
`siggymd/**` branch fires `push` and `pull_request` on one SHA, so two runs
share the required name and the skipped one may be the one read — a workflow
change, filed rather than folded in. The check number 20 is also taken by
SMD-1936 on its branch; whichever lands second renumbers, as migrations do.
