# CLAUDE.md — Agent Instructions for Open Brain

This file helps AI coding tools (Claude Code, Codex, Cursor, etc.) work effectively in this repo.

## What This Repo Is

Open Brain is a persistent AI memory system — one database (Postgres + pgvector), one MCP protocol, any AI client. This repo contains the extensions, recipes, schemas, integrations, skills and plugins that the community builds on top of the core Open Brain setup.

**License:** FSL-1.1-MIT. No commercial derivative works. Keep this in mind when generating code or suggesting dependencies.

## Repo Structure

```
extensions/     — Curated, ordered learning path (6 builds). Do NOT add without maintainer approval.
primitives/     — Reusable concept guides (must be referenced by 2+ extensions). Curated.
recipes/        — Standalone capability builds. Open for community contributions.
schemas/        — Database table extensions. Open.
integrations/   — Webhooks, capture sources and clients of the brain. Open. A new surface on the brain is a plugin.
skills/         — Reusable AI client skills and prompt packs. Open.
plugins/        — Operations, tables and GUI pages (rendered by the operator GUI, dashboard/, SMD-2280) added to the brain itself (SMD-2310). Curated: they run inside its servers. A community dashboard is a plugin's pages.
docs/           — Setup guides, FAQ, companion prompts.
resources/      — Official companion files and packaged exports.
```

Every contribution lives in its own subfolder under the right category and must include `README.md` + `metadata.json`.

## Parallel Agent Worktrees

When multiple AI agents or assistant chats work on this repo, do not put them in the same checkout.

### Setup pattern

- Treat the main repo checkout as the canonical repo for pulling, inspection, and creating worktrees.
- Create one Git worktree per active agent, task, or PR-sized workstream.
- Give each worktree a descriptive folder name and a matching branch name.
- Start every agent task by naming the exact absolute worktree path it owns.
- The assigned worktree path is the boundary. The chat is not the boundary.

### Agent assignment template

Start each parallel-agent task with:

```text
Repository worktree:
/ABSOLUTE/PATH/TO/PROJECT-WORKTREE

Branch:
codex/SHORT-TASK-NAME

Task:
DESCRIBE THE EXACT WORK.
```

### Rules

- Do not switch branches in the canonical repo while another agent may be working.
- Do not edit sibling worktrees unless explicitly asked.
- Before staging or committing, run `git status --short` and stage only files that belong to the current task.
- If `main` or another branch changed underneath the worktree, pause before merging or rebasing unless the task explicitly says to finish the PR end to end.
- After a branch is merged and the worktree is clean, release its claims ("Claim your work", step 6), then remove the finished worktree with `git worktree remove /ABSOLUTE/PATH/TO/PROJECT-WORKTREE`.

### Claim your work

Every brain records who holds which work, so two agents never build one change (SMD-3596). This repo's board syncs into the maintainer's **stable** brain, the one sessions capture on. Claim only through a connector named `open-brain` whose `brain_info` says the stable tier: on the maintainer's machine, or reaching its stable brain through a tunnel. Don't print the connector's config to check, since it holds the key. Any other brain is not this repo's claim domain, whatever its `search` finds: a canary, which syncs the same board, and a contributor's own brain included. With one of those, skip the claim steps and say so.

If `open-brain` has no `claim_work` tool, say why:
- the brain's release predates SMD-3598, so neither `list_claims` nor `claim_work` is there;
- the key lacks write scope, so `list_claims` is there but `claim_work` isn't;
- the key is capture-scoped, so only `capture_thought` is there;
- the connector is down, so none of its tools answer; claim (step 2) once it answers again.

