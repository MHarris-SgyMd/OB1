# An agent runner works one labelled ticket at a time, unattended, up to a draft PR (SMD-4087)

A design record. **Drafted 2026-11-06; every question in it answered, and the reviews' changes confirmed, by the maintainer the same day. It is accepted when its PR merges.** A security review and a correctness review followed the maintainer's first answers, and changed where a run works, what the runner runs and where it pushes ("Changed by the reviews", at the end). It designs SMD-4087, the runner the 2026-11-06 autonomy assessment found missing. That assessment's other findings are its siblings under SMD-2682: the eligibility label (SMD-4086), the permission profile (SMD-4088), the runner's identities (SMD-4089), the merge gate on `main` (SMD-4090) and the review bar with its report (SMD-4091).

## What it is, and what it is not

**It is** a maintainer-side client of the stable brain, GitHub and Linear. On a schedule it takes one eligible ticket, claims it, and works it with a headless Claude Code session in a fresh clone of its own. It checks the result as data and leaves a draft PR, from its bot's fork, for the maintainer; GitHub CI on that PR is the code gate. Every piece of work on this repo starts today with a person asking an agent. The runner lets the brain's own record start it: which tickets are open, unblocked and unclaimed.

**It is not:**

* **a merger.** Merges stay the maintainer's word (SMD-2682 step 4). The bot holds no write access to this repo, so it can't merge. SMD-4090's review rule on `main` is the backstop for any agent that does hold write access.
* **a planner.** It picks a ticket by a rule, not a model's judgement, and the agent works only the ticket it was given. The brain stores and labels; the client executes (SMD-1721).
* **part of the brain.** The coordinator (SMD-3215, `brain-coordinator.md`) runs the brain's own passes. The runner is a client on the maintainer's machine, like the session-capture hook.
* **an operator of stable or the canary.** It never runs `canary.sh`, a migration or a container command. It reaches stable only through the REST core, with its own agent-kind key, and holds no database credential.
* **a runner of the agent's code.** Nothing the agent wrote runs on this machine outside the agent's sandbox. The runner checks the agent's branch as data; GitHub CI runs it, on GitHub's machines.

## Before it can run

Each is a ticket SMD-4087 is blocked by, or a release:

1. **Stable runs v2.0.0.** Claims live in migrations 115 and 118 and the claim operations of SMD-3598 (`/v1/claims` in the REST core). Stable's 1.9.0 has neither (its ledger ends at 103). No claim, no run.
2. **SMD-4086:** the label that marks a ticket as the runner's to take, and the criteria the maintainer attests by adding it.
3. **SMD-4088:** the agent's permission profile.
4. **SMD-4089:** identities of the runner's own, none of them the maintainer's: a GitHub machine account with a fork of this repo and no write access here; a Linear key; an agent-kind brain key; and an Anthropic API key (decision 4a) in a Console workspace with a spend limit.
5. **SMD-3606:** a cap on one holder's live claims, the brain's backstop if the runner's loop goes wrong.
6. **SMD-2682 step 4 amended.** Decided by the maintainer 2026-11-06: the brain's runner may start work; merges stay the maintainer's.

