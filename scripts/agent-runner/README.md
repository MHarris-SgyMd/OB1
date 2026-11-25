# The agent runner (SMD-4087)

The agent runner takes one ticket the maintainer labelled, claims it on the stable brain, and works it with a headless Claude Code session. It leaves a draft PR for the maintainer. Its design is `docs/agent-runner.md`.

It is built in cuts. This directory holds cut 1, the selection rule and its dry run, and cut 2a, the sessions' profile and its probes (SMD-4088). Nothing here claims, pushes or writes to Linear.

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

A ticket that fails the label or board checks is skipped for those reasons alone: its claims and PRs aren't read. Of the tickets that pass every check, a run takes the first by priority (urgent first, none last), then by age. Each later ticket that passes is skipped, with the one taken as its reason.

Any text that came from Linear, the brain or GitHub is printed on one line, with each character that doesn't show written as `<U+XXXX>`. Those are controls, bidirectional marks, zero-width and other invisible characters, fillers, private-use and unassigned code points, and the braille blank. So none of it can rewrite the terminal or pass for a line of its own. The JSON escapes the same characters. If a key's value ever comes back in an answer, the dry run prints `<a key>` in its place. A GitHub or brain answer that isn't JSON is reported as such, never quoted. Linear's client, `db/linear-api.ts`, which other tools share, can quote part of an error's body; the dry run masks any key in it and makes the text printable all the same.

It reads:

* **Linear,** with the runner's own key (SMD-4089): the labelled tickets, their history and their blockers.
* **GitHub,** only for the tickets that pass the label and board checks:
  * open pull requests;
  * once claims can be read, the PRs of each branch or worktree that names such a ticket, and of the branch an unreleased whole-ticket claim's label names for it. A run takes nothing before then, and each lookup spends GitHub's limit.

  A token is optional, since this repo is public. Without `github.token`, GitHub allows 60 requests an hour, and the dry run names a spent limit as such.
* **git:**
  * this repo's branches, the runner's App's `agent/` branches among them, through `git ls-remote` run from outside any repository, with no local fetch;
  * the main checkout's local branches and worktrees.

  git runs with an environment built from nothing, no credential helper, https as its only transport, and no redirect followed. So a remote that refuses it can't make it use, or erase, a credential of yours. A transfer slower than 1 kB/s for 20 seconds is given up, and any git command still running after 60 seconds is ended.
* **The stable brain's claims,** over its REST core with the brain key in the `x-brain-key` header, only for the tickets that pass the label and board checks:
  * `GET /v1/brain` must say the brain's tier is `stable`;
  * then one `GET /v1/claims` per ticket.

  Until stable runs v2.0.0 with its proxy's `/api` route, every ticket's claims can't be read, and the dry run takes nothing. The route comes from `compose.api-public.yaml` (deploy/README.md, "The REST core and its opt-in `/api`"); stable's server must also set `OB1_TIER=stable`.

No request it makes follows a redirect, logs its headers or relaxes TLS. A redirect would carry the key to wherever it points. Each request has a time limit: 20 seconds for GitHub and the brain, 30 for Linear. It exits 0 once it has printed, 1 when a read fails, and 2 for a refused option, start, environment, runner directory, config, key or access list.

## The runner's files

Everything the runner reads of its own sits in `~/.config/open-brain/agent-runner/`. That directory must be a real directory, not a link, and yours alone (`chmod 700`). On macOS, any access control list on the directory, the config or a key is refused too, since one can grant what the mode doesn't. `chmod -N` removes it.

To make the directory and put a key in it without the key reaching your shell's history, or a file anyone else can read for a moment:

```bash
(umask 077 && mkdir -p ~/.config/open-brain/agent-runner && chmod 700 ~/.config/open-brain/agent-runner)
(umask 077 && read -rs KEY && printf '%s\n' "$KEY" > ~/.config/open-brain/agent-runner/linear.key)   # paste the key, then Enter
```

The parentheses keep `umask 077` to those commands alone. Or use `setup.ts` ("Provisioning and rotating the identities" below), which places any of the keys with a shape check and a read-back, and never prints the value.

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
| `githubAppId` | `null` | The runner's GitHub App's id, as its settings page shows it, in a string (decision 13). |
| `githubAppInstallationId` | `null` | The App's installation on this repo, the number at the end of the installation's settings URL, in a string. |
| `githubAppSlug` | `null` | The App's slug, as its URL shows it. Its PRs carry the login `<slug>[bot]`, which counts as the bot's in "nobody's work". The three App keys come together: all of them, or none. |
| `restUrl` | `null` | The stable brain's REST core, as this host reaches it. It must be http or https, with no credentials, query or fragment, and plain http only on a loopback address. Plain http proves nothing about the server: while stable is down, any process on this Mac that takes its port receives the key. |