1. **Before recommending or starting work,** check the ticket's work, whatever tools you have:
   - **Find its work.** Run `git fetch`, then look at `git worktree list`, the branches carrying the ticket's id, and its open PRs (`gh pr list --search <ticket id> --state open`). If you can't read Linear or GitHub, say so and ask the user before starting. Without `list_claims`, an In Progress ticket with no branch or PR you can see is held all the same, perhaps on another machine: ask.
   - **Check its claims.** Call `list_claims` with `ticket` and `include_ended: true` for each ticket you consider. Without `include_ended` a lapsed claim isn't listed at all. If the reply says `truncated`, call it again with a larger `limit`, up to 1000.
   - **A claim whose id is in your worktree's `.work-claims/`** is yours, or your caller's: carry on (step 4).
   - **A live claim's work is held.** Leave it alone, and name the claim's label, holder and lease end.
   - **A released claim is history.** Pass it over.
   - **A lapsed claim is free only once its work is.** Under this rule a holder lapses after a day without renewing, or a week with its PR open.
     - A lapsed claim that was never released, whose PR hasn't merged or closed, may be work paused on another machine, unpushed. Tell the user before starting.
     - So is an unmerged worktree, branch or open PR for the ticket, with a claim or without one.
     - A lapsed claim whose PR merged or closed is free, even if its branch is still there.
     - Once the user says such work is dead, they release the claim with the operator key and a reason. Or you claim exactly its ticket and piece, which takes the lapsed claim over.
   - **A live claim can be stale.** Find its PR from the branch in its label (`gh pr list --head <branch> --state all`). If that PR merged or closed, or the ticket is Done or Canceled, the claim is stale: tell the user, naming its worktree if one is local. Its holder's next session there releases it, or an operator does.
2. **Before you create the branch,** call `claim_work` with:
   - `ticket`;
   - `piece` for one PR of several, spelled as the ticket's plan names it (`PR 1b-2`) or as `list_claims` already shows it;
   - `lease_seconds: 86400` (a day), so the claim outlasts a night waiting on the user;
   - a `label` naming your tool, machine and branch, such as `codex@laptop codex/smd-1234-short-name`.

   Then create the worktree and branch, keep the token (step 3), and move the ticket to In Progress for people reading Linear. On `WORK_CLAIMED`, read whose claim is in the way:
   - **its id is in your `.work-claims/`:** it is yours. Work under it, or release it and claim the piece. The reply's advice about a lost token is not for you.
   - **your key's, but not in your files:** another session of yours. Stop, and give the user its label from `list_claims`.
   - **another key's:** stop, and tell the user who holds it.

   **When a ticket's work splits into several PRs,** release the whole-ticket claim and delete its token file and any marker beside it (the hook may have just made an `.ended.json` of it). Claim the open PR's piece with `lease_seconds: 604800`, and each later piece when you create its worktree.

   **When you hand work to a subagent in another worktree,** name the claim id in the task: `.work-claims/` is not copied to a new worktree. A subagent works under a claim its caller names, or one in its worktree's files. It doesn't renew or release that claim, and it reports a marker (step 4) to its caller rather than deleting it.
3. **Keep the token** `claim_work` returns in `.work-claims/<claim id>.json` at the new worktree's root, as soon as the worktree exists, and nowhere else. Make the directory first (POSIX shell):

   ```sh
   mkdir -p .work-claims && chmod 700 .work-claims && printf '*\n' > .work-claims/.gitignore
   ```

   Then write the file and `chmod 600` it. `lease_seconds` is the lease you claimed with. `server` is the MCP server you claimed through, and the hook renews only on the brain whose connector it names:

   ```json
   {"id": "<claim id>", "token": "wc_…", "ticket": "SMD-1234", "piece": "PR 2", "lease_seconds": 86400, "server": "open-brain"}
   ```

   The directory's own `.gitignore` keeps it out of git on any branch. Never write the token anywhere else: not a commit, PR, ticket, comment, thought or log. Under your key, it proves the claim to anyone. While it is there, don't run anything that copies or deletes it:
   - `git stash -a`;
   - `git clean -x` or `-X`;
   - `git worktree remove`, with or without `--force`. Git counts an ignored file as clean.
