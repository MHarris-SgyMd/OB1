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

Every brain records who holds which work, so two agents never build one change (SMD-3596). This repo's board syncs into the maintainer's **stable** brain, the one sessions capture on. Claim there, through the MCP server that reaches it: `open-brain`, at `http://127.0.0.1:8010/mcp`, on the maintainer's machine. A canary is a separate claim domain, so a claim there protects nothing. If your brain isn't that one (its `search` finds no SMD tickets), this repo has no claim domain for you: skip the claim steps and say so.

If the brain has no `claim_work` tool, say which cause it is:
- its release predates SMD-3598;
- your key lacks write scope;
- the connector is down.

Then, in place of step 1, check `git worktree list`, the branches carrying the ticket's id, and its Linear status before recommending or starting it.

1. **Before recommending or starting work,** call `list_claims` with `include_ended: true`: with `ticket` for one ticket, or without it for every claim when choosing among several.
   - Leave a live claim's work alone, and name its label, holder and lease end.
   - A `lapsed` claim that was never released, whose branch or PR still exists, is paused work, not free work. Name it, and ask the user before claiming.
   - `list_claims` stays the check until this line names another, such as SMD-3599's `claimed` label.
2. **Before you create the branch,** call `claim_work` with:
   - `ticket`;
   - `piece` for one PR of several, spelled as the ticket's plan names it (`PR 1b-2`) or as `list_claims` already shows it;
   - a `label` naming your tool, machine and branch, such as `codex@laptop codex/smd-1234-short-name`.

   Then create the branch, and move the ticket to In Progress for people reading Linear. On `WORK_CLAIMED`, read whose claim is in the way:
   - **its id is in your `.work-claims/`:** it is yours. Work under it, or release it and claim the piece.
   - **your key's, but not in your files:** another session of yours. Stop, and give the user its label from `list_claims`.
   - **another key's:** stop, and tell the user who holds it.
3. **Keep the token** `claim_work` returns in `.work-claims/<claim id>.json` at the worktree's root, and nowhere else. Make the directory first:

   ```sh
   mkdir -p .work-claims && chmod 700 .work-claims && printf '*\n' > .work-claims/.gitignore
   ```

   Then write the file and `chmod 600` it. `server` is the MCP server you claimed through:

   ```json
   {"id": "<claim id>", "token": "wc_…", "ticket": "SMD-1234", "piece": "PR 2", "server": "open-brain"}
   ```

   The directory's own `.gitignore` keeps it out of git on any branch. This git-ignored file is the one place the token may be written: never a commit, PR, ticket, comment, thought or log. Under your key, it proves the claim to anyone. Don't run `git stash -a` or `git clean -X` while it is there.
4. **Renew** with `renew_claim` (the id and the token) at each commit, before each push, after each long test run, and on each resume. If two of those are more than about three hours apart, renew in between: the lease is four hours. Claude Code's session hook also renews from the token file once it has the key (`recipes/session-capture-hook/`, "Renewing work claims"), but it is a backstop, so renew yourself.
   - On resume, or after a compaction, read `.work-claims/` and renew each claim in it.
   - A refusal saying the claim was released, or lapsed and was taken over, means stop work on it and tell the user. So does a `<claim id>.ended.json` in `.work-claims/`, which the hook leaves when it finds the claim ended; read its `ended.message`. Don't claim the work again without asking.
   - `WORK_CLAIMED` on a renewal means your claim lapsed and another claim now covers its work: stop while that one holds.
5. **When you open the PR,** renew with `lease_seconds: 604800` (a week), and add `"lease_seconds": 604800` to the token file. The claim then holds while the PR waits for review, and the hook renews it at that lease.
6. **Release** at merge or abandon, before removing the worktree. Call `release_claim` with the id, the token and a `reason` (the merged PR, or why the work was dropped), then delete the token file. If the reply says the claim had already ended because it was taken over, someone else may have built the work: tell the user before merging or deleting anything.
7. **If you lose the token,** wait for the lease to lapse and claim the work again: your key takes over its own lapsed claim with a new token. Or ask an operator for a forced release, with a reason.

**Keys.** A claim belongs to its key's agent id: the key that claimed it renews it, and no other. Give sessions an agent-kind key, set with `SELECT set_agent_kind('<key name>', 'agent');`. The operator key, which can force-release any claim, belongs to the person. Switch a session's key only when it holds no live claims.

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