An unknown key is refused, and so is a file that isn't JSON. A refusal names the setting at fault and never quotes a value from the file. It counts unknown keys rather than naming them, since a name put there by mistake could be a secret. The labels' names are not config: they are SMD-4086's, fixed in the code.

## Provisioning and rotating the identities (SMD-4089)

The runner acts as itself, never as the maintainer: its own agent-kind brain key, Linear key, Anthropic key and GitHub App. **Creating the accounts and minting the keys is the maintainer's**, on the brain host — CLAUDE.md's "Keys" is clear that sessions do not change keys. `setup.ts` only places a minted secret into its file and checks it; it never creates a key, and it never prints one.

```bash
bun scripts/agent-runner/setup.ts dirs                      # make the directory (0700), idempotent
bun scripts/agent-runner/setup.ts install linear            # copy the key first; this reads it from the clipboard (pbpaste)
bun scripts/agent-runner/setup.ts install brain --stdin     # or read the key from stdin
bun scripts/agent-runner/setup.ts install github-app --stdin < <key>.pem  # the App's private key, from its file ("The GitHub App")
bun scripts/agent-runner/setup.ts verify                    # each secret present, 0600, right shape; the probe stamp's binary and install
bun scripts/agent-runner/setup.ts check-github-app          # the App and the rulesets its first publish waits on (network; gh for the rulesets)
```

`install` reads the secret from the clipboard (or `--stdin`), checks it against the runner's own shape (the same `KEY_SHAPES` the dry run reads with), writes it `0600` without following a link, and reads it back through the same owner-only read the runner uses — so a value it stores is one the runner will read. It prints only a masked line, never the value. `verify` reports each secret's presence, mode and shape without printing any value; `github.token` alone may be missing.

**Rotating a key is the same two steps: install the new value, then revoke the old one at its provider.** The runner reads each file fresh on every run, so no runner restart is needed. Per identity:

* **`brain.key` — the agent-kind brain key, on stable.** Mint it with the maintainer's "Keys" steps: `bun server-portable/keygen.ts --name agent-runner --scope write`, add the printed `agent-runner:write:<hash>` line to stable's `MCP_ACCESS_KEYS` (a line of its own — a repeated name stops the REST core), recreate the REST core so it re-reads the env (`compose … up -d --force-recreate api`), then `set_agent_kind('agent-runner','agent')` on stable's database so a claim reads `holderKind: "agent"`. Store the 64-hex key with `setup.ts install brain`. Rotate it only while the runner holds no live claims — a new name is a new agent id, which cannot renew or release the old key's claims (CLAUDE.md, "Keys") — then mint under a new name, install, recreate `api`, set the kind, and remove the old line once the runner has read the new key.
* **`linear.key` — the runner's Linear key.** Create a Linear API key, `setup.ts install linear`, then revoke the old one in Linear. *Pilot (2026-11-11): this is the maintainer's own personal key, so the runner's Linear moves and its hand-back comment show as the maintainer. The SMD-4089 Verify bullet "a comment names the bot, not the maintainer" is deferred; to meet it, give the runner a separate Linear identity (a bot user or a Linear app) and install its key.*
* **`anthropic.key` — the runner's Anthropic key.** Create a key in a Console workspace with a spend limit (the ceiling past the runner's own caps), `setup.ts install anthropic`, then revoke the old. Claude Code reads it through `apiKeyHelper` (`/bin/cat` of this file), so a rotation is just the install.
* **`github-app.pem` — the runner's GitHub App's private key** (decision 13, amended 2026-11-24; see "The GitHub App" below). To rotate: generate a new private key on the App's settings page; copy the old one aside (`cp -p ~/.config/open-brain/agent-runner/github-app.pem <a 0700 directory of yours>/github-app.pem.old`); `setup.ts install github-app --stdin < <the new .pem>` (from its file, not the clipboard: step 3 below); run `setup.ts check-github-app`. When its App lines pass (the slug and permissions, the installation, its repositories, and the publish's token minted), delete the download, the copy, and the old key on GitHub; when they don't, put the copy back with `setup.ts install github-app --stdin < <the copy>` and look again at the new key. A key that isn't RSA of 2048 bits or more, or can't sign, is refused before anything is written, and a write or a rename that fails leaves the old key whole. Only `check-github-app` can catch a key that signs but isn't this App's, which is why the old one is kept until that check passes. The installation tokens it mints last an hour and are never stored.
* **`github.token` — optional:** a read token, of any account and no scopes, that raises the dry run's GitHub limit from 60 requests an hour. It pushes nothing. To rotate: mint, `setup.ts install github`, revoke the old.

