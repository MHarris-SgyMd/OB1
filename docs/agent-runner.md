# An agent runner works one labelled ticket at a time, unattended, up to a draft PR (SMD-4087)

A design record. **Drafted 2026-11-06 for the maintainer's read; not accepted.** The maintainer answered all of its open questions the same day (see the end). It designs SMD-4087, the runner the 2026-11-06 autonomy assessment found missing. That assessment's other findings are its siblings under SMD-2682: the eligibility label (SMD-4086), the permission profile (SMD-4088), the runner's identities (SMD-4089), the merge gate on `main` (SMD-4090) and the review bar with its report (SMD-4091).

## What it is, and what it is not

**It is** a maintainer-side client of the stable brain, GitHub and Linear. On a schedule it takes one eligible ticket, claims it, works it with a headless Claude Code session in a fresh worktree, checks the result itself, and leaves a draft PR for the maintainer. Every piece of work on this repo starts today with a person asking an agent. The runner lets the brain's own record start it: which tickets are open, unblocked and unclaimed.

**It is not:**

* **a merger.** Merges stay the maintainer's word (SMD-2682 step 4). GitHub enforces it once SMD-4090 lands, so a runner that misbehaves still cannot merge.
* **a planner.** It picks a ticket by a rule, not a model's judgement, and the agent works only the ticket it was given. The brain stores and labels; the client executes (SMD-1721).
* **part of the brain.** The coordinator (SMD-3215, `brain-coordinator.md`) runs the brain's own passes. The runner is a client on the maintainer's machine, like the session-capture hook.
* **an operator of stable or the canary.** It tests on scratch stacks only, and never runs `canary.sh`, a migration, or a container command against `open-brain` or `open-brain-canary`.

## Before it can run

Each is a ticket SMD-4087 is blocked by, or a release:

1. **Stable runs v2.0.0.** Claims live in migrations 115 and 118 and the claim tools of SMD-3598. Stable's 1.9.0 has neither (its ledger ends at 103). No claim, no run.
2. **SMD-4086:** the label that marks a ticket as the runner's to take, and the criteria the runner checks.
3. **SMD-4088:** the agent's permission profile.
4. **SMD-4089:** a GitHub bot or app, a Linear key and an agent-kind brain key, none of them the maintainer's, and an Anthropic API key for the runner (decision 4a).
5. **SMD-4090:** `main` requires one approving review, with the maintainer as bypass actor.
6. **SMD-3874, SMD-3606, SMD-4080:** the claims hook sees an agent's own refusals; one key can't hold the whole board; an agent can't reopen what a person closed.
7. **SMD-2682 step 4 amended.** Decided by the maintainer 2026-11-06: the brain's client may start work; merges stay the maintainer's.

## Decisions