The assessment also linked SMD-3874 (the claims hook misses an agent's MCP refusals) and SMD-4080 (an agent can reopen an item a person closed) as blockers. Neither touches the pilot: the agent has no MCP server (decision 4b), the session hook doesn't load in its sessions, and the runner touches no items. They apply again once an agent session gets a brain connection.

SMD-4090 (one approving review on `main`, with the maintainer as bypass actor) is related, not a blocker (decided by the maintainer 2026-11-06). The bot pushes only to its fork and can't merge (decision 13), so the rule is the backstop for any agent that does hold write access.

## Decisions

| # | Question | Decision | Why |
|---|---|---|---|
| 1 | Where it runs | On this Mac, the dogfood host, as a launchd agent (`local.ob1.agent-runner`). | The stable brain, the claim domain, runs here. The other long-running pieces already run as launch agents: Ollama (`local.ollama.serve`) and the decision tier (`com.openbrain.h2o-tier`). |
| 2 | Its home | `scripts/agent-runner/`: maintainer tooling. Cut 1 adds it to `scripts/tsconfig.json`'s `include`, which today takes only `scripts/*.ts`, so CI's typecheck covers it. | It encodes this repo's workflow (CLAUDE.md, the SMD board, the brain's claims). A general runner for any repo and brain would be an integration; that is a later question. |
| 3 | The harness | `claude -p` from a pinned version's own path (`~/.local/share/claude/versions/<version>`, with `DISABLE_AUTOUPDATER=1`), spawned in a process group of its own with an environment the runner builds: `--permission-mode dontAsk --permission-prompts none`, `--settings` naming the run's profile by absolute path, `--setting-sources project`, `--strict-mcp-config`, `--max-turns`, `--max-budget-usd`, `--model`, `--effort`, `--output-format stream-json --verbose`. `CLAUDE_CONFIG_DIR` is the runner's own, so none of the maintainer's user settings, hooks, memory or MCP servers load. | Every layer that enforces the profile (below) is a Claude Code feature that works the same in an interactive session, where it can be tried first. A call no rule allows is denied, and the model is told nobody can approve it. In `-p` a settings file that fails validation is ignored without a word, so the runner checks that its profile loaded rather than trusting it. The repo tracks no project settings file and no `.mcp.json`, and the guard and the sandbox keep the agent from writing either, so the project source brings nothing that runs. The Agent SDK is the alternative (below). |
| 4 | The model | **Decided 2026-11-06:** `claude-opus-5-5` with `--effort xhigh`, the level for coding and agentic work, both in the runner's config. | The pilot measures cost per merged PR (SMD-4091). A cheaper model is the maintainer's choice, with those numbers in hand. |
| 4a | Billing | **Decided 2026-11-06.** The runner authenticates with an Anthropic API key of its own, through `apiKeyHelper` reading a 0600 file, never the maintainer's subscription login. | Its spend shows apart from the maintainer's own sessions, and the key's workspace limit caps it whatever the runner counts. Claude Code's docs point anything built on it to API keys and keep subscription logins for ordinary use; unattended runs are not addressed directly. |
| 4b | The brain in the session | No MCP server at all in the pilot (`--strict-mcp-config` with an empty config). What the agent needs from the brain, the runner puts in the brief. | A local MCP server runs outside the sandbox, and a brain write key would let an unattended agent change memory (SMD-3338 lets any write key decide a proposal). A read-scoped key, or `plan_context` (SMD-2684), can come later. |
| 5 | Who acts outward | The runner's own code does every outward act: the claim, Linear, the push, the PR, the thought on stable. The agent reads, edits inside its clone, runs sandboxed commands and tests, and commits locally. | The model never holds an outward credential. What it can do wrong stays in one clone until the runner's checks pass, and then on one branch of the bot's fork. |
| 6 | Claims | **Decided 2026-11-06:** the runner claims over the REST core with its agent-kind key, before it creates the branch. It keeps the token beside its other secrets (below), not in the clone, and renews and releases from there. The agent session works under its caller's claim (CLAUDE.md step 2's subagent rule): the brief names the claim, and the session neither renews nor releases. Cut 2 amends CLAUDE.md step 3 to say where a runner keeps its token. | The rule every session follows already covers a caller and a subagent; the runner is the caller. A token in the clone would sit where the agent writes: it could be deleted, rewritten, or committed and published. |
| 7 | Selection | A rule (below), no model, over facts the runner can read. What no rule can check (one PR's worth of work; a Verify the agent can meet in its sandbox) the maintainer attests by adding the label. One ticket per run. | Predictable, and reviewable before anything runs: a dry run prints what it would take and why it skipped the rest. |
| 8 | Isolation | **Decided 2026-11-06:** a fresh, standalone clone per run, outside every checkout, in the run's own directory (below), on a branch under the runner's prefix (`agent/smd-<n>-<slug>`). The agent's sandbox writes only there and in the run's own temp directory. The runner never runs git, or anything else, in the clone: the session's last act is a git bundle of its branch, which the runner checks and imports into a bare repository of its own. The clone is deleted when the run ends. | A linked worktree would write its commits into the main checkout's `.git`, where a planted hook or config would run in the maintainer's own sessions. A bundle is data: importing it runs nothing the agent wrote. |
| 9 | Verification | **Decided 2026-11-06:** the runner's gate checks the branch as data before anything leaves the machine (below). The agent runs the checks that need no container inside its sandbox, and reports them. GitHub CI on the draft PR is the code gate, and reconciliation records its result on the ticket. Tickets whose Verify needs a container or a scratch stack are not the pilot's. | A model's "done" is not evidence; CI's run on the pushed commit is. CI runs the agent's code on GitHub's machines, with a read-only token and no secrets, never beside this Mac's podman and the stable brain. |
| 10 | Review | One review session, started in a fresh checkout of the base commit with Read, Grep and Glob only, and given the diff as text and the ticket. Its findings go back to the worker session once, by resuming it. What remains goes into the PR body. | The repo's own practice is a cold read before a PR. One pass keeps a low-level ticket low-cost; SMD-4091 sets the bar. The reviewer never opens the agent's clone, whose files and git config the agent wrote. |
| 11 | Limits | **Decided 2026-11-06:** one run at a time; at most 3 runs and $40 a day; 60 minutes a run; $10 for the worker session and $3 for the review session; runs start only on weekdays between 09:00 and 16:00 Central; a kill switch. How each applies is under "Limits" below. | Unattended spend and unattended mistakes both need a ceiling the runner enforces, not one the model is asked to keep. |
| 12 | Failure | Every run ends as a draft PR, or as a released claim with a reason, a Linear comment and the ticket handed back to a person (below). The run's bundle and logs are kept; its clone is not. A ticket the runner failed is not taken again until the maintainer labels it again. | SMD-4087's Verify: never an orphaned claim or clone, and no loop on a ticket the runner can't do. |
| 13 | GitHub | **Decided 2026-11-06:** the bot pushes only to its own fork of this repo and opens the PR from there, with edits by maintainers allowed. It holds no write access here. | A fork gives the bot nothing here to misuse: no `v*` tag to push, which would start `release.yml`; no branch to delete; no merge. A fork's PR runs CI with a read-only token and no secrets, whatever its diff holds. |

## How the profile is enforced

Deny rules alone are not a boundary. Claude Code's documentation lists ways around a prefix rule (an absolute path, `sh -c '…'`, `git -C . push`), and it recommends the sandbox and `PreToolUse` hooks for real enforcement. The sandbox's own defaults leave doors open too. Unless set otherwise:

* a sandboxed command runs with no rule allowing it (`autoAllowBashIfSandboxed`);
* the model may ask to run a command outside the sandbox (`allowUnsandboxedCommands`);
* a sandbox that can't start lets commands run without it (`failIfUnavailable`).

So the agent's limits come in layers, set so that a layer that fails is caught by another, and cut 2 tests each layer alone:

1. **Nothing outward to use.**
   * The session's environment holds only what the runner puts there:
     * no GitHub, Linear, brain or database credential, and no `SSH_AUTH_SOCK`;
     * `TMPDIR` set to the run's own temp directory;
     * `GIT_CONFIG_GLOBAL` naming a runner file the agent can read but not write, with `GIT_CONFIG_NOSYSTEM=1`. That file sets the bot's name and address and turns signing off, so neither the maintainer's identity nor the maintainer's signing key reaches a commit.

     The sandbox's credential settings deny any credential inherited anyway.
   * The Anthropic key reaches Claude Code through `apiKeyHelper`, not the environment.
   * The runner, not the agent, pushes and comments.
2. **The sandbox** (macOS Seatbelt), with `enabled: true`, `failIfUnavailable: true`, `allowUnsandboxedCommands: false` and `autoAllowBashIfSandboxed: false`:
   * Bash and its children write only inside the run's clone and its own temp directory. They never write the shared temp directories, where the maintainer's sessions leave scripts the maintainer later runs, and where `bunx` keeps its cache.
   * Reads of the whole home directory are denied, and re-allowed (`allowRead`) only for the clone, the run's temp directory, the runner's git config file and Bun. So no key under `~/.config` or `~/.ssh`, nothing of Claude Code's, no checkout of the maintainer's and no other run can be read.
   * No network: the runner installs the frozen dependencies before the session, and nothing the agent runs needs more.
   * The sandbox's own write protection of `.claude/settings.json`, git hooks and git config stays on; the profile sets nothing that lifts it.
   * The sandbox does not cover the Read, Edit and Write tools, or hooks. The next two layers do.
3. **A `PreToolUse` hook,** the runner's `guard.ts`, run by absolute path from the runner's install after a `cd` there, so no `bunfig.toml` or package file in the clone loads with it. It sees every tool call with its full input, before the permission rules, and allows only what it recognises:
   * the tools Read, Grep, Glob, Edit, Write and Bash, and in Bash only the command shapes on its list: git's local subcommands with `git bundle create`, and `bun` running a suite, a typecheck or a self-check;
   * paths inside the clone, after resolving symlinks, and never an Edit or Write into `.git/`, `.claude/`, `.mcp.json`, `.github/`, `scripts/agent-runner/`, `db/migrations/`, `CLAUDE.md`, `AGENTS.md`, a `bunfig.toml`, a `package.json` or a lockfile;
   * no call carrying `dangerouslyDisableSandbox`.

   Anything else is refused: an input it can't parse, an error of its own (its top-level catch exits 2), a tool it doesn't know. It logs each decision by tool-call id to the run's record, which the agent can't write. Only exit 2 or a deny blocks a call, so a guard that is killed or times out lets the call through. For that reason the runner matches every tool call in the session's stream against the guard's log, and ends the session at the first call the guard didn't allow.
4. **Permission rules and settings.**
   * Allow rules: Edit and Write in the clone, and the guard's Bash shapes.
   * Deny rules: WebFetch, WebSearch, the Agent tool and NotebookEdit.
   * Settings: `blockReadsOutsideWorkingDirectories` and `blockWritesOutsideWorkingDirectories`, `autoMemoryEnabled: false`, and `claudeMdExcludes` for any CLAUDE.md outside the clone.

   With `dontAsk`, `--permission-prompts none` and auto-allow off, anything unlisted is refused without a retry.
5. **The runner's own checks.**
   * The session's `system/init` event must show the pinned `claude_code_version`, the `dontAsk` permission mode, the helper as the `apiKeySource` and the expected tools. A profile that failed validation would show otherwise, and the runner ends that session.
   * The gate checks the branch again (below).
   * GitHub refuses the bot any push but to its fork, so the bot can't merge. SMD-4090's review rule is the backstop for any agent that holds write access.

**Cut 2's probes** run on the pinned version before any real ticket, and again before the runner moves to a new version:

* an unlisted command is refused; a call asking for `dangerouslyDisableSandbox` is refused by the guard, and with the guard off it still runs sandboxed;
* a sandboxed command can't read `~/.config/open-brain/`, `~/.ssh` or the main checkout, can't write a shared temp directory or outside the clone, and can't reach the network; `bun -e` spawning `podman` fails; `env` shows no key;
* Read and Edit outside the clone, or through a symlink out of it, are refused, and so are Edits of `.git/config`, `.claude/settings.json` and `CLAUDE.md`;
* `git push`, `gh` and `podman` are refused by the guard, and fail in the sandbox without it;
* a commit works, unsigned and as the bot; `--max-turns`, which `--help` doesn't list, still stops a session;
* a guard that crashes is caught by the log check, and a profile that fails validation by the init check;
* a session given the brief gets past CLAUDE.md step 1, instead of stopping because it can't run `git fetch`, `gh` or `list_claims`.

## Choosing a ticket

Each tick, after reconciling the runner's own runs (step 0, below), the runner takes the first ticket, in order of priority and then age, that passes every check:

* team SMD, in a project of the "Open Brain — self-hosted AI memory" initiative, state Backlog, assigned to no one;
* carries SMD-4086's label, added by the maintainer (Linear's history says who) after the description was last edited, and not the label that hands a ticket to a person;
* **unblocked:** every Linear blocker is Done, Canceled or a Duplicate. The brain's `node_state` is not read: the read `graph-centrality --startable` uses needs a database URL, and no REST operation carries it until SMD-3669's agenda read lands.
* **nobody's work** (CLAUDE.md step 1, after a `git fetch` of the runner's bare repository):
  * no branch on this repo or the bot's fork carries the ticket's id, and no worktree of the main checkout does;
  * there is no open PR (`gh pr list --search <id> --state open`);
  * `list_claims` shows no piece claims, and no unreleased claim, live or lapsed, unless that claim's PR has merged or closed. The runner asks with `ticket`, `include_ended: true` and `limit: 1000`, and asks again if the reply says `truncated`.

