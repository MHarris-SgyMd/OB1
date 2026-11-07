# The agent runner (SMD-4087)

The agent runner takes one ticket the maintainer labelled, claims it on the stable brain, and works it with a headless Claude Code session. It leaves a draft PR for the maintainer. Its design is `docs/agent-runner.md`.

It is built in cuts, and this directory holds cut 1: the selection rule and its dry run. Nothing here claims, pushes or writes.

## The dry run

```bash
bun --no-env-file --config=/dev/null scripts/agent-runner/dry-run.ts                  # reads ~/.config/open-brain/agent-runner/config.json
bun --no-env-file --config=/dev/null scripts/agent-runner/dry-run.ts --config <path>  # another config, a relative path read from where you run it
bun --no-env-file --config=/dev/null scripts/agent-runner/dry-run.ts --json           # the verdicts as JSON
bun scripts/agent-runner/dry-run.ts --self-check                                      # every rule and reader on fixtures, offline; CI runs it
```

Bun otherwise reads two files from the working directory: a `.env`, which can set a proxy, TLS or logging setting that reaches every request, and a `bunfig.toml`, which can preload code before the dry run starts. The two flags keep both out, and the dry run refuses to start without them.

It also refuses to start when its environment sets anything in these families, which can reroute a request, change what TLS trusts, log a request's headers or load code:

* Bun's (`BUN_…`), Node's (`NODE_…`) and OpenSSL's (`SSL_…`) settings;
* the dynamic loader's (`DYLD_…`, `LD_…`);
* every proxy (`…_PROXY`, in either case).

Three are let through: `BUN_INSTALL`, `NO_PROXY`, and `BUN_RUNTIME_TRANSPILER_CACHE_PATH=0`, which turns Bun's transpiler cache off.

It lists each open ticket labelled `agent-ready` in the initiative's projects, in the order a run considers them. The one a run would take is marked `take`. Every other ticket is marked `skip`, with each of its reasons.

Any text that came from Linear, the brain or GitHub is printed on one line, with each character that doesn't show written as `<U+XXXX>`. Those are controls, bidirectional marks, zero-width and other invisible characters, fillers, private-use and unassigned code points, and the braille blank. So none of it can rewrite the terminal or pass for a line of its own. The JSON escapes the same characters. If a key's value ever comes back in an answer, the dry run prints `<a key>` in its place. An answer that isn't JSON is reported as such, never quoted.

It reads:

* **Linear,** with the runner's own key (SMD-4089): the labelled tickets, their history and their blockers.
* **GitHub,** only for the tickets that pass the label and board checks:
  * open pull requests;
  * once claims can be read, the PRs of each branch or worktree that names such a ticket, and of the branch an unreleased whole-ticket claim's label names for it. A run takes nothing before then, and each lookup spends GitHub's limit.

  A token is optional, since this repo is public. Without `github.token`, GitHub allows 60 requests an hour, and the dry run names a spent limit as such.
* **git:**
  * this repo's branches, and the bot's own copy's once SMD-4089 makes it, through `git ls-remote` run from outside any repository, with no local fetch;
  * the main checkout's local branches and worktrees.

  git runs with an environment built from nothing, no credential helper, https as its only transport, and no redirect followed. So a remote that refuses it can't make it use, or erase, a credential of yours. A transfer slower than 1 kB/s for 20 seconds is given up, and any git command still running after 60 seconds is ended.
* **The stable brain's claims,** over its REST core, only for the tickets that pass the label and board checks:
  * `GET /v1/brain` must say the brain's tier is `stable`;
  * then one `GET /v1/claims` per ticket, with the brain key in the `x-brain-key` header.

  Until stable runs v2.0.0 with its proxy's `/api` route, every ticket's claims can't be read, and the dry run takes nothing. The route comes from `compose.api-public.yaml` (deploy/README.md, "The REST core and its opt-in `/api`"); stable's server must also set `OB1_TIER=stable`.