| # | Question | Decision | Why |
|---|---|---|---|
| 1 | Where it runs | On this Mac, the dogfood host, as a launchd agent (`local.ob1.agent-runner`). | The stable brain (the claim domain), its Ollama and podman for scratch stacks all live here. The other long-running pieces already run as launch agents: Ollama (`local.ollama.serve`) and the decision tier (`com.openbrain.h2o-tier`). |
| 2 | Its home | `scripts/agent-runner/`: maintainer tooling, type-checked with the rest of `scripts/` in CI. | It encodes this repo's workflow (CLAUDE.md, the SMD board, the brain's claims). A general runner for any repo and brain would be an integration; that is a later question. |
| 3 | The harness | `claude -p`, spawned by the runner as a child process with a stripped environment: `--permission-mode dontAsk --permission-prompts none`, `--setting-sources project` with `--settings scripts/agent-runner/profile.json` (the repo has no project settings file, so the runner's file is the whole profile), `--strict-mcp-config`, `--max-turns`, `--max-budget-usd`, `--model`, `--output-format stream-json --verbose`. | Every layer that enforces the profile (below) is a Claude Code settings feature that works the same in an interactive session, where it can be tried first. A call no rule allows is denied, and the model is told nobody can approve it. The Agent SDK is the alternative (below). Its in-process `canUseTool` callback sees only calls that would prompt, not those a rule allows, and Bun is not a documented runtime for it. |
| 4 | The model | **Decided 2026-11-06:** `claude-opus-5-5`, effort set explicitly (`xhigh`, the level for coding and agentic work), both in the runner's config. Cut 2 confirms which flag or settings key carries the effort level in a `-p` run. | The pilot measures cost per merged PR (SMD-4091). A cheaper model is the maintainer's choice, with those numbers in hand. |
| 4a | Billing | **Decided 2026-11-06.** The runner authenticates with an Anthropic API key of its own, through `apiKeyHelper` reading a 0600 file, never the maintainer's subscription login. | Its spend shows apart from the maintainer's own sessions. Claude Code's docs point anything built on it to API keys and keep subscription logins for ordinary use; unattended runs are not addressed directly. |
| 4b | The brain in the session | No MCP server at all in the pilot (`--strict-mcp-config` with an empty config). What the agent needs from the brain, the runner puts in the brief. | A local MCP server runs outside the sandbox, and a brain write key would let an unattended agent change memory (SMD-3338 lets any write key decide a proposal). A read-scoped key, or `plan_context` (SMD-2684), can come later. |
| 5 | Who acts outward | The runner's own code does every outward act: the claim, Linear updates, the push, the PR. The agent reads, edits inside its worktree, runs local commands and tests, and commits locally. | The model never holds an outward credential. What it can do wrong stays on one branch in one worktree until the runner's checks pass. |
| 6 | Claims | The runner claims with its agent-kind key before it creates the branch, keeps the token in the run worktree's `.work-claims/` (CLAUDE.md step 3), and renews and releases. The agent session works under a claim its caller names (CLAUDE.md step 2's subagent rule): it neither renews nor releases, and its profile denies reading `.work-claims/`. | The rule every session follows already covers a caller and a subagent; the runner is the caller. |
| 7 | Selection | A rule (below), no model. One ticket per run. | Predictable, and reviewable before anything runs: a dry run prints what it would take and why it skipped the rest. |
| 8 | Isolation | A fresh worktree per run from `origin/main`, on a branch under the runner's own prefix (`agent/smd-<n>-<slug>`). The agent runs only checks that need no container (typechecks, the PGlite schema suite, self-checks). Container-backed checks run in the runner's gate, outside the agent's sandbox: `db/ci-parity.sh`, and a scratch stack through `~/.cache/ob1-scratch-kit` (`OB1_SCRATCH=<ticket>`; ports derived from the ticket; teardown by exact names) when a ticket's Verify needs one. | The branch prefix is what the permission profile and GitHub's rules key on. Keeping podman away from the agent keeps every container command, and so every chance of touching `open-brain`, in the runner's own code. The kit has never touched `open-brain` in its uses. |
| 9 | Verification | The runner runs its own gate after the agent stops and before anything leaves the machine (below). | A model's "done" is not evidence; the same checks CI runs are. |
| 10 | Review | One read-only review session over the diff and the ticket, findings back to the worker session once; what remains goes into the PR body. | The repo's own practice is a cold read before a PR. One pass keeps a low-level ticket low-cost; SMD-4091 sets the bar. |
| 11 | Limits | **Decided 2026-11-06:** one run at a time (a lock); at most 3 runs a day and $40 a day, counted from each run's reported cost; per run a 60-minute wall-clock limit, a turn limit, and cost ceilings of $10 for the worker session and $3 for the review session; runs start only on weekdays between 09:00 and 16:00 Central; a kill switch. | Unattended spend and unattended mistakes both need a ceiling the runner enforces, not one the model is asked to keep. |
| 12 | Failure | Every run ends as a draft PR or a released claim with a reason, a Linear comment and a label for a person. The run's worktree is kept for inspection for a week. A ticket that failed is not retried automatically. | SMD-4087's Verify: never an orphaned claim or worktree, and no loop on a ticket the runner can't do. |