A lapsed claim that was never released is skipped, never taken: it may be work paused on another machine. A whole-ticket `claim_work` would close it as taken over (migration 115), with no one having decided the work is dead (CLAUDE.md step 1).

Once the agenda read lands (SMD-3669, ranked by effective priority, SMD-3667), the runner reads it, filtered by the label, instead of querying Linear.

## A run, step by step

0. **Reconcile** every run record not yet finished (below), whatever the gates in step 1 say.
1. **Gates.**
   * Take the lock: a file with the runner's PID and its start time, stale once that process is gone. launchd never starts the job again while it runs; the lock covers a run started by hand.
   * Check the kill switch, the hours, and the day's runs and spend.
   * Check that `GET /v1/brain` names stable's tier and answers healthy, and that GitHub and Linear answer.

   A refusal ends the tick quietly. An outage is recorded, and three ticks in a row ending in one write the kill switch, with the reason.
2. **Select** one ticket (above). None: end the tick.
3. **Claim.**
   * Write the run's record first: ticket, base commit, step.
   * List the ticket's claims again, then call `claim_work` over REST (`ticket`, `lease_seconds: 86400`, a label naming the runner, the machine and the branch). Write the token beside the runner's secrets as soon as it answers.
   * `WORK_CLAIMED` by another key: skip the ticket, and record why. By the runner's own key: an orphan of an earlier run that step 0 missed. Stop, and hand both to a person.