4. **Renew** with `renew_claim`: the id, the token, and `lease_seconds` from the token file, every time. A renewal without it shortens the lease to four hours. Any `claim_work` with your token renews too, so pass the file's lease there as well. Renew at each commit, before each push, after each long test run, and on each resume. Claude Code's session hook also renews from the token file once it has the key (`recipes/session-capture-hook/`, "Renewing work claims"). It is a backstop, and only for a session whose working directory is inside the worktree.
   - **Before any renewal,** look beside the token file. A `<claim id>.ended.json` or `<claim id>.blocked.json` there means don't renew: handle it as below.
   - **On resume, or after a compaction,** read `.work-claims/`. Release a claim whose PR has merged (step 6), and renew the others. To tell: `gh pr view <branch> --json state`; without `gh`, after `git fetch`, the branch has commits and its head is on `origin/main`.
   - **If your claim may have lapsed** (`list_claims` shows it `lapsed`, or you were away longer than its lease), list the ticket's claims with `include_ended: true` before renewing. Another claim made on the ticket since your lease ran out means tell the user first. A renewal revives a lapsed claim without saying it had lapsed (SMD-3654), so this check is yours to make.
   - **A refusal saying the claim was released, or lapsed and was taken over,** means stop work on it and tell the user. So does an `.ended.json`, which the hook leaves when it finds the claim ended. Don't claim the work again without asking, whatever a reply suggests.
   - **`WORK_CLAIMED` on a renewal,** yours or the hook's, means your claim lapsed and another claim now covers its work. The hook's shows as a `<claim id>.blocked.json`. Another agent may have built part of the work since. Stop: finish a local commit in progress, but don't push, open a PR or ask for a merge. Tell the user, and renew again only on their decision:
     - **carry on:** the other claim must end first. Its holder releases it, or the user releases it with the operator key and a reason. Then delete the marker and renew with the file's lease.
     - **drop it:** call `release_claim` on your claim (a lapsed claim can be released), then delete the token file and the marker.
     - **split around it:** follow "When a ticket's work splits" in step 2.

     If the claim in the way has its id in your `.work-claims/`, it is your own piece: release the older claim and delete its files.
5. **When you open the PR, or hand over the command that opens it,** set `"lease_seconds": 604800` (a week) in the token file, then renew with it. The claim then holds while the PR waits for review.
6. **Release** at merge or abandon, before removing the worktree:
   - **Before you ask for the merge,** renew. A refusal saying the claim was taken over means someone else may have built the work: tell the user instead of merging.
   - **After the merge, or the abandon,** call `release_claim` with the id, the token and a `reason` (the merged PR, or why the work was dropped). Then delete the token file and any marker beside it.
   - **If the merge happened after your session ended,** the next session in the worktree releases first (step 4).
7. **If you lose the token,** wait for the lease to lapse and claim the work again: your key takes over its own lapsed claim with a new token. A re-claim of work whose PR is open takes `lease_seconds: 604800`. Or ask the user to release it with an operator key, with a reason.

**Keys.** A claim belongs to its key's agent id: the key that claimed it renews it, and no other. The operator key can force-release any claim, and it belongs to the person, so sessions should hold an agent-kind key.

A default install hands its one key to the coding client, and SETUP.md classifies that key `operator`. A claim's reply shows `holderKind: "operator"` when that is so. **Don't change keys yourself:** tell the user, and point them here. These are their steps, on the machine that runs the brain, from its main checkout:
1. `bun server-portable/keygen.ts --name <a name no key has had> --scope write`. Add the printed line to `MCP_ACCESS_KEYS`, replacing no other line: a name twice keeps the REST core from starting.
2. Restart the stack, so the server reads the new key.
3. `SELECT set_agent_kind('<that name>', 'agent');`
4. Point the connector at the new key, and copy it into the session hook's `claim_key_file`.

Do this only while the key holds no live claims.

### Quick checks

- If another chat suddenly changed branches, both chats were probably in the same working directory.
- If `git worktree add` says a branch is already checked out, create a new branch name or remove the old clean worktree.
- If cleanup fails, inspect `git status --short` and preserve uncommitted work.

## Guard Rails

