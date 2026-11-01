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
- After a branch is merged and the worktree is clean, remove the finished worktree with `git worktree remove /ABSOLUTE/PATH/TO/PROJECT-WORKTREE`.

### Claim your work

Every brain records who holds which work, so two agents never build one change (SMD-3596). This repo's board syncs into the **stable** brain, the one sessions capture on. Claim there, through its MCP server: `open-brain` in this repo's Claude Code setup, `http://127.0.0.1:8010/mcp` on the maintainer's machine. A canary is a separate claim domain, so a claim there protects nothing.

1. **Before recommending or starting work,** call `list_claims`: with `ticket` for one ticket, or with no argument for every live claim when choosing among several. Once SMD-3599 ships, a result's `claimed` label tells you the same. Leave held work alone; name its holder and when its lease ends instead.
2. **When you create the branch,** call `claim_work`:
   - `ticket`;
   - `piece` for one PR of several, such as `PR 2`;
   - a `label` naming your tool, machine and branch, such as `codex@laptop michaelharris/smd-1234-short-name`.

   Then move the ticket to In Progress, for people reading Linear. A `WORK_CLAIMED` refusal means another agent holds the work: stop, and tell the user who.
3. **Keep the token** `claim_work` returns in `.work-claims/<claim id>.json` at the worktree's root, mode 600:

   ```json
   {"id": "<claim id>", "token": "wc_…", "ticket": "SMD-1234", "piece": "PR 2"}
   ```

   The directory is git-ignored. Never put the token in a commit, PR, ticket, comment, thought or log: under your key it proves the claim to anyone.
4. **Renew** with `renew_claim` (the id and the token) about hourly while you work; the lease is four hours. Claude Code's session hook renews from the token file once it has a claim key (`recipes/session-capture-hook/`, "Renewing work claims"). A refusal saying the claim ended, or lapsed and was taken over, means stop work on it.
5. **Release** at merge or abandon: call `release_claim` with the id, the token and a `reason` (the merged PR, or why the work was dropped), then delete the token file. A session that ends with its PR still open keeps its claim.
6. **If you lose the token,** wait for the lease to lapse and claim the work again: your key takes over its own lapsed claim with a new token. Or ask an operator for a forced release, with a reason.

If the brain has no `claim_work` tool, because its release predates SMD-3598, say so and go on without a claim. Give sessions an agent-kind key. The operator key, which can force-release any claim, belongs to the person.

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