4. **Prepare.**
   * Clone the runner's bare repository, without hard links, into the run's directory, at the base commit, on `agent/smd-<n>-<slug>`.
   * Install the frozen dependencies in the directories CI installs, while the tree is still `origin/main`'s.
   * Write the run's profile, with its absolute paths, into the run's record.
   * Move the ticket to In Progress.
5. **Work.** Start the worker session in the clone, under `caffeinate -i`, with the brief (below) and its limits. The runner renews the claim while the session runs, and ends the session's process group at the limit. The session ends by writing a bundle of its branch.
6. **Review.**
   * Check the bundle, import its one branch into the bare repository, and take the diff there with the runner's own git config, no external diff and no textconv.
   * The review session (decision 10) reads the diff.
   * The runner then resumes the worker session once with the findings, and takes its new bundle the same way.
7. **Gate** (below), on the imported branch. A failure ends the run without publishing.
8. **Before publishing:**
   * Renew the claim with the record's lease, and read the reply as CLAUDE.md step 4 says. Stop on `CLAIM_RELEASED`, `WORK_CLAIMED` or `ticketClosed`, or on a lapse that names another claim made meanwhile.
   * Read the ticket again: it is still In Progress, still labelled, and its description is unedited since the brief.
   * Check "nobody's work" again, counting no claim but this run's own.