No request it makes follows a redirect, logs its headers or relaxes TLS. A redirect would carry the key to wherever it points. It exits 0 once it has printed, 1 when a read fails, and 2 for a refused option, start, environment, config or key file.

## The runner's files

Everything the runner reads of its own sits in `~/.config/open-brain/agent-runner/`. That directory must be a real directory, not a link, and yours alone (`chmod 700`). On macOS, any access control list on the directory, the config or a key is refused too, since one can grant what the mode doesn't. `chmod -N` removes it.

To make the directory and put a key in it without the key reaching your shell's history, or a file anyone else can read for a moment:

```bash
(umask 077 && mkdir -p ~/.config/open-brain/agent-runner && chmod 700 ~/.config/open-brain/agent-runner)
(umask 077 && read -rs KEY && printf '%s\n' "$KEY" > ~/.config/open-brain/agent-runner/linear.key)   # paste the key, then Enter
```

The parentheses keep `umask 077` to those commands alone.

* **The keys** are at fixed paths, so no config can send a read elsewhere:
  * `linear.key`, the runner's own Linear key: required;
  * `brain.key`, its agent-kind brain key, 64 hex characters. A read-scope key is enough for the dry run; cut 2's claims need write;
  * `github.token`, a GitHub token: optional.

  Each must be a regular file of yours, with one link and readable by you alone (`chmod 600`), and hold a key of the right shape. The dry run refuses a link, a pipe, an open mode or a wrong shape, without printing the value. It reads these files alone, never the maintainer's own keys, and reads all of them before it sends anything.
* **`config.json`** must be a regular file of yours, not a link, and writable by you alone. For example:

  ```json
  {
    "initiative": "Open Brain — self-hosted AI memory",
    "maintainerLinearId": "<your Linear user id, a UUID>",
    "mainCheckout": "~/Projects/OB1",
    "restUrl": "http://127.0.0.1:8010/api"
  }
  ```

| Key | Default | What it is |
|---|---|---|
| `initiative` | required | The Linear initiative whose projects the runner takes tickets from, by its exact name. Exactly one initiative must have it. |
| `maintainerLinearId` | required | The Linear user whose `agent-ready` counts, as the UUID Linear's API answers for `query { viewer { id } }` under that user's own key. A placeholder is refused. |
| `mainCheckout` | required | The maintainer's main checkout: its local branches and worktrees count as work in hand. |
| `team` | `SMD` | The Linear team. |
| `repo` | `MHarris-SgyMd/OB1` | This repo on GitHub, as owner/name. |
| `botRepo` | `null` | The bot's own copy of this repo, as owner/name, once SMD-4089 makes it. |
| `restUrl` | `null` | The stable brain's REST core, as this host reaches it. It must be http or https, with no credentials, query or fragment, and plain http only on a loopback address. Plain http proves nothing about the server: while stable is down, any process on this Mac that takes its port receives the key. |

An unknown key is refused, and so is a file that isn't JSON. A refusal names the setting at fault and never quotes a value from the file. It counts unknown keys rather than naming them, since a name put there by mistake could be a secret. The labels' names are not config: they are SMD-4086's, fixed in the code.

## The criteria (SMD-4086)

A ticket the runner takes meets every criterion below. The runner checks the first group by rule. The maintainer vouches for the second group by adding `agent-ready`.

**Checked by rule:**

* team SMD, in a project of the configured initiative, in the state named Backlog;
* assigned to no one and delegated to no agent;
* its title holds no character that doesn't show, since the maintainer couldn't see all it says;
* **the label:**
  * `agent-ready` is on the ticket, and `agent-handed-back` isn't;
  * the ticket's history is read whole, and every time in it can be read. A history longer than the dry run reads, or a time it can't read, is refused, not trusted;
  * every add of the label at or after its last add is the maintainer's own, made directly. An add by another user, an integration, an automation or a bot acting for the maintainer voids the label;
  * nothing at or after the last add changes the description or the title, by anyone, the maintainer included. That holds for an entry that adds the label and changes the text at once: the maintainer adds the label again, on its own, to approve the text;
  * other changes, such as the priority, the project or a relation, leave the label standing: it vouches for the text;
  * Linear can update a history entry after writing it, so an entry counts as written at its later time;
  * Linear logs nothing in an issue's first few minutes. A label added then has no record, and the maintainer adds it again;