## How the profile is enforced

Deny rules alone are not a boundary. Claude Code's documentation lists ways around a prefix rule (an absolute path, `sh -c '…'`, `git -C . push`), and it recommends the sandbox and `PreToolUse` hooks for real enforcement. So the agent's limits come in layers, each enough by itself to stop the worst outcomes:

1. **Nothing outward to use.**
   * The agent's process starts with an environment that holds no GitHub, Linear or brain credential, and the sandbox's credential scrubbing removes any that is inherited.
   * The Anthropic key reaches Claude Code through `apiKeyHelper`, not the environment.
   * The runner, not the agent, pushes and comments.
2. **The sandbox** (macOS Seatbelt, enabled in the profile).
   * Bash and its children write only inside the run's worktree and the temp directory.
   * Reads of the runner's secrets directory, `.work-claims/` and `.env` files are denied.
   * The network allowlist is empty: the runner installs the frozen dependencies when it makes the worktree, and nothing the agent runs needs the network.
   * The sandbox does not cover the Read, Edit and Write tools, hooks or local MCP servers. The next two layers and decision 4b cover those.
3. **A `PreToolUse` hook** (`scripts/agent-runner/guard.ts`) sees every tool call with its full input, before the permission rules, and can refuse a call a rule allows. It refuses:
   * any `git push`, `gh`, `curl` or `wget`;
   * `podman`, `docker`, `compose`, `canary.sh` and `db/migrate.ts`;
   * an Edit or Write outside the worktree, or into `db/migrations/`, `.work-claims/`, `CLAUDE.md` or `AGENTS.md`;
   * a Read of `.env*`, `.work-claims/` or the secrets directory.

   Each refusal is written to the run's record.
4. **Permission rules** allow the routine and deny the rest. The routine is Read, Grep and Glob; Edit and Write in the worktree; `git` status, diff, add and commit; `bun` running a suite or a typecheck. With `dontAsk` and `--permission-prompts none`, anything unlisted is refused without a retry.
5. **The gate** checks the result again (below), and **GitHub** refuses a merge without the maintainer's approval (SMD-4090).

Three of these behaviours are documented, but not stated for print mode:

* whether `PreToolUse` fires in a `-p` run (hooks run in `-p` unless `--bare` is passed);
* whether the sandbox applies in a `-p` run;
* which fields the JSON result carries beyond `total_cost_usd` and `session_id`.

Cut 2 tests each before the runner relies on it: a session told to push, to read `.env` and to run `podman` must be refused by the hook and by the sandbox alike.

## Choosing a ticket

Each tick, before selecting, the runner reconciles its open runs (below). Then it takes the first ticket, in order of priority and then age, that passes every check:

* team SMD, in a project of the "Open Brain — self-hosted AI memory" initiative, state Backlog;
* carries SMD-4086's label, and meets its written criteria (no `db/migrations/`, auth or key code, stack operation, stable or canary brain, `CLAUDE.md` or `AGENTS.md`; one PR's worth of work; a Verify section that can be run);
* **unblocked:** every Linear blocker is Done, Canceled or a Duplicate, and the brain's `node_state` agrees (the read `graph-centrality --startable` uses);
* **nobody's work** (CLAUDE.md step 1): no worktree or branch carrying its id, no open PR (`gh pr list --search <id>`), and `list_claims` with `include_ended` shows no live claim and no lapsed, unreleased claim whose PR is still open;
* **not failed** by the runner in the last week.

Once the agenda read lands (SMD-3669, ranked by effective priority, SMD-3667), the runner reads it, filtered by the label, instead of querying Linear.

## A run, step by step