9. **Publish** as the bot:
   * Push the one branch from the bare repository to the bot's fork, with an explicit refspec, `--no-follow-tags` and hooks off.
   * Open a draft PR on this repo, with a body the runner builds (below).
   * Comment on the ticket with the PR link.
   * Set the record's lease to a week and renew (CLAUDE.md step 5).
10. **End.**
    * Delete the clone and the review's checkout.
    * Keep the bundle, the diff, the transcripts and the logs.
    * Capture the run's summary on stable.
    * Release the lock.

**On a failure** at any step after the claim, the runner hands the ticket back:

* **A work failure:** the gate, a limit, the way out, or any failure once the worker session has started.
  * Release the claim with a reason naming the step.
  * In one Linear write, take the runner's label off, add the label for a person, and move the ticket back to Backlog.
  * Comment why, and end as in step 10.
* **An environment failure:** stable, GitHub, Linear or Anthropic not answering before the worker session starts. Release the claim and move the ticket back to Backlog, keeping its label, so a later tick can take it.
* **A step that can't be done now,** such as a release while stable is down, stays in the run's record as owed, and step 0 retries it each tick. A record is finished only when nothing is owed.
* **A signal.** `launchctl bootout` sends SIGTERM. The runner ends the session's process group, records the step, and leaves the rest to the next tick's step 0.

## Limits