- **Never modify the core `thoughts` table structure.** Adding columns is fine; altering or dropping existing ones is not. `thoughts` will stay a table under the event-sourcing decision too — its row becomes a projection of `thought_audit` written by the same three functions, a view in its name was measured and declined, and of that decision's three steps two have landed — migration 055 puts the payload in the event, migration 060 has the three write functions append the event first and one projector write the row while a raw write is still trigger-audited (`docs/event-log-as-truth.md`, SMD-1997, SMD-2115, SMD-2116).
- **No credentials, API keys, or secrets in any file.** Use environment variables.
- **No binary blobs** over 1MB. No `.exe`, `.dmg`, `.zip`, `.tar.gz`.
- **A SQL file must never destroy existing rows** — no `DROP TABLE`, `DROP DATABASE`/`DROP SCHEMA`/`DROP OWNED`, `TRUNCATE`, or `DELETE FROM` without a `WHERE` of its own, in any `.sql` file, migrations included. `scripts/check-fork-consistency.ts` check 21 reads every `.sql` for these as statements (comments excepted, string literals read), so a trigger that *refuses* one of them (`BEFORE TRUNCATE ON …`, as `db/migrations/046` does for `thought_audit`) is the rule applied and passes; a scratch table is `CREATE TEMP TABLE … ON COMMIT DROP`.
- **Avoid profanity in all content.** Keep docs, examples, seed data, UI copy, prompts, walkthroughs, and generated assets clean and professional.
- **The brain deploys as the compose stack alone, and every MCP server is one HTTP server reached by URL.** The brain is `deploy/compose.yaml` — the proxy, the REST core, the MCP server at `/mcp`, Postgres and the profiles beside them — brought up as `SETUP.md` says. There is no single-process, container-alone, Workers or Kubernetes deployment of it (SMD-2282's decision 6, SMD-2288), and checks 22b and 22c fail a doc that teaches one. Clients reach it at `https://<host>/mcp` through a TLS proxy or tunnel in front of the stack's proxy (`http://127.0.0.1:8000/mcp` on its own machine), the key as `?key=` on the URL or in an `x-brain-key` header (Claude Desktop: Settings → Connectors → Add custom connector); see `docs/01-getting-started.md` Steps 6 and 7. A vendored extension, recipe or integration server is one HTTP process too, `bun <file>` beside the stack (`primitives/deploy-remote-mcp/`). Never ship a stdio server (`StdioServerTransport`), a `claude_desktop_config.json` entry as the way to run it, or anything a client must spawn; a user's stdio bridge (`mcp-remote`, `supergateway`) in front of that URL is the client's, not the server. A contribution that adds operations to the brain is not a server at all but a plugin (`plugins/<name>/`, SMD-2310): the brain's own servers serve it behind its own keys, its SQL runs as roles that hold nothing on the core, and check 31 guards its code; a plugin runs inside the brain's servers, so it is curated. Decided, not yet built (SMD-3215, `docs/brain-coordinator.md`): a per-brain coordinator and n8n join the stack's default services, every plugin operation, webhook and task becomes an n8n workflow the coordinator runs, carried by a run that holds its caller's identity, and check 31 will read those workflows too.

## PR Standards

- **Title format:** `[category] Short description` (e.g., `[recipes] Email history import via Gmail API`, `[skills] Panning for Gold standalone skill pack`)
- **Branch convention:** `contrib/<github-username>/<short-description>`
- **Commit prefixes:** `[category]` matching the contribution type
- Every PR must pass `.github/workflows/fork-checks.yml` — the suites, the typechecks, `scripts/check-fork-consistency.ts`, commitlint and actionlint — before human review (upstream's `ob1-gate-v2.yml` is not run on this fork)
- See `CONTRIBUTING.md` for the full review process, metadata.json template, and README requirements

## Key Files

- `CONTRIBUTING.md` — Source of truth for contribution rules, metadata format, and the review process
- `.github/workflows/fork-checks.yml` — The fork's CI: every suite, the typechecks, the consistency checker, commitlint, actionlint
- `.github/metadata.schema.json` — JSON schema for metadata.json validation
- `.github/PULL_REQUEST_TEMPLATE.md` — PR description template
- `LICENSE.md` — FSL-1.1-MIT terms

## Local GSD Execution Layer

This repo also has a maintainer-local GSD layer in `.planning/`.

- If `.planning/` exists, use it for local brownfield planning and phased execution.
- Start with `.planning/STATE.md`, then read `.planning/PROJECT.md`, `.planning/ROADMAP.md`, and the relevant `.planning/codebase/*.md` documents.
- Keep `.planning/` local. It is gitignored intentionally and is not part of the public contribution contract or upstream PR scope.
- Public contributor rules still come from `CLAUDE.md`, `AGENTS.md`, `CONTRIBUTING.md`, and the committed repo files.