* **unblocked:** every blocker is Done, Canceled or a Duplicate, and the ticket's relations are read whole;
* **nobody's work** (CLAUDE.md "Claim your work", step 1):
  * no branch or worktree carries the ticket's id, matched as a whole id, unless a PR from it merged or closed into `main` at the commit it points at now, and none of its PRs is open;
  * a PR merged or closed into another branch, such as a stacked PR, frees nothing;
  * a branch at a commit other than its merged or closed PR's head, or with no PR at all, may be work not merged or not pushed yet, so it holds the ticket;
  * no open PR names the ticket in its head branch or title. A PR body naming it holds it only when the maintainer or the bot opened that PR: anyone can open a PR on this public repo, and one body could name every ticket;
  * it has no unreleased piece claim and no live claim;
  * it has no lapsed claim that was never released, unless that claim's PR merged or closed;
  * any claim in a state the rule doesn't know holds it.

  Each reason says why a branch holds: no PR, a PR open, no PR of it merged or closed into `main` at its commit, or its PRs not looked up while claims can't be read.

  A claim's PR is found by the branch its label names: the last word with a slash in the label that names the claim's own ticket. A label naming another ticket's merged branch frees nothing.

  A live claim whose PR merged or closed is stale: the dry run names it for the maintainer and leaves the ticket. A claim list cut at 1,000 hides claims, so that ticket is left too.

  The dry run looks for a branch's PR only in this repo owner's account. A PR from another account's copy reads as none, which holds the work.

  **Limits.** A branch names a ticket only by its whole id: a joint branch like `smd-3336-3173-x` names SMD-3336 alone. A worktree counts by its branch, so a locked worktree on a branch merged at its commit frees its ticket, uncommitted work and all. Claims cover both cases, since CLAUDE.md has every session at work hold one.

A ticket that fails the label or board checks is skipped for those reasons alone: its claims and PRs aren't read. Of the tickets that pass, a run takes the first by priority (urgent first, none last), then by age. Each later ticket that passes is skipped, with the one taken as its reason.

**Vouched for by the label:**

* the work fits in one PR;
* the agent can meet the Verify inside its sandbox, with no container and no scratch stack;
* the work changes none of the refused paths:
  * `.git/`, `.claude/`, `.mcp.json`, `.github/`, `scripts/agent-runner/`, `db/migrations/` and `deploy/`;
  * the auth and key code: every `auth` directory and `auth.ts`, and `server-portable/keygen.ts`, `pass-key.ts`, `oauth-*.ts` and `core/caller.ts`;
  * `CLAUDE.md`, `AGENTS.md`, and any `bunfig.toml`, `package.json` or lockfile.

  The runner's guard and gate refuse a write into those paths all the same (`docs/agent-runner.md`, layer 3).

**The labels:**

* `agent-ready`: only the maintainer adds it. Editing the ticket's description or title after it was added voids it until the maintainer adds it again, on its own.
* `agent-handed-back`: the runner adds it when it stops without a PR, and takes `agent-ready` off in the same write. To let the runner try again, the maintainer removes `agent-handed-back` and adds `agent-ready` again.

**What the label proves.** Linear records an add made through the maintainer's personal API key just as it records the maintainer's own click: the same user, and no bot. So "added by the maintainer" means added through the maintainer's account. Anything holding that account's write access can add the label, an agent session among them. To make the label the maintainer's own word, agent sessions hold only read access to Linear, or a key of their own.

## Cuts still to come

2. One run, local: the sandbox probes first, then the claim, the clone, the sessions, the gate and the record, with no push.
3. Publishing and reconciliation, and the launchd schedule.
4. The pilot and its report (SMD-4091).