* **Time, per phase:** the run's 60 minutes split as 40 for the worker session, 5 for the review, 10 for the resumed worker, and 5 for the gate and publishing.
* **Money, per run:** the worker session's $10 covers both of its runs, so the resumed run's `--max-budget-usd` is what the first run left. The review has $3. By those ceilings a run spends $13 at most.
* **Money, per day:**
  * A run starts only if the day's spend plus $13 fits within $40, so three runs fit.
  * The spend is counted from each run's reported cost. A session that ends before it reports is counted by summing the usage on each message in its stream. `--max-budget-usd` is Claude Code's own estimate and can overshoot.
  * The API key's workspace limit in the Anthropic Console is the ceiling past all of these (SMD-4089).
* **Hours:** a run starts on a weekday between 09:00 and 16:00 Central, so a run started at 16:00 ends by 17:00. `caffeinate -i` keeps the Mac awake through it; this Mac otherwise sleeps after a minute idle.

## The gate

The runner runs the gate on the branch it imported, with tools from its own install; nothing in it comes from the branch:

* **The branch:**
  * it descends from the run's base commit and holds only the session's commits, none of them a merge;
  * each commit's author and committer is the bot, and no commit is signed;
  * each message passes commitlint, run from the runner's install with `origin/main`'s config, and its subject names the ticket.