`setup.ts --self-check` proves the shape gate, the `0600` write, the no-symlink write, the owner-only read and the directory check offline, on a temp directory — no clipboard, no network, no key. CI runs it.

## The criteria (SMD-4086)

A ticket the runner takes meets every criterion below. The runner checks the first group by rule. The maintainer vouches for the second group by adding `agent-ready`.

**Checked by rule:**

* team SMD, in a project of the configured initiative, in the state named Backlog, of Linear's backlog type;
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

## The sessions' profile and its probes (SMD-4088)

Each runner session, the worker's and the review's, runs inside the five layers of `docs/agent-runner.md`, "How the profile is enforced". The files:

* **`profile.ts`:** each session's settings, a template per role with the session's paths substituted and nothing else; its environment, built from nothing; and its command line.
* **`guard.ts`:** the `PreToolUse` hook. It denies, or says nothing, and logs each decision.
* **`session.ts`:** the launcher. It checks the pinned binary's checksum, writes the settings into the run's record and reads them back, and starts the session in a process group of its own. It ends the session when:
  * the init event isn't the session it started;
  * a tool result answers a call the guard never logged;
  * the time limit runs out.
* **`probes.ts`:** the probes. **`mock-api.ts`** is their stand-in for the Messages API. **`probes-check.ts`** is the offline self-check.
* **Helpers the whole runner shares (SMD-4325).** Each has one definition, and the rest of the runner imports it.
  * In files hashed into the probe stamp, so an edit to one voids it: **`guard.ts`** has `isObject` (an array is not one, in a claim reply too), `codePointName`, `printable` and `shownText`; **`session.ts`** has the no-follow file read and write.
  * Outside the stamp: **`text.ts`** has the one-line cut and `maskTokens`, the one mask for a claim token (`wc_…` and the markdown-escaped `wc\_…`); **`facts.ts`** has `jsonOf` and `NOT_JSON`; **`fixture-git.ts`** has the git the self-checks build fixtures with.

```bash
bun scripts/agent-runner/setup.ts claude ~/.local/share/claude/versions/2.1.329       # the runner's own copy; prints --claude --sha256 --version
bun scripts/agent-runner/setup.ts checkout                                            # the runner's own checkout, at the main checkout's origin/main
cd ~/.local/share/open-brain/agent-runner/install                                     # the probes and a run start from the install
bun --no-env-file --config=/dev/null scripts/agent-runner/probes.ts --claude <path> --sha256 <hex> --version 2.1.329 --main-checkout ~/Projects/OB1
bun --no-env-file --config=/dev/null scripts/agent-runner/probes.ts … --state <dir> --only init,keychain --main-checkout ~/Projects/OB1
bun scripts/agent-runner/probes.ts --self-check                                       # offline, no Claude Code; CI runs it
```

**How a probe works.** Each probe starts one session on the pinned Claude Code, against a scripted stand-in for the Messages API on a loopback port. Each turn, the stand-in asks for the next call of the probe's script. So the probe makes exactly the call it tests, with no model and no spend; the only address the session is given is the loopback stand-in's. The session's key is a stand-in that `apiKeyHelper` prints. Each probe then checks the tool's result, the guard's log, the files on disk and the requests the session sent.

A probe tests one layer alone where it can. With the sandbox alone, the guard only logs, Bash is allowed whole, and the permission settings' blocks are off, since those read a Bash command's paths too. With the rules alone, the guard only logs. A probe fails if a call in its script got no result, so no check passes on a call that never ran.

`--state` defaults to `~/.local/share/open-brain/agent-runner`. Each run's records stay in `probes/<time>/` there: the settings, the guard's logs, the streams and each probe's outcome. Clones and temp directories are removed. When every probe passes, the run writes `probe-stamp.json` there, recording Claude Code's path, checksum and version, Bun's and git's checksums, the macOS build, each profile and probe file's hash, and the set of probes that passed; a failed run deletes any earlier stamp and writes none. Cut 2b starts a session only under a stamp that matches. Run the probes again after any change to the profile or probe files, and before moving to a new Claude Code, Bun, git or macOS version (the stamp pins each, so an unprobed change makes cut 2b refuse to start).