1. **Lock and gates.** Take the lock; check the kill switch, the hours, the daily cap and the stable brain's health. Any refusal ends the tick quietly.
2. **Select** one ticket (above). None: end the tick.
3. **Claim** it on stable with `claim_work` (`ticket`, `lease_seconds: 86400`, a label naming the runner, the machine and the branch). `WORK_CLAIMED`: skip the ticket and record why.
4. **Worktree** from `origin/main` at `.claude/worktrees/agent-smd-<n>-<run>`, on `agent/smd-<n>-<slug>`. Write the token file (CLAUDE.md step 3). Install the frozen dependencies in the directories CI installs. Give the session the bot's name and address as its commit author and committer (SMD-4089), so no commit carries the maintainer's identity. Move the ticket to In Progress.
5. **Work.** Start the agent session in the worktree with the brief (below), the permission profile (SMD-4088, enforced as above) and the limits. The runner renews the claim while the session runs. It stops the session at the wall-clock limit; `--max-turns` and `--max-budget-usd` stop it from inside (the budget is Claude Code's own estimate and can overshoot, so the runner's daily cap counts the reported cost too).
6. **Review.** A second session, read-only (no Edit, Write or Bash beyond `git diff` and `git log`), reviews the diff against the ticket. The runner resumes the worker session once with its findings.
7. **Verify** (the gate, below). A failure ends the run without publishing (step 10).
8. **Publish** as the bot: push the branch, open a draft PR whose body says what changed, how each Verify item was met, what the gate ran and what the review left open. Comment on the ticket with the PR link. Set the token file's lease to a week and renew (CLAUDE.md step 5).
9. **Record** the run (below), release the lock.
10. **On failure** at any step after the claim: release the claim with the reason, comment on the ticket, add the label for a person, keep the worktree, record the run.

## The gate

Run by the runner in the run's worktree, after the sessions end:

* **The diff's own shape:** only paths the ticket's criteria allow; under a size cap; no new dependency; no secret, token or key pattern (the session hook's patterns, `wc_` tokens among them).
* **The repo's checks:** commitlint on the branch's commits, the landing check (`scripts/check-landing.ts`, so a code change carries its fragment), `bun scripts/check-consistency.ts`.
* **What CI would run:** `.github/ci/changes.sh` classifies the change; for code, the typechecks of the touched directories and `db/ci-parity.sh`. These run here, outside the agent's sandbox, since ci-parity starts its own throwaway Postgres containers. A scratch stack, when a ticket's Verify needs one, comes up here too, through the kit.
* **The work itself:** each of the ticket's Verify items answered in the PR body, and the review's findings fixed or listed.

## The brief

The worker session's first message, built by the runner from a template in `scripts/agent-runner/`:

* the ticket: title, description, Verify, and the tickets it names;
* the worktree path it owns, its branch, and that the claim is its caller's (it neither renews nor releases);
* what it may do and what it may not (from SMD-4088's profile), and that the runner, not it, pushes and comments;
* the house rules it must follow (`CLAUDE.md`, the commit grammar, "a `[core]` subject ends in its ticket");
* the done condition: commits on its branch, a clean tree, and a short report (what changed, how each Verify item was checked, anything left);
* the way out: if the ticket is unclear, unsafe, needs a decision or is bigger than one PR, stop and say why. That is a successful run of the runner, ending in a released claim and a comment.

## Reconciling open runs

Each tick, for every run whose PR is open: renew its claim with the token file's lease. When the PR has merged, release the claim (reason: the merged PR), delete the token file and any marker beside it, remove the worktree, and comment on the ticket. A PR closed without merging: release with a reason, label the ticket for a person. A claim board-sync already released because the ticket closed (SMD-3600) answers `already_released`: clean up the same way.

## Secrets and records

* **Secrets:** the bot's GitHub token, its Linear key, its agent-kind brain key and its Anthropic API key, in 0600 files under `~/.config/open-brain/agent-runner/` (decided 2026-11-06; the session hook and `deploy/.env` keep theirs the same way). The runner reads the first three. Claude Code reads the API key through `apiKeyHelper`, which runs outside the sandbox. The agent's environment holds none of them, and its sandbox and hook deny reading that directory and any `.env` file.
* **Records:** one directory per run under `~/.local/share/open-brain/agent-runs/<run>/`: the run's facts as JSON (ticket, branch, PR, outcome, time, turns, cost, gate results), the session transcripts, the gate's log and the diff's stat. SMD-4091's summary reads these. Each run's summary is also captured on stable as a thought (decided 2026-11-06): ticket, outcome, PR, checks, time and cost, through the REST core's capture with the runner's own key. The summary carries no token: the runner applies the session hook's redaction before it sends.
* **Stopping it:** a `disabled` file beside the secrets stops new runs; `launchctl bootout gui/<uid>/local.ob1.agent-runner` stops the schedule.

## The pilot

Five to ten tickets the maintainer labels by hand, one run at a time, every PR a draft the maintainer reviews. What it measures (SMD-4091): the share merged unchanged, the share passing CI first time, time and cost per ticket, and any rule broken (a touch of stable or the canary, a claim or worktree left behind, a push outside the runner's prefix). Those are the numbers SMD-2682 step 4 asks for before acting moves any further.

## Cuts

Each its own PR, in order:

1. **Selection and a dry run:** the selection rule and CLAUDE.md step 1's checks, printing what it would take and why it skips the rest. No claims or writes, so it can land before stable's v2.0.0.
2. **One run, local:** claim, worktree, worker and review sessions, the gate and the record, ending at a local branch with no push. First, it tests the three print-mode behaviours above with sessions told to push, to read `.env` and to run `podman`. Needs stable on v2.0.0, SMD-4088 and SMD-4089's brain key and API key.
3. **Publish and reconcile:** push, draft PR, Linear, the week lease, reconciliation, and the launchd schedule. Needs SMD-4089's GitHub and Linear identities and SMD-4090.
4. **The pilot and its report** (SMD-4091).

## Alternatives considered

* **The Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`, Claude Code as a library) in place of `claude -p`: the same settings, sandbox and hooks in-process, and a typed result with cost and turns. Not first, because its `canUseTool` callback runs only for calls that would prompt (a `PreToolUse` hook is still needed), and Bun is not a documented runtime for it. If cut 2 finds it runs under Bun 1.4.3, the runner can switch without changing the profile.
* **GitHub Actions** (a workflow running Claude Code on a schedule): no reach to the stable brain for claims without exposing it, and scratch stacks would run on hosted runners. Worth revisiting for a runner that doesn't need this machine.
* **Linear's agent delegation:** the agent would run outside this repo's permission profile, claim rule and gate.
* **Managed Agents** (Anthropic runs the loop and hosts a container per session): the container can't reach the stable brain, its Ollama or this Mac's podman without new plumbing.
* **The brain running it** (an n8n workflow under the coordinator): the coordinator runs the brain's own tasks, and its runs are not built (SMD-3477). The brain stores and labels; the client executes (SMD-1721).

## Decided by the maintainer, 2026-11-06

1. SMD-2682 step 4: the brain's client may start work; merges stay the maintainer's.
2. Billing: the runner uses an Anthropic API key of its own, not the maintainer's subscription login.
3. Secrets: 0600 files under `~/.config/open-brain/agent-runner/`.
4. Each run's summary is also captured on stable as a thought.
5. The model: `claude-opus-5-5` at `xhigh`.
6. The cost ceilings: $10 for the worker session and $3 for the review session (`--max-budget-usd`, Claude Code's own estimate, which can overshoot), and $40 a day, counted from each run's reported cost.
7. The hours and the daily cap: runs start on weekdays between 09:00 and 16:00 Central, at most 3 a day, one at a time. With the 60-minute wall-clock limit, a run started at 16:00 ends by 17:00. The pilot's numbers (SMD-4091) can justify widening either.