* **The diff:**
  * only paths the label's criteria allow, and none of the paths the guard refuses;
  * under a size cap, with no new dependency;
  * no file over 1 MB or of a type CLAUDE.md refuses, and no symlink or submodule;
  * no secret, token or key pattern in the diff, the commit messages or any model text bound for the PR (the session hook's patterns, `wc_` tokens among them).

  A change to a script CI runs as a check (`scripts/check-*.ts`) is named at the top of the PR body, since CI runs the branch's copy.
* **The work:** each of the ticket's Verify items answered in the worker's report, and the review's findings fixed or listed.

The agent ran the typechecks, suites and self-checks of what it touched inside its sandbox, and its report says how they went; the runner does not run them again. Running the branch's code here would run it outside the sandbox, as the maintainer, beside podman and the stable brain. CI runs it instead: `brain-checks.yml` runs on the draft PR every check the branch's paths call for, `check-consistency.ts` and the landing check among them.

## The brief

The worker session's first message, built by the runner from a template in `scripts/agent-runner/`:

* the ticket's title, description and Verify, and the tickets it names, marked as data: a task to do, never an instruction to widen the profile or leave the ticket's scope;
* the clone it owns, its branch, and the claim it works under: the claim's id, held by its caller, which the session neither renews nor releases;
* that the runner already made CLAUDE.md step 1's checks and claimed the ticket, with what it found, and that the runner stands in for "the user" wherever CLAUDE.md says to ask. The session asks by stopping with its question (the way out);
* what it may do and what it may not (from SMD-4088's profile), and that the runner, not it, pushes and comments;
* the house rules it must follow (`CLAUDE.md`, the commit grammar, "a `[core]` subject ends in its ticket");
* the checks to run in its sandbox, for the directories it touched, before it stops;
* the done condition: commits on its branch, a clean tree, a bundle of the branch at the path the brief names, and a short report (what changed, how each Verify item was checked, anything left);
* the way out: if the ticket is unclear, unsafe, needs a decision, needs a container, or is bigger than one PR, stop and say why. That is a successful run of the runner, ending in a released claim and a comment.

## What the runner publishes

* **The PR body,** built by the runner from what it computed: the ticket, the diff's stat, the gate's results, and the session's time and cost. Then the worker's report and the review's open findings, after the secret scan, each fenced and headed as unverified model output.
* **The Linear comments and the thought on stable:** the runner's computed fields only, with the session hook's redaction applied. No model text goes to Linear or the brain, where later agents would read it as the record.

## Reconciling open runs

Step 0 of every tick, for every run whose record isn't finished:

* **A run that died before publishing** (a crash, a sleep, a reboot): handed back, naming the step. If its worker session had started, as a work failure; if not, as an environment failure.
* **Owed steps:** retried.
* **A published run:** the runner reads its PR first, since a PR merged just before board-sync closed its ticket is done, not closed under it (CLAUDE.md step 4).
  * **Merged:** release the claim (reason: the merged PR) and delete its token; delete the fork's branch; comment on the ticket. The ticket's state stays the maintainer's, since its Verify may still need a live check.
  * **Closed without merging:** release with a reason, delete the token and the fork's branch, and label the ticket for a person.
  * **Handed over** (a review requesting changes, or the ticket assigned to anyone): release the claim with "handed to <person>" and stop renewing, so the maintainer's own sessions can claim the work. The PR stays, open to the maintainer's pushes.
  * **Still open:** renew the claim with the record's lease, and read the reply as CLAUDE.md step 4 says. `WORK_CLAIMED`, or a lapse naming another claim made meanwhile, means someone else may have worked on it: comment, label the ticket for a person, and stop renewing. `CLAIM_RELEASED` with `ticketClosed` means the ticket closed while its PR was open: the same.
  * **CI finished** on the PR's head: comment its result on the ticket, once per head. A failure also labels the ticket for a person; the runner doesn't try again.
* **A release answered `already_released`:** board-sync releases every claim on a closed ticket (SMD-3600). The release is done; clean up the same way.

Records are pruned after 90 days.

## Secrets and records

* **Secrets:** each in a 0600 file under `~/.config/open-brain/agent-runner/` (decided 2026-11-06; the session hook and `deploy/.env` keep theirs the same way):
  * the bot's GitHub token, its Linear key and its agent-kind brain key, which the runner reads;
  * its Anthropic API key, which Claude Code reads through `apiKeyHelper`, outside the sandbox;
  * each claim's token, in `claims/<claim id>.json`.

  The agent's sandbox denies reading the whole home directory, these files included.
* **Records:** one directory per run under `~/.local/share/open-brain/agent-runner/runs/<run>/`:
  * the clone and the temp directory, while the run lasts;
  * the record, which the agent can't write: the run's facts as JSON (ticket, base, branch, PR, outcome, steps owed, time, turns, cost, gate results), its profile, the guard's log, the transcripts, the bundle and the diff.

  SMD-4091's summary reads these. Each run's summary is also captured on stable as a thought (decided 2026-11-06), through the REST core with the runner's own key.
* **Stopping it:** a `disabled` file beside the secrets stops new runs, while step 0 goes on renewing and releasing. `launchctl bootout gui/<uid>/local.ob1.agent-runner` stops the schedule.

## The pilot

Five to ten tickets the maintainer labels by hand, one run at a time, every PR a draft the maintainer reviews. What it measures (SMD-4091):

* the share merged unchanged;
* the share passing CI first time;
* time and cost per ticket;
* any rule broken: a touch of stable or the canary, a claim or clone left behind, a push anywhere but the bot's fork.

SMD-2682 step 4 widens acting further only with step 3's numbers in hand; this report is the first of them.

## Cuts

Each its own PR, in order:

1. **Selection and a dry run:** the selection rule and CLAUDE.md step 1's checks, printing what it would take and why it skips the rest. No claims or writes. It can land before stable runs v2.0.0, but until then its claim check says it can't read claims, and it takes nothing. Needs SMD-4089's Linear key, to read.
2. **One run, local:** first the probes above, on the pinned version. Then the claim, the clone, the worker and review sessions, the bundle, the gate and the record, ending at a branch in the runner's bare repository with no push. Amends CLAUDE.md step 3 for a runner's token (decision 6). Needs stable on v2.0.0, SMD-4088, and SMD-4089's brain key, API key and Linear key: this cut moves the ticket and comments.
3. **Publish and reconcile:** the bot's fork, the push, the draft PR and its body, CI's result, the week lease, reconciliation, handover, and the launchd schedule. Needs SMD-4089's GitHub identity. This repo asks the maintainer to approve CI on a first-time contributor's PR, so the bot's first PR waits for that click.
4. **The pilot and its report** (SMD-4091).

## Alternatives considered

* **The Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`, Claude Code as a library) in place of `claude -p`: the same settings, sandbox and hooks in-process, and a typed result with cost and turns. Not first, for two reasons. Its `canUseTool` callback runs only for calls that would prompt, so a `PreToolUse` hook is still needed. And Bun is not a documented runtime for it. If cut 2 finds it runs under Bun 1.4.3, the runner can switch without changing the profile.
* **A linked worktree of the main checkout,** the draft's first choice: its commits write into the main checkout's `.git`. The sandbox would have to let the agent write where a planted hook or config runs in the maintainer's own sessions.
* **The runner running `db/ci-parity.sh` and scratch stacks itself,** the draft's first gate: that runs the agent's code outside the sandbox, as the maintainer, beside podman and the stable brain. A `DATABASE_URL` in its environment would aim every suite at that database, the schema-dropping checks among them. A local code gate needs a machine of its own, such as a separate macOS account with its own podman machine, or a VM. It is worth that once a class of tickets needs containers.
* **A bot with write access to this repo:** without tag and branch rulesets it could push a `v*` tag, which starts `release.yml`, or delete branches. A fork needs no ruleset to be safe.
* **A separate macOS account for the sessions:** the operating system, not the sandbox, would keep the maintainer's files out of reach. It is heavier to run, with its own session, toolchain and permissions. It is the fallback if cut 2's read probes find a hole.
* **GitHub Actions** (a workflow running Claude Code on a schedule): no reach to the stable brain for claims without exposing it. Worth revisiting for a runner that doesn't need this machine.
* **Linear's agent delegation:** the agent would run outside this repo's permission profile, claim rule and gate.
* **Managed Agents** (Anthropic runs the loop and hosts a container per session): the container can't reach the stable brain without new plumbing.
* **The brain running it** (an n8n workflow under the coordinator): the coordinator runs the brain's own tasks, and its runs are not built (SMD-3477). The brain stores and labels; the client executes (SMD-1721).

## Decided by the maintainer, 2026-11-06

1. SMD-2682 step 4: the brain's client may start work; merges stay the maintainer's.
2. Billing: the runner uses an Anthropic API key of its own, not the maintainer's subscription login.
3. Secrets: 0600 files under `~/.config/open-brain/agent-runner/`.
4. Each run's summary is also captured on stable as a thought.
5. The model: `claude-opus-5-5` at `xhigh`.
6. The cost ceilings: $10 for the worker session and $3 for the review session (`--max-budget-usd`, Claude Code's own estimate, which can overshoot), and $40 a day, counted from each run's reported cost.
7. The hours and the daily cap: runs start on weekdays between 09:00 and 16:00 Central, at most 3 a day, one at a time. With the 60-minute wall-clock limit, a run started at 16:00 ends by 17:00. The pilot's numbers (SMD-4091) can justify widening either.
8. The reviews' changes 1 to 5 (below): the runner runs none of the agent's code, and GitHub CI is the code gate; each run works in a standalone clone and hands back a bundle; the bot pushes to its own fork, with no write access here; the claim token sits beside the runner's secrets, which cut 2 writes into CLAUDE.md step 3; and the profile closes the sandbox's open defaults and denies reading the home directory.
9. SMD-4090 is related to SMD-4087, not a blocker: with the bot on its fork, its review rule on `main` is a backstop.

## Changed by the reviews, 2026-11-06

A security review and a correctness review read the draft after the maintainer's answers. Their findings were checked against the repo, Claude Code 2.1.319's settings schema and this repo's GitHub settings. The maintainer confirmed changes 1 to 5 the same day; changes 6 to 8 bring the draft in line with CLAUDE.md's claim rules and the limits already decided:

1. **The runner runs none of the agent's code.** The draft's gate ran `db/ci-parity.sh` and scratch stacks on the agent's branch, outside the sandbox, as the maintainer. The gate is now data alone, GitHub CI on the draft PR is the code gate, and tickets needing containers are out of the pilot (decision 9, "The gate").
2. **A standalone clone, and a bundle back,** in place of a linked worktree that wrote into the main checkout's `.git` (decision 8).
3. **A bot fork,** in place of a bot pushing here, where no ruleset stops a tag push from starting `release.yml` (decision 13). SMD-4089's GitHub line changes with it.
4. **The claim token beside the runner's secrets,** not where the agent writes. This takes an amendment to CLAUDE.md step 3, in cut 2 (decision 6).
5. **The sandbox's open defaults closed and checked at start;** reads of the whole home directory denied; the guard fails closed and runs from the runner's install ("How the profile is enforced").
6. **Selection skips any unreleased claim, lapsed ones included,** so the runner never takes over paused work ("Choosing a ticket").
7. **The claim's life follows CLAUDE.md steps 4 to 6:** renew before the push; reconcile first in every tick, so a dead run is handed back; hand back explicitly, and hand over on the maintainer's signal ("A run, step by step", "Reconciling open runs").
8. **The limits apply per phase,** and the day's cap admits a run only if its ceilings fit ("Limits").