**The brief probe (the model probe).** One probe needs a model: that a worker given the brief gets past CLAUDE.md step 1 — it does the task instead of stopping because it can't run `git fetch`, `gh` or `list_claims`. Only a model reasons past step 1, so it can't use the scripted stand-in; it runs apart from the sweep, as `--brief-probe --anthropic-key <file>`. That is one real-model worker session at the runner's real model and effort (`claude-opus-5-5`, `xhigh`; decision 4), bounded at $2 and 20 turns for the trivial task, on a trivial, clean ticket, under the real profile with the real repo CLAUDE.md in its config directory — so the claim ceremony is actually there to get past. It passes when the worker edits the clone and fails when it stalls at step 1; the clone and temp directory are removed, a `brief-probe.json` verdict and the session's record stay. It is not part of the stamp, and its verdict logic has offline self-check coverage.

**What they found on 2.1.319** (2026-11-07). All 35 pass; a first review pass then hardened the self-check and added probes. The design took these from them:

* **The temp directory is short.** Claude Code keeps child commands in `<CLAUDE_CODE_TMPDIR>/claude-<uid>` only while that path is at most 44 bytes (the binary's own constant). Otherwise it falls back to the shared `/tmp/claude-<uid>`, which the profile denies, and every command exits 1. So a session's temp directory is `/private/tmp/obr-<8 hex>`, not a directory in the run's record.
* **The temp directory is also Claude Code's own staging** (`bash-edit-diff`, `tasks/`, `plugin-tool-staging`). The Edit and Write tools run outside the sandbox, so the profile lets them write the clone alone, never the temp directory; the shell still writes the bundle and its scratch there, inside the sandbox. So the agent can't use a tool to plant a file Claude Code later reads and acts on.
* **`--tools` gives a session exactly the role's tools,** so the init check can require them exactly.
* **Exit 0 is a pass,** whatever a hook prints. A hook that prints nonsense and exits 0 lets the call on to the permission rules; a crash, a timeout, or an exit other than 0 blocks it (exit 2 is the guard's own deny). So the guard prints nothing on stdout, exits 0 only to pass, and denies with exit 2.
* **The guard names a command's binary, not what it does.** `bun` runs a script the agent wrote in its clone, and git can write a file (`git log --output`) or run a pager program; all of it runs sandboxed. So the sandbox is Bash's real boundary; the refused paths are a guard rule for the Edit and Write tools, and for a change a Bash command makes in the clone it is the gate's diff and GitHub CI that catch it.
* **With the guard off,** the permission settings still refuse a write to `.claude/settings.json`, and Claude Code refuses an Edit of `.git/config`. An Edit of `CLAUDE.md` goes through. So for the refused paths, the guard is the only layer for the Edit and Write tools, and the gate checks the diff again.
* **`/usr/bin/git` is Apple's xcrun shim.** It writes a cache into the maintainer's per-user temp directory, so in the sandbox every git command printed that failure twice. The session's PATH puts git's own binary first (`xcode-select -p`, then `usr/bin/git`). The sandboxed shell is no login shell, so the PATH stays as set. The XDG directories sit inside the temp directory, so git looks for no file in `~/.config`.
* **The sandbox holds alone:**
  * reads of `~/.config/open-brain`, `~/.ssh`, the main checkout, `/private/tmp/claude-<uid>` and the maintainer's `$TMPDIR` are refused;
  * writes outside the clone and temp directory are refused;
  * the network is refused, through the proxy (403) and around it;
  * Unix sockets are refused: podman's, the SSH agent's, and the session's own messaging socket;
  * a `bun -e` that spawns podman (or curl) runs, but the spawned process is still sandboxed: it is refused the container host or the network;
  * a call asking for `dangerouslyDisableSandbox` still runs sandboxed.
* **The login keychain is out of reach.** A sandboxed `security find-generic-password` finds nothing (exit 44) where the same search outside finds the item (exit 0). The sessions stay in the maintainer's account.
* **Grep and Glob don't follow a link out of the clone.**
* **Claude Code sets two credentials for a command itself.** One is the token of its messaging socket, which the sandbox blocks. The other is its sandbox proxy's login, and the proxy refuses every host. Neither is the runner's.

**What they found on 2.1.329** (2026-11-20, SMD-4489). The pin moved here: Claude Code's updater had pruned 2.1.319 from `~/.local/share/claude/versions`, and the stamp names the binary's path. So the pinned binary is now a copy in the runner's own directory, `~/.local/share/open-brain/agent-runner/claude/2.1.329`, and `--claude` is given that path, for the probes and for a run. All 35 pass, after one change:

* **Claude Code refuses to start on a profile that fails validation.** Given `sandbox.enabled: "yes"`, 2.1.319 started and the init check ended the session. 2.1.329 emits no init event, only one error result (`error_during_execution`, `startup_failure_reason: sandbox_required_unavailable`), and exits. `session.ts` took that for a session that ended with its result. A result before any init now ends the session as `init`, with the result's subtype, its startup failure reason and its first error as the reason, and its text is not taken as a report.
* The other 34 probes passed unchanged. Their notes on 2.1.329: a call asking for `dangerouslyDisableSandbox` runs sandboxed; Claude Code sets `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_MESSAGING_TOKEN`, `CLOUDSDK_PROXY_USERNAME` and `CLOUDSDK_PROXY_PASSWORD` itself; an Edit of `CLAUDE.md` goes through with the guard off. The 2.1.319 sweep's records kept each probe's pass, not its notes, so the notes are not compared.

**The brief probe passes on 2.1.329** (2026-11-20): the worker got past CLAUDE.md step 1 and edited the clone, in 17 turns for $0.21. The guard refused three of its sixteen calls, each for the command's shape (an `&`, a `git bundle` form other than `create`, an `ls`), none for a tool input it didn't know. A first try that day reached no model: the API answered 401 to the runner's Anthropic key, which the maintainer then replaced.

**The stamp names two paths, and `setup.ts` makes both** (SMD-4491). A run starts only under a stamp whose Claude Code and whose checkout are still there and still as probed. Both were lost once: the binary to Claude Code's updater, the checkout to a worktree's removal.

* **`setup.ts claude <path>`** copies that binary to `~/.local/share/open-brain/agent-runner/claude/<version>` (0500, in a 0700 directory), asking the binary its own version. It prints the three flags the probes and a run take. The same bytes again are left alone; other bytes under a version already there are refused, since a stamp may name the copy.
* **`setup.ts checkout [--commit <sha>]`** makes `~/.local/share/open-brain/agent-runner/install`: a clone of the runner's bare repository on a detached HEAD, at the main checkout's `origin/main` unless a commit is given. Only a commit of main is taken: the bare repository also holds the branches sessions wrote, and the install is the code that holds a session. No task works in it. Run again, it moves the install to the newer commit, names each probed file the move changed, and prints what the stamp makes of the install as it now is, read from the files: when that says a file differs, the probe sweep runs again from the install. A checkout with changes of its own is refused.
* **`setup.ts verify`** and **`live-run.ts --plan`** say what the stamp makes of both, before a run is tried: a binary gone or changed, an install gone, each probed file that differs, a run started from another checkout, a new Bun, git or macOS build.

**From the install, give the sweep `--main-checkout`.** It defaults to the checkout the probes run from, which was the maintainer's own tree while they ran from a worktree of it. From the install that default is the install, and the probe that a session can't read the maintainer's checkout would test the wrong directory.

Until the install is made and probed, the stamp names the checkout the last sweep ran from, and a run starts from there.

## The live run (`live-run.ts`)

The executor runs one ticket end to end with the real clients — the capstone of cut 2c. Two modes, so the money path is never the default:

* `--plan --ticket SMD-NNNN`: loads the config and keys, takes the ticket (its full fields fetched from Linear, Verify and the named ids parsed, checked for a character that doesn't show), provisions the runner's bare repository (a local clone of the main checkout, fetched each run), and prints what a run would do. No session, no claim, no Linear write, no spend.
* `--execute --ticket SMD-NNNN --claude <path> --sha256 <hex> --version <x.y.z>`: the real run. It refuses a ticket not labelled `agent-ready`, checks the probe stamp (so the profile is as-probed — run the mock probes on this Claude Code first), then assembles the real `RunDeps` and `LiveDeps` and runs `liveRun`: claim on stable, move to In Progress, the worker and review sessions on the pinned Claude Code (the Anthropic key through `apiKeyHelper`), the gate, the release and the hand-back to Backlog. Up to about $13, with no PR (cut 3 publishes). The branch stays in the bare repository; the run's record stays under `runs/<run>/`.

**The hand-back comment** is all a person reads of a run until cut 3 publishes, so it says only what the run left (SMD-4516). It names the branch, the bundle and the diff when the run kept the worker's bundle beside its record, which it does only once the branch's import landed. A run that kept none (it ended at prepare, on a worker session that did not finish, or on a bundle it refused) is told as having kept nothing to publish from, and the claim's release reason says the same. The comment does not say nothing was imported: a copy that failed after the import leaves a branch and no bundle. When the review session did not finish, the comment says the branch was not reviewed by the runner, in the PR body's words.

The sessions commit as a placeholder bot; the App's own commit identity comes with the wiring (cut 3b-2). The gate's commitlint runs `@commitlint/cli` in a private bunx cache (the shared cache can lose a dependency); its secret scan is the session hook's `scanForSecrets`. The offline logic — the brief-ticket builder, the bare repo, the commitlint parser and the session-path layout (record and config in subdirs so `pathsProblem` passes) — has a self-check (`bun scripts/agent-runner/live-run.ts --self-check`).

## The publish step (`publish.ts`)

On a run that passed the gate, the runner publishes as its GitHub App (cut 3a is the logic, 3b-1 the App's client; the wiring, reconcile and the schedule are 3b-2, 3b-3 and 3c). Two pieces, both offline-tested (`publish-check.ts`):

* **`buildPrBody`** composes the PR body from the run's own computed fields — the ticket, the diff's stat, the gate, the sessions — then the worker's report and the review's open findings as model text. Each model section is masked of claim tokens, scanned with the session hook's `scanForSecrets`, and put in a code block whose fence is longer than any run of backticks inside it, so the model output can't break out of the block, render, link or mention anyone. A flagged section is withheld with a count, not shown; the whole body stays under GitHub's 65,536-character cap, and if two model sections would pass it they are dropped whole (never cut mid-fence) with a note pointing at the run record.
* **`publish`** runs the sequence over an injected GitHub client: step 8's renew with the day lease to confirm the claim — published only on a clean renewal, else the publish is left owed (a retryable refusal) or the ticket handed to a person (it closed, or another claim took the work) — then the push of its `agent/` branch, the draft PR, the record of its number, the PR-link comment on the ticket (a Linear outage leaves the comment owed), and the claim's lease set to a week now the PR is open. It never throws. A refusal no retry mends (a push that isn't a fast-forward or that GitHub itself refuses; a PR with no commits, a bad base, or someone else's PR from the branch) hands the ticket to a person rather than leaving the publish owed; the rest are retried ("The GitHub App", below).

`publish` wired into the live run is cut 3b-2, step 0's reconcile 3b-3, and the launchd schedule 3c.

## The GitHub App (`github.ts`)

The runner pushes and opens PRs as a GitHub App of its own (decision 13, amended by the maintainer 2026-11-24, in place of a machine account's fork). `github.ts`'s `appClient` is publish.ts's GitHub client:

* **The token.** The App's private key signs a JWT good for nine minutes, which buys an installation token good for an hour. Each push and each PR asks for its own, for this repo alone, with `contents: write` and `pull_requests: write` and nothing more, and revokes it once the step is done. GitHub grants a narrowed token only what was asked, so what the App itself holds is for `check-github-app` (below) to check; the client checks the answer all the same, and revokes and refuses a token that comes back with more, with less, or for another repository. A token is read as an opaque `ghs_…` string: GitHub's stateless tokens, minted since 2026, run to about 520 characters.
* **The push.** One branch, `agent/smd-<n>-<slug>` (record.ts `branchFor`'s shape; any other is refused before a token is minted), from the runner's bare repository, by an explicit refspec naming the commit the gate passed (`<commit>:refs/heads/<branch>`, so a ref moved after the gate pushes nothing unchecked), with no tags, no hooks and no force. Every git call of the runner's runs with replace refs and grafts off (`gitEnv`), so the gate and the review read the objects that are pushed, not a `refs/replace/` stand-in for them. The token rides in git's environment as an `http.extraheader` scoped to `https://github.com/`, so it is in no URL git could echo and in no argument; `ps -E` shows a process's environment to this user alone, who can read the key file anyway. Every word that comes back is scrubbed of it before anything cuts it short. The bare repository's config is read first, in every scope git would read for the push (its `config` and, with the extension on, its `config.worktree`), and a push is refused unless every key is one `git clone --bare` or the runner writes (`core.*`'s few, `remote.origin.url` and `.fetch`, `extensions.objectformat`, `gc.auto`, `maintenance.auto`): a proxy or TLS setting, a URL rewrite, a remote named by the URL pushed to, an include or a credential helper could send the token elsewhere. A branch already on GitHub at a commit this one doesn't descend from, or a push GitHub itself refuses (a ruleset, a workflow file the App may not write), is final and handed to a person; a remote failure, or GitHub's passing error, is retried.
* **The PR.** A draft, from the branch, to `main`. An open PR the App already opened from the branch is the answer, so a retry after a lost reply opens no second one; a 422 whose PR then turns up is the same. No commits between the branch and `main`, a base GitHub won't take, or an open PR from the branch that isn't the App's (a person opened one, or `githubAppSlug` names another App), is final; any other 422 (an abuse limit, a head GitHub doesn't see yet just after the push), or a lookup that failed after one, is retried. A refusal carries GitHub's `message` and its `errors[]` messages.

**Making the App, the maintainer's** (once):

1. On GitHub, under the maintainer's account: Settings → Developer settings → GitHub Apps → New GitHub App.
   * A name (its slug follows from it) and a Homepage URL (this repo's will do).
   * Webhook: untick **Active**. The runner reads GitHub; nothing calls it.
   * Repository permissions: **Contents: Read and write**, **Pull requests: Read and write**, and nothing else (Metadata: Read-only is added by GitHub). Not **Workflows**, not **Administration**.
   * Where it can be installed: **Only on this account**.
2. On the App's page, generate a private key: GitHub downloads it as a `.pem` file. Install the App on **this repository only**.
3. Put `githubAppId`, `githubAppInstallationId` (the number at the end of the installation's settings URL) and `githubAppSlug` in the runner's config. Then place the key from its file, not the clipboard (a key on the clipboard reaches clipboard managers and other devices), and keep the download until `check-github-app` (step 5) has signed with the key in place:

   ```bash
   bun --no-env-file --config=/dev/null scripts/agent-runner/setup.ts install github-app --stdin < ~/Downloads/<app>.<date>.private-key.pem
   ```

   `install` takes GitHub's PKCS#1 key or a PKCS#8 one, strips a BOM, CRLF line ends and trailing spaces, and refuses a key that isn't RSA of 2048 bits or more or can't sign, before anything is written. It writes the new key whole to a file beside the old and renames it over, so a write that fails leaves the old key in place. Whether the key is this App's, only GitHub can say: `check-github-app` (step 5) signs with it.
4. **The fence**, which the first live publish waits on: two rulesets beside `main.json`, recorded in `.github/rulesets/` and applied once each with the maintainer's `gh`, from the main checkout's root:

   ```bash
   gh api -X POST repos/MHarris-SgyMd/OB1/rulesets --input .github/rulesets/main-merge.json
   gh api -X POST repos/MHarris-SgyMd/OB1/rulesets --input .github/rulesets/tags.json
   ```

   * `main-merge.json` restricts updating and deleting `main`, with the Repository admin role (`actor_id` 5, which the owner of this user-owned repo holds) exempt from it (`bypass_mode: "exempt"`). An exempt role is outside the ruleset altogether, where `always` would have the owner merge as a bypass (`gh pr merge --admin`). Rulesets stack, and an exemption or a bypass is per ruleset: `main.json` still binds every merge to "Brain Checks passed" (no one can bypass it), and anyone else, the App included, can't update `main` whatever approvals they hold. Exempt is from GitHub's documentation, not yet tried here: if the POST refuses it, set `"bypass_mode": "always"` in the file and POST again; and if a plain `gh pr merge` then answers that the base branch policy prohibits the merge, merge with `--admin`, which still can't skip `main.json`'s check. An approval rule (SMD-4090) couldn't do this: the App's `pull_requests: write` lets it approve another's PR and merge that, and `main.json` holds `main` to no approval and no bypass actor (check 20).
   * `tags.json` restricts creating, moving and deleting `v*` tags, with the same bypass, so the App can't start `release.yml`. The maintainer's own tag pushes go through as an admin's; `release.yml` creates no tag of its own (`gh release create --verify-tag`).
   * To change either later, edit its file and `PUT` it to `repos/MHarris-SgyMd/OB1/rulesets/<id>`, as MAINTAINING.md does for `main.json`. The id is in the POST's answer, or in `gh api repos/MHarris-SgyMd/OB1/rulesets --jq '.[] | {id, name}'`.
5. `setup.ts check-github-app`; once its App lines pass (the slug and permissions, the installation, its repositories, and the publish's token minted), delete the key's download (`rm ~/Downloads/<app>.<date>.private-key.pem`). It reads the App's slug and permissions, the repositories its installation reaches (read with a metadata-only token for the whole installation, since a token narrowed to one repository lists only that one), the publish's own token minted once, and both rulesets, stacked as GitHub applies them. A ruleset counts as covering `main` or the release tags only by an include it knows (`~DEFAULT_BRANCH`, `refs/heads/main`, `refs/tags/v*` and the like) and no exclude that might reach them; it doesn't try to read GitHub's fnmatch. A repository role short of admin among the bypass actors counts as one that may take in the App. Both tokens are revoked once read; it writes nothing else. GitHub shows a ruleset's bypass list only to a caller with write access to it, so run it with the maintainer's `gh`: a list it couldn't see fails the check rather than passing it.

**What the client defends against, and what it doesn't.** The runner's own user, and what it writes, are trusted: its bare repository, its install and `github-app.pem` sit where only that user writes, and no session can. What the client checks is narrower. The pinned commit, and replace refs and grafts turned off, keep the gate's view and the push the same objects, whatever the branch's ref holds by then; the bundle the agent hands back can carry one ref, imported with every object checked. The config allowlist is read before the runner's first fetch into the bare repository (`ensureBareRepo`) and again just before the push. Hook files are turned off for every runner git call (`LOCAL_GIT`, and `pushCommand`'s own), and the fsmonitor command for the local ones (a bare repository has no worktree for one to watch, and the allowlist refuses the key). Both are defence in depth against a tampered bare repository, not a boundary. git 2.54's config-based hooks (`hook.<name>.*`) aren't turned off by `core.hooksPath`; the allowlist refusing every such key is what keeps them out. A live process running as this user could change the config between a scan and the git call after it, or read the push's environment (`ps eww`) while git runs. Such a process could as well read the key file. The key's custody is what keeps it.

**What the fence leaves open.** Whoever holds the App's key or a live token can do what `contents` and `pull_requests` write allow outside the two rulesets: push to, force-push or delete a branch no ruleset protects (the maintainer's PR branches among them), approve another's PR, and edit or delete a GitHub release and its assets. The runner's code does none of these: it pushes its one `agent/` branch, never forced, and opens one draft PR. The model never holds the key or a token (decision 5), the key is a 0600 file the sessions can't read, and each token is revoked when its step is done. A ruleset restricting updates and deletions on every branch but `agent/**`, with the same admin bypass, would close the branches too; the design doesn't require it.

Its offline self-check (`bun scripts/agent-runner/github-check.ts --self-check`) runs the JWT against a key it makes, the token's checks against a stand-in API, a real `git push` into a local bare repository (one branch, no tag, no hook, a moved branch refused, the token in git's environment alone), and every PR answer. No key, no network.

## How a run reads a session's ending (`run.ts`, SMD-4490)

Claude Code ends a session it could not finish with a result too, so a result alone is not a session that finished. A session finished only if its result is a plain success: subtype `success` with `is_error` false. `sessionEnding` reads anything else by kind, and the run acts on it:

| The session's ending | Worker | Review | Resumed worker |
| --- | --- | --- | --- |
| The API did not answer, before any tool call: no status, 401, 403, 408, 429, 500 and up | environment failure, the label kept | no findings, no resume | the pre-resume branch kept |
| The API refused the request, before any tool call: any other status | work failure | no findings, no resume | the pre-resume branch kept |
| An API error after a tool call | work failure | no findings, no resume | the pre-resume branch kept |
| The turn or budget limit | work failure | no findings, no resume | the pre-resume branch kept |
| Any other result that is not a plain success | work failure | no findings, no resume | the pre-resume branch kept |

A worker's bundle is imported only when it finished. A review that did not finish does not stop the run: the note says so, and the PR body says the branch was not reviewed. The run's record names the kind (`api-error`, `limit`, `error-result`) as the session's ending. A note carries the runner's words, the result's subtype and the API's status, never the result's text.

## Cuts still to come

Cut 2's local run is built: the sessions' profile and its probes (2a, SMD-4088), and the run's local steps on it (2b) — the record, the clone, the brief, the worker and review sessions, the bundle and its import, the gate, and the orchestrator (`run.ts`) that ties them into one run on the record. The orchestrator drives the two sessions through a seam, so its self-check (`run-check.ts`) runs whole runs over a real bare repository with the sessions stubbed, offline and with no key. Driving real sessions end to end needs a model (cut 2c).

* **2c:** the outward steps, over the runner's own keys (SMD-4089): the claim and its release with a reason, and the ticket's moves on Linear. It also covers the brain's identity, CLAUDE.md's amendment for a runner (decision 6), and a first real run with a model.
* **3:** publishing, reconciliation and the launchd schedule, in three PRs — **3a, the publish step (`publish.ts`), is built** (offline); **3b** in three: **3b-1, the App's client (`github.ts`), is built** (offline); **3b-2** the wiring into the live run (after SMD-4573 and SMD-4574, the gate's and the bare repository's fixes); **3b-3** reconcile. **3c** the launchd schedule (SMD-3606 is done). A live publish needs the App (SMD-4089) and its fence (`.github/rulesets/main-merge.json` and `tags.json`).
* **4:** the pilot and its report (SMD-4091).
